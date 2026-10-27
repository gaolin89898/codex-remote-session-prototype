import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SettingsStore } from '../src/settings.mjs';
import { ConfiguredBridge } from '../src/configured-bridge.mjs';
import { startRelay } from '../src/relay-server.mjs';

async function storeFor(t) {
  const home = await mkdtemp(path.join(tmpdir(), 'remote-settings-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  return new SettingsStore({ CODEX_HOME: home });
}

test('settings persist partial updates atomically and never return saved tokens', async (t) => {
  const store = await storeFor(t);
  assert.deepEqual(await store.connection(), { hosts: [] });
  const token = 'synthetic-controller-token-'.repeat(2);
  const saved = await store.update({ relayUrl: 'ws://127.0.0.1:3420/relay', relayToken: token });
  assert.equal(saved.relayToken, '');
  assert.equal((await store.read()).relayToken, '');
  await Promise.all([store.update({ viewerId: 'viewer' }), store.update({ allowWrite: true })]);
  const values = await store.update({ mode: '\u670d\u52a1\u4e2d\u7ee7', relayToken: '' });
  assert.equal(values.viewerId, 'viewer');
  assert.equal(values.allowWrite, true);
  assert.equal((await store.connection()).relay.token, token);
  const before = await readFile(store.file, 'utf8');
  await assert.rejects(store.update({ relayUrl: 'ws://example.com/relay' }), /WSS/);
  await assert.rejects(store.update({ sshTargets: '-oProxyCommand=invalid' }), /SSH/);
  assert.equal(await readFile(store.file, 'utf8'), before);
  assert.deepEqual(await readdir(store.directory), ['settings.json']);
  await store.reset();
  assert.deepEqual(await store.connection(), { hosts: [] });
  assert.equal((await readFile(store.file, 'utf8')).includes(token), false);
});

test('SSH settings keep stable computer IDs and apply without restarting the plugin', async (t) => {
  const store = await storeFor(t);
  let closed = 0;
  const bridge = new ConfiguredBridge(store, { direct: (hosts) => ({
    listHosts: () => hosts,
    close: async () => { closed++; },
    connection: async () => ({ request: async () => ({ data: [] }) }),
  }) });
  t.after(() => bridge.close());
  assert.deepEqual(await bridge.call('listHosts'), []);
  await assert.rejects(bridge.call('testConnection'), /settings/);
  await store.update({ mode: 'SSH \u76f4\u8fde', sshTargets: 'office, home, office' });
  const hosts = await bridge.call('listHosts');
  assert.equal(hosts.length, 2);
  assert.equal(hosts[0].allowWrite, false);
  await store.update({ sshTargets: 'home, office', allowWrite: true });
  const changed = await bridge.call('listHosts');
  assert.equal(changed[1].id, hosts[0].id);
  assert.equal(changed[0].allowWrite, true);
  assert.deepEqual(await bridge.call('testConnection'), { connected: true, computers: 2 });
  assert.equal(closed, 2);
  await store.reset();
  assert.deepEqual(await bridge.call('listHosts'), []);
});

test('device names preserve older settings, support Unicode, and default to the computer name', async (t) => {
  const store = await storeFor(t);
  const token = 'legacy-controller-token-'.repeat(2);
  await store.update({ relayToken: token, viewerId: 'viewer' });
  const legacy = JSON.parse(await readFile(store.file, 'utf8'));
  delete legacy.deviceName;
  await writeFile(store.file, JSON.stringify(legacy));
  assert.equal((await store.read()).deviceName, hostname());
  assert.equal((await store.load()).relayToken, token);
  const renamed = await store.update({ deviceName: '  \u529e\u516c\u7535\u8111  ' });
  assert.equal(renamed.deviceName, '\u529e\u516c\u7535\u8111');
  await store.update({ allowWrite: true });
  assert.equal((await store.read()).deviceName, '\u529e\u516c\u7535\u8111');
  assert.equal((await store.load()).viewerId, 'viewer');
  await assert.rejects(store.update({ deviceName: 'x'.repeat(121) }));
  await assert.rejects(store.update({ deviceName: 'invalid\u0000name' }));
  await store.update({ deviceName: '  ' });
  assert.equal((await store.read()).deviceName, hostname());
});

test('empty drafts can be saved before choosing a connection and launcher overrides are preserved', async (t) => {
  const store = await storeFor(t);
  await store.update({ mode: 'SSH \u76f4\u8fde' });
  await assert.rejects(store.connection(), /Enter an SSH/);
  const overridden = new SettingsStore({ ...store.env, CODEX_REMOTE_HOSTS_FILE: path.join(store.directory, 'custom.json') });
  assert.equal((await overridden.read()).configFile, path.join(store.directory, 'custom.json'));
  await assert.rejects(overridden.update({ mode: '\u672a\u8fde\u63a5' }), /override/);
  await assert.rejects(overridden.reset(), /override/);
});

test('a settings change waits for the current request before closing its connection', async (t) => {
  const store = await storeFor(t);
  let release, entered, closed = false;
  const started = new Promise((resolve) => { entered = resolve; });
  const bridge = new ConfiguredBridge(store, { direct: () => ({
    threads: () => { entered(); return new Promise((resolve) => { release = resolve; }); },
    close: async () => { closed = true; },
  }) });
  t.after(() => bridge.close());
  const reading = bridge.call('threads', 'synthetic');
  await started;
  const invalidated = bridge.invalidate();
  assert.equal(closed, false);
  release({ data: [] });
  await Promise.all([reading, invalidated]);
  assert.equal(closed, true);
});

test('a pending read does not block other operations on the same connection', async (t) => {
  const store = await storeFor(t);
  let release, entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const bridge = new ConfiguredBridge(store, { direct: () => ({
    threads: () => { entered(); return new Promise((resolve) => { release = resolve; }); },
    listHosts: () => [], close: async () => {},
  }) });
  t.after(() => bridge.close());
  const reading = bridge.call('threads', 'synthetic');
  await started;
  let timer;
  try {
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Independent request was blocked')), 2000); });
    assert.deepEqual(await Promise.race([bridge.call('listHosts'), timeout]), []);
  } finally { clearTimeout(timer); release({ data: [] }); await reading; }
});

for (const entry of ['../src/mcp.mjs', '../dist/plugin/server.mjs']) {
  test(`native settings discovery, editing, token redaction, and reset: ${entry}`, async (t) => {
    const store = await storeFor(t);
    const env = { ...process.env, ...store.env };
    delete env.CODEX_REMOTE_HOSTS_FILE;
    delete env.CODEX_REMOTE_RELAY_FILE;
    const client = new Client({ name: 'native-settings-test', version: '1.0.0' });
    t.after(() => client.close());
    await client.connect(new StdioClientTransport({
      command: process.execPath, args: [fileURLToPath(new URL(entry, import.meta.url))], env, stderr: 'pipe',
    }));
    const capability = client.getServerCapabilities().experimental['openai/settings'];
    assert.deepEqual(capability, { readTool: 'remote_settings_read', updateTool: 'remote_settings_update' });
    const read = await client.callTool({ name: capability.readTool, arguments: {} });
    assert.equal(read.structuredContent.values.mode, '\u672a\u8fde\u63a5');
    assert.equal(read.structuredContent.values.deviceName, hostname());
    assert.ok(read.structuredContent.layout.some((group) => group.items.some((item) => item.property === 'deviceName')));
    assert.ok(read.structuredContent.layout.some((group) => group.items.some((item) => item.tool === 'remote_test_connection')));
    const nativeTools = (await client.listTools()).tools.filter((tool) => /remote_(settings|test_connection)/.test(tool.name));
    assert.equal(nativeTools.length, 4);
    assert.ok(nativeTools.every((tool) => tool._meta.ui.visibility.join() === 'app'));
    const unconfigured = await client.callTool({ name: 'remote_test_connection', arguments: {} });
    assert.equal(unconfigured.isError, true);
    const token = 'native-settings-test-token-'.repeat(2);
    const updated = await client.callTool({ name: capability.updateTool, arguments: { set: {
      mode: 'SSH \u76f4\u8fde', sshTargets: 'office', relayToken: token, deviceName: '\u529e\u516c\u7535\u8111',
    } } });
    assert.equal(updated.isError, undefined);
    assert.equal(JSON.stringify(updated).includes(token), false);
    const hosts = await client.callTool({ name: 'remote_hosts', arguments: {} });
    assert.equal(JSON.parse(hosts.content[0].text).hosts[0].name, 'office');
    const reloaded = await client.callTool({ name: capability.readTool, arguments: {} });
    assert.equal(reloaded.structuredContent.values.deviceName, '\u529e\u516c\u7535\u8111');
    assert.equal(JSON.stringify(reloaded).includes(token), false);
    const invalid = await client.callTool({ name: capability.updateTool, arguments: { set: { sshTargets: '-oProxyCommand=invalid' } } });
    assert.equal(invalid.isError, true);
    const relay = await startRelay({ port: 0, controllerToken: 'c'.repeat(32), agents: {} });
    t.after(() => relay.close());
    await client.callTool({ name: capability.updateTool, arguments: { set: {
      mode: '\u670d\u52a1\u4e2d\u7ee7', relayUrl: `ws://127.0.0.1:${relay.port}/relay`,
    } } });
    const refused = await client.callTool({ name: 'remote_hosts', arguments: {} });
    assert.equal(refused.isError, true);
    const editable = await client.callTool({ name: capability.readTool, arguments: {} });
    assert.equal(editable.isError, undefined);
    await client.callTool({ name: 'remote_settings_reset', arguments: {} });
    const cleared = await client.callTool({ name: 'remote_hosts', arguments: {} });
    assert.deepEqual(JSON.parse(cleared.content[0].text).hosts, []);
  });
}
