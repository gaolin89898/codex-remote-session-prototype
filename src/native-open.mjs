import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { nativeThreadUrl } from './native-links.mjs';

export async function openNativeThread(host, threadId, run = promisify(execFile)) {
  if (process.env.CODEX_REMOTE_HEADLESS === '1' || host.transport === 'local' && host.remote === true) {
    throw new Error('The remote backend cannot open desktop links; open the link in the Codex desktop client');
  }
  const url = nativeThreadUrl(host, threadId);
  if (!url) throw new Error('This host has no native Codex connection configured');
  const [command, args] = process.platform === 'win32'
    ? ['explorer.exe', [url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  await run(command, args, { windowsHide: true, timeout: 15000 });
  return { opened: true, url };
}
