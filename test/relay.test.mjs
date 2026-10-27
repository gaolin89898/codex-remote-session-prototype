import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SettingsStore } from '../src/settings.mjs';
import { startRelay } from '../src/relay-server.mjs';
import { connectAgent } from '../src/relay-agent.mjs';
import { RelayConnection } from '../src/relay-connection.mjs';
import { RelayBridge } from '../src/relay-bridge.mjs';

async function setup(t, overrides = {}) {
  const config = { port: 0, controllerToken: 'c'.repeat(32), agents: { pc: { token: 'a'.repeat(32), allowWrite: false } } };
  const relay = await startRelay(config, overrides);
  t.after(() => relay.close());
  return { config, relay, url: `ws://127.0.0.1:${relay.port}/relay` };
}
async function agentFor(t, url, bridge) {
  const agent = await connectAgent({ url, token: 'a'.repeat(32), id: 'pc', name: 'Office PC' }, bridge);
  t.after(() => agent.close());
  return agent;
}
async function clientFor(t, url) {
  const client = new RelayConnection({ url, token: 'c'.repeat(32) });
  t.after(() => client.close());
  await client.start();
  return client;
}

test('relay authenticates both roles and forwards concurrent requests to the computer', async (t) => {
  const { url } = await setup(t);
  const invalid = new RelayConnection({ url, token: 'wrong'.repeat(8) });
  await assert.rejects(invalid.start(), /failed|disconnected/);
  await invalid.close();
  const wrongAgent = new RelayConnection({ url, role: 'agent', token: 'a'.repeat(32), id: 'unregistered', name: 'Wrong identity' });
  await assert.rejects(wrongAgent.start(), /failed|disconnected/);
  await wrongAgent.close();
  await agentFor(t, url, { threads: async (id, cursor) => ({ data: [{ id: cursor || 'thread-1', nativeUrl: 'codex://threads/local' }] }), close: async () => {} });
  const a = await clientFor(t, url), b = await clientFor(t, url);
  assert.equal(a.hosts[0].id, 'pc');
  const results = await Promise.all([a.request('pc', 'threads', { cursor: 'a' }), b.request('pc', 'threads', { cursor: 'b' })]);
  assert.equal(results[0].data[0].id, 'a');
  assert.equal(results[1].data[0].id, 'b');
  await assert.rejects(a.request('pc', 'prompt', { text: 'blocked' }), /read-only/);
  await assert.rejects(a.request('pc', 'constructor'), /Unsupported/);
});

test('relay viewer hides its own computer and replaces agent-provided native links', async (t) => {
  const { url } = await setup(t);
  await agentFor(t, url, { threads: async () => ({ data: [{ id: 'thread-1', nativeUrl: 'codex://threads/local' }] }), close: async () => {} });
  const own = await new RelayBridge({ url, token: 'c'.repeat(32), viewerId: 'pc' }).startConnection();
  const other = await new RelayBridge({ url, token: 'c'.repeat(32), viewerId: 'other' }).startConnection();
  t.after(() => own.close()); t.after(() => other.close());
  assert.deepEqual(own.listHosts(), []);
  await assert.rejects(own.threads('pc'), /hidden/);
  assert.equal(other.listHosts()[0].transport, 'relay');
  assert.equal((await other.threads('pc')).data[0].nativeUrl, null);
});

test('agent device names follow plugin settings without disconnecting or changing identity', async (t) => {
  const { url } = await setup(t);
  const home = await mkdtemp(path.join(tmpdir(), 'relay-device-name-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const settings = new SettingsStore({ CODEX_HOME: home });
  await settings.update({ deviceName: '\u529e\u516c\u7535\u8111' });
  const agent = await connectAgent({ url, token: 'a'.repeat(32), id: 'pc', name: 'Old computer' }, {
    close: async () => {},
  }, { settings, namePollIntervalMs: 20 });
  t.after(() => agent.close());
  const client = await clientFor(t, url);
  assert.equal(client.hosts[0].name, '\u529e\u516c\u7535\u8111');
  const socket = agent.connection.socket;
  const renamed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { client.off('hosts', changed); reject(new Error('Device name did not update')); }, 3000);
    function changed(hosts) {
      if (hosts[0]?.name === '\u5bb6\u91cc\u7684\u7535\u8111') {
        clearTimeout(timer); client.off('hosts', changed); resolve();
      }
    }
    client.on('hosts', changed);
  });
  await settings.update({ deviceName: '\u5bb6\u91cc\u7684\u7535\u8111' });
  await renamed;
  assert.equal(agent.connection.socket, socket);
  assert.equal(agent.connection.connected, true);
  assert.equal(client.hosts[0].id, 'pc');
  assert.equal(client.hosts[0].allowWrite, false);
});

test('agent loss rejects outstanding calls and removes the computer from discovery', async (t) => {
  const { url } = await setup(t);
  const agent = await agentFor(t, url, { threads: () => new Promise(() => {}), close: async () => {} });
  const client = await clientFor(t, url);
  const pending = assert.rejects(client.request('pc', 'threads'), /disconnected/);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await agent.close();
  await pending;
  assert.deepEqual(client.hosts, []);
});

test('relay times out unanswered requests and prevents duplicate agent identity', async (t) => {
  const { url } = await setup(t, { timeoutMs: 60 });
  await agentFor(t, url, { threads: () => new Promise(() => {}), close: async () => {} });
  const duplicate = new RelayConnection({ url, role: 'agent', token: 'a'.repeat(32), id: 'pc', name: 'Duplicate' });
  await assert.rejects(duplicate.start(), /rejected/);
  await duplicate.close();
  const client = await clientFor(t, url);
  await assert.rejects(client.request('pc', 'threads'), /timed out/);
});

test('relay discovery reconnects after a relay restart without needing a conversation request', async (t) => {
  const config = { port: 0, controllerToken: 'c'.repeat(32), agents: { pc: { token: 'a'.repeat(32) } } };
  const first = await startRelay(config);
  const port = first.port;
  const url = `ws://127.0.0.1:${port}/relay`;
  const bridge = await new RelayBridge({ url, token: config.controllerToken, reconnectDelayMs: 30 }).startConnection();
  t.after(() => bridge.close());
  await first.close();
  const replacement = await startRelay({ ...config, port });
  t.after(() => replacement.close());
  await agentFor(t, url, { close: async () => {} });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Relay discovery did not reconnect')), 3000);
    function available(hosts) {
      if (hosts.length) { clearTimeout(timer); bridge.connection.off('hosts', available); resolve(); }
    }
    bridge.connection.on('hosts', available);
    available(bridge.connection.hosts);
  });
  assert.equal(bridge.listHosts()[0].id, 'pc');
});
