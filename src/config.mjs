import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export async function connectionConfig(env = process.env) {
  if (env.CODEX_REMOTE_HOSTS_FILE && env.CODEX_REMOTE_RELAY_FILE) {
    throw new Error('Choose either CODEX_REMOTE_HOSTS_FILE or CODEX_REMOTE_RELAY_FILE');
  }
  if (env.CODEX_REMOTE_RELAY_FILE) return { relay: env.CODEX_REMOTE_RELAY_FILE };
  if (env.CODEX_REMOTE_HOSTS_FILE) return { hosts: env.CODEX_REMOTE_HOSTS_FILE };
  const directory = path.join(env.CODEX_HOME || path.join(homedir(), '.codex'), 'remote-session');
  const files = {};
  for (const [kind, name] of [['hosts', 'hosts.json'], ['relay', 'relay.json']]) {
    const file = path.join(directory, name);
    try { await access(file); files[kind] = file; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (files.hosts && files.relay) throw new Error('Keep either hosts.json or relay.json in the remote-session configuration directory');
  return files;
}
