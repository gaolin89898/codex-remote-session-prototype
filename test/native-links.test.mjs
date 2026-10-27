import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeThreadUrl } from '../src/native-links.mjs';
import { openNativeThread } from '../src/native-open.mjs';

test('local conversations use the desktop native URL', () => {
  assert.equal(nativeThreadUrl({ transport: 'local' }, 'thread-123'), 'codex://threads/thread-123');
});
test('a remote native host must be mapped explicitly', () => {
  assert.equal(nativeThreadUrl({ transport: 'ssh' }, 'thread-123'), null);
  const url = new URL(nativeThreadUrl({ transport: 'ssh', nativeHostId: 'remote-ssh-discovered:devbox' }, 'thread-123'));
  assert.equal(url.searchParams.get('hostId'), 'remote-ssh-discovered:devbox');
});

test('a backend running remotely never maps remote threads to this desktop', async () => {
  const host = { transport: 'local', remote: true };
  assert.equal(nativeThreadUrl(host, 'thread-123'), null);
  const mapped = { ...host, nativeHostId: 'remote-ssh-discovered:devbox' };
  const url = new URL(nativeThreadUrl(mapped, 'thread-123'));
  assert.equal(url.searchParams.get('hostId'), mapped.nativeHostId);
  let launched = false;
  await assert.rejects(openNativeThread(mapped, 'thread-123', async () => { launched = true; }), /remote backend/);
  assert.equal(launched, false);
});
test('conversation IDs cannot inject paths or protocol parameters', () => {
  for (const id of ['../file', 'id?hostId=other', 'id#x', 'file:///C:/', '']) {
    assert.throws(() => nativeThreadUrl({ transport: 'local' }, id), /Invalid/);
  }
});
test('native opening passes only a validated URL to a fixed operating-system command', async () => {
  let invocation;
  await openNativeThread({ transport: 'local' }, 'thread-123', async (...args) => { invocation = args; });
  if (process.platform === 'win32') {
    assert.equal(invocation[0], 'powershell.exe');
    assert.equal(invocation[2].env.CODEX_REMOTE_NATIVE_URL, 'codex://threads/thread-123');
    assert.equal(invocation[1].some((argument) => argument.includes('codex://')), false);
  } else assert.deepEqual(invocation[1], ['codex://threads/thread-123']);
  assert.equal(invocation[2].windowsHide, true);
});
