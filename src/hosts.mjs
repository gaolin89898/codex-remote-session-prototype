import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

export async function loadHosts(file = process.env.CODEX_REMOTE_HOSTS_FILE) {
  const config = file ? JSON.parse(await readFile(file, 'utf8')) : {
    hosts: [],
  };
  if (!Array.isArray(config.hosts) || config.hosts.length > 20) {
    throw new Error('Host configuration must contain 0 to 20 hosts');
  }
  const ids = new Set();
  for (const host of config.hosts) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(host.id) || ids.has(host.id)) throw new Error('Invalid or duplicate host ID');
    ids.add(host.id);
    if (!['local', 'ssh'].includes(host.transport)) throw new Error(`Unsupported transport for ${host.id}`);
    if (host.transport === 'ssh' && !/^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]{0,200}$/.test(host.target || '')) {
      throw new Error(`Invalid SSH target for ${host.id}`);
    }
    if (host.allowWrite !== undefined && typeof host.allowWrite !== 'boolean') throw new Error('allowWrite must be a boolean');
    if (host.remote !== undefined && typeof host.remote !== 'boolean') throw new Error('remote must be a boolean');
    if (host.nativeHostId !== undefined && (typeof host.nativeHostId !== 'string' || !/^[a-zA-Z0-9_.:~!*'()%\-]{1,300}$/.test(host.nativeHostId))) {
      throw new Error(`Invalid native host ID for ${host.id}`);
    }
    if ((host.remote === true || host.transport === 'ssh') && host.nativeHostId === 'local') {
      throw new Error(`Remote host ${host.id} cannot use the local native connection`);
    }
  }
  return config.hosts;
}

export async function launchSpec(host, env = process.env) {
  if (host.transport === 'ssh') {
    return {
      command: 'ssh',
      args: ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '--', host.target, 'codex app-server --listen stdio://'],
    };
  }
  const explicit = env.CODEX_REMOTE_CODEX_BIN || env.CODEX_CLI_PATH;
  const npmEntry = env.APPDATA && path.join(env.APPDATA, 'npm/node_modules/@openai/codex/bin/codex.js');
  for (const candidate of [explicit, npmEntry].filter(Boolean)) {
    try { await access(candidate); } catch {
      if (candidate === explicit) throw new Error('Configured Codex binary was not found');
      continue;
    }
    return candidate.endsWith('.js')
      ? { command: process.execPath, args: [candidate, 'app-server', '--listen', 'stdio://'] }
      : { command: candidate, args: ['app-server', '--listen', 'stdio://'] };
  }
  return { command: 'codex', args: ['app-server', '--listen', 'stdio://'] };
}
