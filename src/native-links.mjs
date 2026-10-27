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

export const sshAliasPattern = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,200}$/;

export function nativeSshUrl(sshAlias, projectPath = '') {
  if (typeof sshAlias !== 'string' || !sshAliasPattern.test(sshAlias)) throw new Error('Invalid SSH alias');
  if (typeof projectPath !== 'string' || projectPath.length > 4096 || /[\x00-\x1f\x7f]/.test(projectPath)
    || projectPath && !projectPath.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(projectPath)) {
    throw new Error('Remote project folder must be an absolute path');
  }
  const url = new URL('codex://settings/connections/ssh/add');
  url.searchParams.set('name', sshAlias);
  url.searchParams.set('enabled', 'true');
  // Without a project, keep native connection status and folder selection visible.
  url.searchParams.set('activate', projectPath ? 'true' : 'false');
  if (projectPath) url.searchParams.set('projectPath', projectPath);
  return url.href;
}
