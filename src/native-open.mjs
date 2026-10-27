import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { nativeSshUrl, nativeThreadUrl } from './native-links.mjs';

async function openDesktopUrl(url, run) {
  if (process.env.CODEX_REMOTE_HEADLESS === '1') throw new Error('Desktop links are unavailable on a headless backend');
  const [command, args] = process.platform === 'win32'
    ? ['powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      'Start-Process -FilePath $env:CODEX_REMOTE_NATIVE_URL -ErrorAction Stop']]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  // Pass the validated URL as data; never interpolate it into PowerShell code.
  const options = { windowsHide: true, timeout: 15000 };
  if (process.platform === 'win32') options.env = { ...process.env, CODEX_REMOTE_NATIVE_URL: url };
  await run(command, args, options);
  return { dispatched: true, url };
}

export function openNativeConnection(sshAlias, projectPath = '', run = promisify(execFile)) {
  return openDesktopUrl(nativeSshUrl(sshAlias, projectPath), run);
}

export function openNativeConnectionsSettings(run = promisify(execFile)) {
  return openDesktopUrl('codex://settings/connections/ssh', run);
}

export async function openNativeThread(host, threadId, run = promisify(execFile)) {
  if (process.env.CODEX_REMOTE_HEADLESS === '1' || host.transport === 'local' && host.remote === true) {
    throw new Error('The remote backend cannot open desktop links; open the link in the Codex desktop client');
  }
  const url = nativeThreadUrl(host, threadId);
  if (!url) throw new Error('This host has no native Codex connection configured');
  await openDesktopUrl(url, run);
  return { opened: true, url };
}
