import { readFile } from 'node:fs/promises';
import { RelayConnection } from './relay-connection.mjs';
import { nativeThreadUrl } from './native-links.mjs';

export class RelayBridge {
  constructor(config) {
    this.config = config;
    this.connection = new RelayConnection(config);
    this.retries = 0;
    this.connection.on('disconnect', () => this.reconnect());
    this.connection.on('hosts', () => { this.retries = 0; });
  }
  reconnect() {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connection.start().catch(() => this.reconnect());
    }, Math.min(30000, (this.config.reconnectDelayMs || 1000) * 2 ** Math.min(this.retries++, 5)));
  }
  async startConnection() { await this.connection.start(); return this; }
  listHosts() {
    return this.connection.hosts.filter((host) => host.id !== this.config.viewerId).map((host) => ({
      ...host, transport: 'relay', remote: true, nativeHostId: this.config.nativeHosts?.[host.id] || null,
      connected: this.connection.connected && host.connected,
    }));
  }
  host(id) {
    const host = this.listHosts().find((item) => item.id === id);
    if (!host) throw new Error('Unknown or hidden computer');
    return host;
  }
  async request(id, method, args) {
    await this.connection.start();
    this.host(id);
    return this.connection.request(id, method, args);
  }
  async threads(id, cursor = null, search = null) {
    const result = await this.request(id, 'threads', { cursor, search });
    return { ...result, data: result.data.map((thread) => ({ ...thread, nativeUrl: nativeThreadUrl(this.host(id), thread.id) })) };
  }
  read(id, threadId, cursor = null) { return this.request(id, 'read', { threadId, cursor }); }
  start(id, cwd) { return this.request(id, 'start', { cwd }); }
  prompt(id, threadId, text) { return this.request(id, 'prompt', { threadId, text }); }
  status(id, threadId) { return this.request(id, 'status', { threadId }); }
  interrupt(id, threadId, turnId) { return this.request(id, 'interrupt', { threadId, turnId }); }
  close() {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    return this.connection.close();
  }
}

export async function loadRelayBridge(file) {
  const config = JSON.parse(await readFile(file, 'utf8'));
  if (Object.values(config.nativeHosts || {}).some((id) => id === 'local' || typeof id !== 'string' || !/^[a-zA-Z0-9_.:~!*'()%\-]{1,300}$/.test(id))) throw new Error('Relay native mappings must refer to remote desktop connections');
  return new RelayBridge(config).startConnection();
}
