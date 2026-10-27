import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SessionBridge } from '../src/bridge.mjs';
import { loadHosts, launchSpec } from '../src/hosts.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

class FakeRpc extends EventEmitter {
  calls = [];
  async start() {}
  async close() { this.emit('disconnect'); }
  async request(method, params) {
    this.calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id: params.threadId, status: { type: this.active ? 'active' : 'idle' } } };
    if (method === 'thread/turns/list') return { data: [], nextCursor: 'older' };
    if (method === 'turn/start') {
      const turn = { id: 'turn-1', status: 'completed' };
      this.emit('notification', { method: 'turn/completed', params: { threadId: params.threadId, turn } });
      return { turn: { ...turn, status: 'inProgress' } };
    }
    return {};
  }
}

function setup(allowWrite = false) {
  const rpc = new FakeRpc();
  const hosts = [{ id: 'local', transport: 'local', allowWrite }];
  return { rpc, bridge: new SessionBridge(hosts, async () => rpc) };
}

test('read-only hosts reject mutations before connecting', async () => {
  const { rpc, bridge } = setup();
  await assert.rejects(bridge.prompt('local', 'thread-1', 'hello'), /read-only/);
  await assert.rejects(bridge.start('local', '/project'), /read-only/);
  await assert.rejects(bridge.interrupt('local', 'thread-1', 'turn-1'), /read-only/);
  assert.equal(rpc.calls.length, 0);
});

test('concurrent reads share a single connection and preserve pagination', async () => {
  const rpc = new FakeRpc();
  let launches = 0;
  const bridge = new SessionBridge([{ id: 'local', transport: 'local' }], async () => { launches++; return rpc; });
  await Promise.all([bridge.connection('local'), bridge.connection('local')]);
  assert.equal(launches, 1);
  const result = await bridge.read('local', 'thread-1', 'older-page');
  assert.equal(result.turns.nextCursor, 'older');
  assert.deepEqual(rpc.calls[1], { method: 'thread/turns/list', params: {
    threadId: 'thread-1', cursor: 'older-page', limit: 10, itemsView: 'full', sortDirection: 'desc',
  } });
});

test('an active conversation is rejected before resume or turn/start', async () => {
  const { rpc, bridge } = setup(true);
  rpc.active = true;
  await assert.rejects(bridge.prompt('local', 'thread-1', 'hello'), /active/);
  assert.deepEqual(rpc.calls.map((x) => x.method), ['thread/read']);
});

test('a completion notification arriving before the turn response is retained', async () => {
  const { rpc, bridge } = setup(true);
  await bridge.prompt('local', 'thread-1', 'hello');
  assert.equal(bridge.status('local', 'thread-1').status, 'completed');
  assert.equal(rpc.calls.find((x) => x.method === 'thread/resume').params.sandbox, 'read-only');
});

test('connection loss is reported without claiming a turn completed', async () => {
  const { rpc, bridge } = setup();
  await bridge.connection('local');
  rpc.emit('notification', { method: 'turn/started', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'inProgress' } } });
  rpc.emit('disconnect');
  assert.equal(bridge.status('local', 'thread-1').status, 'connectionLost');
  assert.equal(bridge.listHosts()[0].connected, false);
});

test('SSH uses fixed arguments and a validated alias', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-remote-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'hosts.json');
  await writeFile(file, JSON.stringify({ hosts: [{ id: 'remote', transport: 'ssh', target: '-oProxyCommand=bad' }] }));
  await assert.rejects(loadHosts(file), /Invalid SSH/);
  const launch = await launchSpec({ transport: 'ssh', target: 'devbox' });
  assert.equal(launch.command, 'ssh');
  assert.deepEqual(launch.args.slice(-3), ['--', 'devbox', 'codex app-server --listen stdio://']);
});

test('remote backend configuration is exposed without using the local native connection', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'codex-remote-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'hosts.json');
  const host = { id: 'server', transport: 'local', remote: true };
  await writeFile(file, JSON.stringify({ hosts: [host] }));
  const bridge = new SessionBridge(await loadHosts(file));
  assert.equal(bridge.listHosts()[0].remote, true);
  assert.equal(bridge.listHosts()[0].nativeHostId, null);
  await writeFile(file, JSON.stringify({ hosts: [{ ...host, nativeHostId: 'local' }] }));
  await assert.rejects(loadHosts(file), /local native connection/);
  await writeFile(file, JSON.stringify({ hosts: [{ ...host, remote: 'yes' }] }));
  await assert.rejects(loadHosts(file), /remote must be a boolean/);
});
