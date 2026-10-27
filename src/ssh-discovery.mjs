import { glob, readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import SSHConfig from 'ssh-config';
import { sshAliasPattern } from './native-links.mjs';

export async function discoverSshAliases(home = homedir()) {
  const directory = path.join(home, '.ssh');
  const aliases = new Set();
  const visited = new Set();
  const values = (value) => Array.isArray(value) ? value.map((item) => item.val) : [value];
  async function visit(file, depth = 0) {
    if (depth > 16 || visited.size >= 100) return;
    let resolved;
    try { resolved = await realpath(file); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (visited.has(resolved)) return;
    visited.add(resolved);
    const info = await stat(resolved);
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error('SSH configuration is too large');
    const config = SSHConfig.parse(await readFile(resolved, 'utf8'));
    async function scan(lines) {
      for (const line of lines) {
        if (line.param?.toLowerCase() === 'host') {
          for (const alias of values(line.value)) if (sshAliasPattern.test(alias)) aliases.add(alias);
        }
        if (line.param?.toLowerCase() === 'include') {
          for (let pattern of values(line.value)) {
            if (pattern.startsWith('~/')) pattern = path.join(home, pattern.slice(2));
            if (!path.isAbsolute(pattern)) pattern = path.join(directory, pattern);
            for await (const included of glob(pattern.replaceAll('\\', '/'))) await visit(included, depth + 1);
          }
        }
        if (line.config) await scan(line.config);
      }
    }
    // Parsing only: compute() could execute Match exec directives.
    await scan(config);
  }
  await visit(path.join(directory, 'config'));
  return [...aliases].sort((a, b) => a.localeCompare(b));
}
