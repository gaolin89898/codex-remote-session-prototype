import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';

const methods = new Set(['threads', 'read', 'start', 'prompt', 'status', 'interrupt']);
const mutations = new Set(['start', 'prompt', 'interrupt']);
function matches(value, expected) {
  if (typeof value !== 'string' || typeof expected !== 'string') return false;
  const a = Buffer.from(value), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
function validName(value) {
  return typeof value === 'string' && value.trim() && value.length <= 120 && !/[\x00-\x1f\x7f]/.test(value);
}

export async function startRelay(config, options = {}) {
  if (typeof config.controllerToken !== 'string' || config.controllerToken.length < 32) throw new Error('A controller token of at least 32 characters is required');
  for (const [id, agent] of Object.entries(config.agents || {})) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id) || typeof agent.token !== 'string' || agent.token.length < 32) throw new Error('Invalid agent credentials');
  }
  const agents = new Map(), controllers = new Set(), pending = new Map();
  const server = http.createServer((req, res) => {
    res.writeHead(req.url === '/health' ? 200 : 404, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(req.url === '/health' ? { service: 'codex-session-relay', agents: agents.size } : { error: 'Not found' }));
  });
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  function send(socket, data) {
    if (socket.readyState !== WebSocket.OPEN) return false;
    if (socket.bufferedAmount > 32 * 1024 * 1024) { socket.terminate(); return false; }
    socket.send(JSON.stringify(data));
    return true;
  }
  function inventory() {
    return [...agents.entries()].filter(([, agent]) => agent.ready).map(([id, agent]) => ({
      id, name: agent.name, allowWrite: agent.allowWrite, connected: true,
    }));
  }
  function broadcast() {
    for (const controller of controllers) send(controller, { type: 'hosts', hosts: inventory() });
  }
  function finish(id, error, result) {
    const request = pending.get(id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(id);
    send(request.controller, { type: 'response', id: request.id, ...(error ? { error } : { result }) });
  }
  server.on('upgrade', (req, socket, head) => {
    const role = req.headers['x-relay-role'], id = req.headers['x-relay-agent'];
    const bearer = req.headers.authorization?.replace(/^Bearer /, '');
    const authorized = req.url === '/relay' && (
      role === 'controller' && matches(bearer, config.controllerToken) ||
      role === 'agent' && typeof id === 'string' && Object.hasOwn(config.agents || {}, id) && matches(bearer, config.agents[id].token)
    );
    if (!authorized || role === 'agent' && agents.has(id)) {
      socket.end(`HTTP/1.1 ${authorized ? '409 Conflict' : '401 Unauthorized'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('error', () => {});
      if (role === 'agent') agents.set(id, { socket: ws, ready: false });
      else { controllers.add(ws); send(ws, { type: 'hosts', hosts: inventory() }); }
      ws.on('message', (bytes) => {
        let message;
        try { message = JSON.parse(bytes.toString()); } catch { ws.close(1008, 'Invalid JSON'); return; }
        if (!message || typeof message !== 'object') { ws.close(1008, 'Invalid message'); return; }
        if (role === 'agent') {
          const agent = agents.get(id);
          if (message.type === 'hello' && !agent.ready) {
            if (!validName(message.name)) { ws.close(1008, 'Invalid name'); return; }
            Object.assign(agent, { ready: true, name: message.name, allowWrite: config.agents[id].allowWrite === true && message.allowWrite === true });
            send(ws, { type: 'ready' });
            broadcast();
          } else if (message.type === 'rename' && agent.ready) {
            if (!validName(message.name)) { ws.close(1008, 'Invalid name'); return; }
            agent.name = message.name;
            broadcast();
          } else if (message.type === 'response') {
            const request = pending.get(message.id);
            if (request?.agent === ws) finish(message.id, message.error ? String(message.error).slice(0, 1000) : null, message.result);
          }
          return;
        }
        if (message.type !== 'request' || typeof message.id !== 'string' || message.id.length > 64) { ws.close(1008, 'Invalid request'); return; }
        const reject = (error) => send(ws, { type: 'response', id: message.id, error });
        if (!methods.has(message.method)) { reject('Unsupported relay method'); return; }
        const agent = agents.get(message.agent);
        if (!agent?.ready) { reject('Computer is offline'); return; }
        if (mutations.has(message.method) && !agent.allowWrite) { reject('Computer is read-only'); return; }
        if (pending.size >= 256 || [...pending.values()].filter((request) => request.controller === ws).length >= 32) { reject('Too many pending requests'); return; }
        const routeId = randomUUID();
        pending.set(routeId, { controller: ws, agent: agent.socket, id: message.id,
          timer: setTimeout(() => finish(routeId, 'Relay request timed out'), options.timeoutMs || 30000) });
        if (!send(agent.socket, { type: 'request', id: routeId, method: message.method, args: message.args || {} })) finish(routeId, 'Computer disconnected');
      });
      ws.on('close', () => {
        controllers.delete(ws);
        if (role === 'agent' && agents.get(id)?.socket === ws) { agents.delete(id); broadcast(); }
        for (const [routeId, request] of pending) {
          if (request.agent === ws) finish(routeId, 'Computer disconnected');
          else if (request.controller === ws) { clearTimeout(request.timer); pending.delete(routeId); }
        }
      });
    });
  });
  const heartbeat = setInterval(() => {
    for (const socket of sockets.clients) {
      if (!socket.isAlive) socket.terminate();
      else { socket.isAlive = false; socket.ping(); }
    }
  }, 30000);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port ?? 3420, '127.0.0.1', resolve);
  });
  return {
    port: server.address().port,
    async close() {
      clearInterval(heartbeat);
      for (const request of pending.values()) clearTimeout(request.timer);
      pending.clear();
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
