import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

export class RelayConnection extends EventEmitter {
  constructor(options) {
    super();
    const url = new URL(options.url);
    if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('Use WSS or a local encrypted tunnel for the relay');
    if (url.username || url.password || url.search || url.hash) throw new Error('Relay credentials must not be in the URL');
    if (typeof options.token !== 'string' || options.token.length < 32) throw new Error('Invalid relay token');
    this.options = options;
    this.pending = new Map();
    this.hosts = [];
  }
  start() {
    if (this.closed) return Promise.reject(new Error('Relay connection is closed'));
    if (this.connected) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = this.connect().finally(() => { this.starting = null; });
    return this.starting;
  }
  connect() {
    return new Promise((resolve, reject) => {
      const socket = this.socket = new WebSocket(this.options.url, {
        headers: { Authorization: `Bearer ${this.options.token}`, 'X-Relay-Role': this.options.role || 'controller',
          ...(this.options.role === 'agent' ? { 'X-Relay-Agent': this.options.id } : {}) },
        handshakeTimeout: 10000, maxPayload: 16 * 1024 * 1024,
      });
      const timer = setTimeout(() => { socket.terminate(); reject(new Error('Relay connection timed out')); }, 10000);
      socket.on('unexpected-response', (_request, response) => {
        clearTimeout(timer);
        const status = response.statusCode;
        reject(new Error(status === 401 || status === 403 ? 'Relay authentication failed' :
          status === 404 ? 'Relay endpoint not found' : 'Relay rejected the connection'));
        socket.terminate();
      });
      socket.on('open', () => {
        if (this.options.role === 'agent') this.send({ type: 'hello', name: this.options.name, allowWrite: this.options.allowWrite === true });
      });
      socket.on('message', (bytes) => {
        let message;
        try { message = JSON.parse(bytes.toString()); } catch { socket.close(1008, 'Invalid JSON'); return; }
        if (message?.type === 'hosts' || message?.type === 'ready') {
          if (message.type === 'hosts') { this.hosts = message.hosts; this.emit('hosts', this.hosts); }
          clearTimeout(timer); this.connected = true; resolve();
        } else if (message?.type === 'response') {
          const request = this.pending.get(message.id);
          if (!request) return;
          clearTimeout(request.timer); this.pending.delete(message.id);
          if (message.error) request.reject(new Error(message.error)); else request.resolve(message.result);
        } else if (message?.type === 'request' && this.options.role === 'agent') {
          this.emit('request', message);
        }
      });
      socket.on('error', () => { clearTimeout(timer); reject(new Error('Relay connection failed')); });
      socket.on('close', () => {
        clearTimeout(timer); this.connected = false;
        reject(new Error('Relay disconnected'));
        for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('Relay disconnected')); }
        this.pending.clear(); this.emit('disconnect');
      });
    });
  }
  async check() {
    await this.start();
    const socket = this.socket;
    const probe = randomUUID();
    await new Promise((resolve, reject) => {
      const finish = (error) => {
        clearTimeout(timer);
        socket.off('pong', pong);
        socket.off('close', disconnected);
        if (error) reject(error); else resolve();
      };
      const pong = (data) => { if (data.toString() === probe) finish(); };
      const disconnected = () => finish(new Error('Relay disconnected'));
      const timer = setTimeout(() => {
        finish(new Error('Relay connection timed out'));
        socket.terminate();
      }, 10000);
      socket.on('pong', pong);
      socket.once('close', disconnected);
      try { socket.ping(probe, (error) => { if (error) finish(new Error('Relay connection failed')); }); }
      catch { finish(new Error('Relay connection failed')); }
    });
  }
  send(message) {
    if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('Relay is unavailable');
    if (this.socket.bufferedAmount > 32 * 1024 * 1024) throw new Error('Relay is congested');
    this.socket.send(JSON.stringify(message));
  }
  async request(agent, method, args = {}) {
    await this.start();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Relay request timed out')); }, this.options.timeoutMs || 35000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ type: 'request', id, agent, method, args }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  async close() {
    this.closed = true;
    if (!this.socket || this.socket.readyState === WebSocket.CLOSED) return;
    await new Promise((resolve) => {
      this.socket.once('close', resolve);
      this.socket.terminate();
    });
  }
}
