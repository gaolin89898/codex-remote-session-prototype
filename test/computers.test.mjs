import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Computers } from '../src/computers.mjs';
import { SettingsStore } from '../src/settings.mjs';
import { discoverSshAliases } from '../src/ssh-discovery.mjs';
import { nativeSshUrl } from '../src/native-links.mjs';
import { openNativeConnection, openNativeConnectionsSettings } from '../src/native-open.mjs';

async function setup(t, options = {}) {
  const home = await mkdtemp(path.join(tmpdir(), 'remote-computers-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const store = new SettingsStore({ CODEX_HOME: home });
  const calls = [];
  const computers = new Computers(store, { call: async () => [] }, {
    discover: async () => [], open: async (...args) => { calls.push(args); return { dispatched: true }; }, ...options,
  });
  return { home, store, computers, calls };
}

test('SSH discovery parses concrete aliases, quotes and cyclic includes without evaluating Match exec', async (t) => {
  const { home } = await setup(t);
  const ssh = path.join(home, '.ssh');
  await mkdir(path.join(ssh, 'hosts'), { recursive: true });
  await writeFile(path.join(ssh, 'config'), `# Host ignored\nInclude "hosts/*.conf"\nhOsT "office" home *.internal !excluded\n HostName private.example\nMatch exec "exit 99"\n User someone\n`);
  await writeFile(path.join(ssh, 'hosts', 'extra.conf'), 'Host quoted-alias\n HostName private.example\nInclude config\n');
  assert.deepEqual(await discoverSshAliases(home), ['home', 'office', 'quoted-alias']);
});

test('native deep links enable the alias and activate only an absolute remote project', () => {
  const url = new URL(nativeSshUrl('devbox', '/home/user/a & b/\u9879\u76ee'));
  assert.equal(url.protocol, 'codex:');
  assert.equal(url.hostname, 'settings');
  assert.equal(url.pathname, '/connections/ssh/add');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    name: 'devbox', enabled: 'true', activate: 'true', projectPath: '/home/user/a & b/\u9879\u76ee',
  });
  assert.equal(new URL(nativeSshUrl('devbox')).searchParams.get('activate'), 'false');
  assert.equal(new URL(nativeSshUrl('devbox', 'C:\\Projects\\app')).searchParams.get('projectPath'), 'C:\\Projects\\app');
  for (const alias of ['', '-oProxyCommand=bad', 'user@host', 'host?activate=true', 'a/b', undefined]) {
    assert.throws(() => nativeSshUrl(alias), /alias/);
  }
  for (const folder of ['relative', '~/project', '/path\nwith-control', 'https://example.com', 'x'.repeat(4097)]) {
    assert.throws(() => nativeSshUrl('devbox', folder), /absolute/);
  }
});

test('native launcher dispatches fixed OS commands without claiming a successful connection', async () => {
  const invocations = [];
  const run = async (...args) => invocations.push(args);
  const result = await openNativeConnection('devbox', '/work', run);
  assert.equal(result.dispatched, true);
  assert.equal(result.connected, undefined);
  const dispatchedUrl = (invocation) => process.platform === 'win32' ? invocation[2].env.CODEX_REMOTE_NATIVE_URL : invocation[1][0];
  assert.equal(dispatchedUrl(invocations[0]), nativeSshUrl('devbox', '/work'));
  assert.equal(invocations[0][2].windowsHide, true);
  await openNativeConnectionsSettings(run);
  assert.equal(dispatchedUrl(invocations[1]), 'codex://settings/connections/ssh');
});

test('native connections persist separately from credentials, survive restart and can be forgotten', async (t) => {
  const { store, computers, calls } = await setup(t);
  const token = 'synthetic-private-token-'.repeat(2);
  await store.update({ relayToken: token });
  const before = await readFile(store.file, 'utf8');
  await Promise.all([
    computers.action({ action: 'connect', sshAlias: 'office', projectPath: '/work' }),
    computers.action({ action: 'connect', sshAlias: 'home', projectPath: '' }),
  ]);
  assert.equal(calls.length, 2);
  assert.equal(await readFile(store.file, 'utf8'), before);
  assert.equal((await readFile(computers.file, 'utf8')).includes(token), false);
  const reloaded = new Computers(store, {}, { discover: async () => [] });
  assert.deepEqual((await reloaded.list()).computers.map((row) => row.sshAlias), ['office', 'home']);
  await computers.action({ action: 'forget', id: 'ssh:office' });
  assert.deepEqual((await computers.load()).map((row) => row.sshAlias), ['home']);
  await assert.rejects(computers.action({ action: 'connect', sshAlias: 'bad?hostId=local' }));
  await assert.rejects(computers.action({ action: 'forget', id: '../../settings.json' }));
  assert.equal(calls.length, 2);
});

test('relay discovery binds devices to SSH without treating relay status as native status', async (t) => {
  const { computers, store } = await setup(t, { discover: async () => ['office', 'extra'] });
  await store.update({ mode: '\u670d\u52a1\u4e2d\u7ee7', relayUrl: 'ws://127.0.0.1:3420/relay', relayToken: 'x'.repeat(32) });
  let online = true;
  computers.bridge = { call: async (method) => {
    assert.equal(method, 'discoverHosts');
    return online ? [{ id: 'computer-1', name: '\u529e\u516c\u7535\u8111', connected: true }] : [];
  } };
  const first = (await computers.list()).computers[0];
  assert.equal(first.sshAlias, '');
  assert.equal(first.online, true);
  assert.equal(first.connected, undefined);
  await computers.action({ action: 'connect', id: first.id, name: first.name, sshAlias: 'office', projectPath: '/work' });
  const list = await computers.list();
  assert.equal(list.computers.filter((row) => row.sshAlias === 'office').length, 1);
  assert.equal(list.computers[0].projectPath, '/work');
  online = false;
  assert.equal((await computers.list()).computers[0].online, false);
  computers.bridge.call = async () => { throw new Error('secret token should never reach UI'); };
  const failed = await computers.list();
  assert.equal(failed.computers[0].online, null);
  assert.equal(failed.computers[0].sshAlias, 'office');
  assert.equal(failed.warnings.length, 1);
  assert.equal(JSON.stringify(failed).includes('secret token'), false);
});

test('direct targets require an alias for native registration and local computers stay hidden', async (t) => {
  const { computers, store } = await setup(t);
  store.connection = async () => ({ hosts: [
    { id: 'a', transport: 'ssh', target: 'office' },
    { id: 'b', transport: 'ssh', target: 'user@example.com' },
    { id: 'local', transport: 'local' },
  ] });
  const rows = (await computers.list()).computers;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].sshAlias, 'office');
  assert.equal(rows[1].sshAlias, '');
  assert.equal(rows[0].online, null);
});
