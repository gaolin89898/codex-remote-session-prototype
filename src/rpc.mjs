import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';

export class AppServerRpc extends EventEmitter {
  constructor(command, args = [], options = {}) {
    super();
    this.command = command;
    this.args = args;
    this.options = options;
    this.pending = new Map();
    this.nextId = 0;
    this.closed = false;
  }

  async start() {
    if (this.starting) return this.starting;
    this.starting = this.initialize();
    return this.starting;
  }

  async initialize() {
    if (this.closed) throw new Error('Connection is closed');
    this.child = spawn(this.command, this.args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.options.cwd,
      env: this.options.env || process.env,
    });
    this.child.stderr.resume();
    this.child.stdin.on('error', (error) => this.fail(error));
    this.child.once('error', (error) => this.fail(error));
    this.child.once('exit', (code, signal) => {
      this.fail(new Error(`Codex app-server exited (${signal || code})`));
    });
    this.reader = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    this.reader.on('line', (line) => this.receive(line));
    this.info = await this.request('initialize', {
      clientInfo: { name: 'codex_remote_session_lab', title: 'Remote Session Lab', version: '0.1.0' },
    });
    this.write({ method: 'initialized', params: {} });
    return this.info;
  }

  receive(line) {
    if (!line.trim() || this.closed) return;
    let message;
    try {
      if (line.length > 16 * 1024 * 1024) throw new Error('App-server response is too large');
      message = JSON.parse(line);
    } catch {
      this.fail(new Error('Invalid JSON from Codex app-server'));
      this.child?.kill();
      return;
    }
    if (message.method && message.id !== undefined) {
      // Permission decisions remain with the host owner; this prototype cannot approve them.
      if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(message.method)) {
        this.write({ id: message.id, result: { decision: 'decline' } });
      } else {
        this.write({ id: message.id, error: { code: -32601, message: 'Interactive requests are unsupported by this prototype' } });
      }
      this.emit('notification', { method: 'bridge/interactiveRequestDeclined', params: { requestMethod: message.method, threadId: message.params?.threadId } });
      return;
    }
    if (message.method) {
      this.emit('notification', message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      const error = new Error(message.error.message || 'App-server request failed');
      error.code = message.error.code;
      pending.reject(error);
    } else {
      pending.resolve(message.result);
    }
  }

  write(message) {
    if (this.closed || !this.child?.stdin.writable) throw new Error('Codex connection is unavailable');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('Connection is closed'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, this.options.timeoutMs || 30000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  fail(error) {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit('disconnect', error.message);
  }

  async close() {
    this.fail(new Error('Connection closed'));
    this.reader?.close();
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 1500);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
      child.stdin.end();
    });
  }
}
