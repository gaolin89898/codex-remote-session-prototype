import { AppServerRpc } from './rpc.mjs';
import { launchSpec } from './hosts.mjs';
import { nativeHostIdFor, nativeThreadUrl } from './native-links.mjs';

export class SessionBridge {
  constructor(hosts, factory) {
    this.hosts = hosts;
    this.factory = factory || (async (host) => {
      const { command, args } = await launchSpec(host);
      return new AppServerRpc(command, args);
    });
    this.connections = new Map();
    this.connecting = new Map();
    this.turns = new Map();
    this.busy = new Set();
  }

  host(id) {
    const host = this.hosts.find((item) => item.id === id);
    if (!host) throw new Error(`Unknown host: ${id}`);
    return host;
  }

  listHosts() {
    return this.hosts.map((host) => {
      const { id, name, transport, allowWrite } = host;
      return {
        id, name: name || id, transport, allowWrite: allowWrite === true,
        remote: host.remote === true || transport === 'ssh',
        nativeHostId: nativeHostIdFor(host),
        connected: this.connections.has(id),
      };
    });
  }

  async connection(id) {
    const host = this.host(id);
    if (this.connections.has(id)) return this.connections.get(id);
    if (this.connecting.has(id)) return this.connecting.get(id);
    const promise = (async () => {
      const rpc = await this.factory(host);
      rpc.on('notification', (message) => this.notification(id, message));
      rpc.on('disconnect', () => {
        this.connections.delete(id);
        for (const [key, state] of this.turns) {
          if (key.startsWith(`${id}:`) && state.status === 'inProgress') {
            this.turns.set(key, { ...state, status: 'connectionLost' });
          }
        }
      });
      try { await rpc.start(); } catch (error) { await rpc.close(); throw error; }
      this.connections.set(id, rpc);
      return rpc;
    })();
    this.connecting.set(id, promise);
    try { return await promise; } finally { this.connecting.delete(id); }
  }

  notification(hostId, message) {
    const { method, params = {} } = message;
    if (!params.threadId) return;
    const key = `${hostId}:${params.threadId}`;
    const existing = this.turns.get(key) || {};
    if (method === 'turn/started' || method === 'turn/completed') {
      this.turns.set(key, { ...existing, turnId: params.turn.id, status: params.turn.status, error: params.turn.error || null });
    } else if (method === 'bridge/interactiveRequestDeclined') {
      this.turns.set(key, { ...existing, declinedRequest: params.requestMethod });
    }
    if (this.turns.size > 200) {
      for (const [oldKey, state] of this.turns) {
        if (state.status !== 'inProgress') { this.turns.delete(oldKey); break; }
      }
    }
  }

  writable(id) {
    if (this.host(id).allowWrite !== true) throw new Error(`Host ${id} is read-only; enable allowWrite in its configuration`);
  }

  async threads(hostId, cursor = null, search = null) {
    const rpc = await this.connection(hostId);
    const result = await rpc.request('thread/list', { limit: 30, cursor, searchTerm: search });
    return { ...result, data: result.data.map((thread) => ({ ...thread, nativeUrl: nativeThreadUrl(this.host(hostId), thread.id) })) };
  }

  async read(hostId, threadId, cursor = null) {
    const rpc = await this.connection(hostId);
    const metadata = await rpc.request('thread/read', { threadId, includeTurns: false });
    const turns = await rpc.request('thread/turns/list', { threadId, cursor, limit: 10, itemsView: 'full', sortDirection: 'desc' });
    return { thread: metadata.thread, turns };
  }

  async start(hostId, cwd) {
    this.writable(hostId);
    const rpc = await this.connection(hostId);
    return rpc.request('thread/start', { cwd, sandbox: 'read-only', approvalPolicy: 'on-request' });
  }

  async prompt(hostId, threadId, text) {
    this.writable(hostId);
    const key = `${hostId}:${threadId}`;
    if (this.busy.has(key) || this.turns.get(key)?.status === 'inProgress') throw new Error('Conversation already has an active turn');
    this.busy.add(key);
    try {
      const rpc = await this.connection(hostId);
      const current = await rpc.request('thread/read', { threadId, includeTurns: false });
      if (current.thread?.status?.type === 'active') throw new Error('Conversation is active; use its owning client');
      await rpc.request('thread/resume', { threadId, excludeTurns: true, sandbox: 'read-only', approvalPolicy: 'on-request' });
      const result = await rpc.request('turn/start', { threadId, input: [{ type: 'text', text }] });
      const prior = this.turns.get(key);
      if (prior?.turnId !== result.turn.id || prior?.status === 'inProgress') {
        this.turns.set(key, { turnId: result.turn.id, status: result.turn.status });
      }
      return result;
    } finally {
      this.busy.delete(key);
    }
  }

  status(hostId, threadId) {
    this.host(hostId);
    return this.turns.get(`${hostId}:${threadId}`) || { status: 'unknown', message: 'No turn observed by this bridge; read the conversation for persisted results' };
  }

  async interrupt(hostId, threadId, turnId) {
    this.writable(hostId);
    return (await this.connection(hostId)).request('turn/interrupt', { threadId, turnId });
  }

  async close() {
    await Promise.allSettled(this.connecting.values());
    await Promise.allSettled([...this.connections.values()].map((rpc) => rpc.close()));
    this.connections.clear();
  }
}
