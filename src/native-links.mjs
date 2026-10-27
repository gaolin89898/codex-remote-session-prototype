export function nativeHostIdFor(host) {
  return host.transport === 'local' && host.remote !== true ? 'local' : host.nativeHostId || null;
}

export function nativeThreadUrl(host, threadId) {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(threadId)) throw new Error('Invalid conversation ID');
  const nativeHostId = nativeHostIdFor(host);
  if (!nativeHostId) return null;
  const url = new URL(`codex://threads/${threadId}`);
  if (nativeHostId !== 'local') url.searchParams.set('hostId', nativeHostId);
  return url.href;
}
