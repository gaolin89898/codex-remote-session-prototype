import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { AppServerRpc } from '../src/rpc.mjs';

const fixture = fileURLToPath(new URL('./fixtures/app-server.mjs', import.meta.url));
async function connect(t, options = {}) {
  const rpc = new AppServerRpc(process.execPath, [fixture], options);
  t.after(() => rpc.close());
  await rpc.start();
  return rpc;
}

test('handshake, concurrent requests, and application errors', async (t) => {
  const rpc = await connect(t);
  assert.equal(rpc.info.userAgent, 'Fixture/1');
  const results = await Promise.all([rpc.request('first', { a: 1 }), rpc.request('second', { b: 2 })]);
  assert.deepEqual(results.map((x) => x.method), ['first', 'second']);
  await assert.rejects(rpc.request('error'), /Fixture error/);
  assert.equal(rpc.pending.size, 0);
});

test('interactive approvals are declined', async (t) => {
  const rpc = await connect(t);
  const answered = new Promise((resolve) => rpc.on('notification', (event) => {
    if (event.method === 'test/approvalAnswer') resolve(event.params);
  }));
  await rpc.request('approval');
  const answer = await answered;
  assert.deepEqual(answer.result, { decision: 'decline' });
});

test('timeout removes the pending request', async (t) => {
  const rpc = await connect(t, { timeoutMs: 500 });
  await assert.rejects(rpc.request('stall'), /timed out/);
  assert.equal(rpc.pending.size, 0);
});

test('process exit rejects an outstanding request', async (t) => {
  const rpc = await connect(t);
  await assert.rejects(rpc.request('exit'), /exited/);
  assert.equal(rpc.closed, true);
});

test('malformed output closes the connection', async (t) => {
  const rpc = await connect(t);
  await assert.rejects(rpc.request('malformed'), /Invalid JSON/);
});

test('missing executable rejects startup without waiting for the timeout', async () => {
  const rpc = new AppServerRpc('codex-remote-missing-executable', [], { timeoutMs: 2000 });
  await assert.rejects(rpc.start(), /ENOENT|unavailable/);
  await rpc.close();
});
