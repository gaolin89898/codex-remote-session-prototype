import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connectionConfig } from '../src/config.mjs';
import { loadHosts } from '../src/hosts.mjs';

test('fresh installation has no bound computer or relay', async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), 'remote-config-test-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.deepEqual(await connectionConfig({ CODEX_HOME: home }), {});
  assert.deepEqual(await loadHosts(), []);
  await mkdir(path.join(home, 'remote-session'));
  const hosts = path.join(home, 'remote-session/hosts.json');
  const relay = path.join(home, 'remote-session/relay.json');
  await writeFile(hosts, '{"hosts":[]}');
  assert.deepEqual(await connectionConfig({ CODEX_HOME: home }), { hosts });
  await writeFile(relay, '{}');
  await assert.rejects(connectionConfig({ CODEX_HOME: home }), /either/);
  assert.deepEqual(await connectionConfig({ CODEX_HOME: home, CODEX_REMOTE_RELAY_FILE: relay }), { relay });
  await assert.rejects(connectionConfig({ CODEX_REMOTE_HOSTS_FILE: hosts, CODEX_REMOTE_RELAY_FILE: relay }), /either/);
});
