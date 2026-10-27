import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { testConnection } from '../src/connection-test.mjs';
import { RelayConnection } from '../src/relay-connection.mjs';

test('connection diagnostics show the reason without exposing raw error details', async () => {
  for (const [message, expected] of [
    ['Relay authentication failed', /\u4ee4\u724c\u9a8c\u8bc1\u5931\u8d25/],
    ['Relay connection timed out', /\u8fde\u63a5\u8d85\u65f6/],
    ['Relay endpoint not found', /\u5730\u5740\u4e0d\u5b58\u5728/],
    ['Relay connection failed', /\u65e0\u6cd5\u8fde\u63a5\u4e2d\u7ee7/],
    ['Codex app-server exited (255)', /\u514d\u5bc6\u767b\u5f55/],
    ['unexpected upstream payload', /\u68c0\u67e5\u5df2\u4fdd\u5b58/],
  ]) {
    const secret = 'synthetic-private-credential';
    const result = await testConnection({ call: async () => { throw new Error(`${message}: ${secret}`); } });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.connected, false);
    assert.match(result.content[0].text, expected);
    assert.equal(JSON.stringify(result).includes(secret), false);
  }
});

test('relay checks require a fresh pong and release listeners after every test', async (t) => {
  const sockets = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  t.after(() => new Promise((resolve) => sockets.close(resolve)));
  await new Promise((resolve) => sockets.once('listening', resolve));
  let pingCount = 0;
  sockets.on('connection', (socket) => {
    socket.send(JSON.stringify({ type: 'hosts', hosts: [] }));
    socket.on('ping', () => { pingCount++; });
  });
  const connection = new RelayConnection({ url: `ws://127.0.0.1:${sockets.address().port}`, token: 'c'.repeat(32) });
  t.after(() => connection.close());
  await connection.start();
  const closeListeners = connection.socket.listenerCount('close');
  await connection.check();
  await connection.check();
  assert.equal(pingCount, 2);
  assert.equal(connection.socket.listenerCount('pong'), 0);
  assert.equal(connection.socket.listenerCount('close'), closeListeners);
  await connection.close();
});

test('relay handshake reports authentication and wrong-path failures without leaking the HTTP body', async (t) => {
  const server = createServer();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  server.on('upgrade', (request, socket) => {
    socket.end(`HTTP/1.1 ${request.url === '/missing' ? '404 Not Found' : '401 Unauthorized'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  });
  for (const [endpoint, reason] of [['missing', /endpoint not found/], ['relay', /authentication failed/]]) {
    const connection = new RelayConnection({ url: `ws://127.0.0.1:${server.address().port}/${endpoint}`, token: 'c'.repeat(32) });
    try { await assert.rejects(connection.check(), reason); }
    finally { await connection.close(); }
  }
});

test('an unresponsive relay times out and releases the stale socket for reconnection', async (t) => {
  const sockets = new WebSocketServer({ port: 0, host: '127.0.0.1', autoPong: false });
  t.after(() => new Promise((resolve) => sockets.close(resolve)));
  await new Promise((resolve) => sockets.once('listening', resolve));
  sockets.on('connection', (socket) => socket.send(JSON.stringify({ type: 'hosts', hosts: [] })));
  const connection = new RelayConnection({ url: `ws://127.0.0.1:${sockets.address().port}`, token: 'c'.repeat(32) });
  t.after(() => connection.close());
  await connection.start();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const checking = assert.rejects(connection.check(), /timed out/);
  await Promise.resolve();
  t.mock.timers.tick(10000);
  await checking;
  t.mock.timers.reset();
  await connection.close();
  assert.equal(connection.connected, false);
  assert.equal(connection.socket.listenerCount('pong'), 0);
});
