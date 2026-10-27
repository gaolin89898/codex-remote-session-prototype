import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const run = promisify(execFile);
const target = process.argv.find((arg) => arg.startsWith('--target='))?.slice(9);
if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]{0,200}$/.test(target || '')) throw new Error('Use --target=ssh-alias');
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
async function ssh(command) {
  return (await run('ssh', ['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '--', target, command],
    { windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 })).stdout.trim();
}
await mkdir(path.join(root, '.local'), { recursive: true });
let credentials;
try { credentials = JSON.parse(await readFile(path.join(root, '.local/relay-credentials.json'), 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  credentials = { controllerToken: randomBytes(32).toString('base64url'), agentToken: randomBytes(32).toString('base64url'),
    agentId: `computer-${randomBytes(8).toString('hex')}` };
  await writeFile(path.join(root, '.local/relay-credentials.json'), `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
}
const manifest = JSON.parse(await readFile(path.join(root, 'plugin/manifest.json'), 'utf8'));
const release = `${manifest.version}-${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
const directory = '/opt/codex-session-relay';
const remoteRelease = `${directory}/releases/${release}`;
const launcher = `${remoteRelease}/mcp.sh`;
const previous = JSON.parse(await ssh('if [ -f /etc/codex-session-relay/config.json ]; then cat /etc/codex-session-relay/config.json; else printf null; fi'));
if (previous?.controllerToken) {
  credentials.controllerToken = previous.controllerToken;
  await writeFile(path.join(root, '.local/relay-credentials.json'), `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600 });
}
const relayConfig = { port: 3420, controllerToken: credentials.controllerToken,
  agents: { ...previous?.agents, [credentials.agentId]: { token: credentials.agentToken, allowWrite: false } } };
const configFile = path.join(root, '.local/relay-server.json');
await writeFile(configFile, `${JSON.stringify(relayConfig, null, 2)}\n`, { mode: 0o600 });
const controllerFile = path.join(root, '.local/relay-controller-server.json');
await writeFile(controllerFile, `${JSON.stringify({ url: 'ws://127.0.0.1:3420/relay', token: credentials.controllerToken,
  viewerId: credentials.agentId, nativeHosts: {},
}, null, 2)}\n`, { mode: 0o600 });
const launcherFile = path.join(root, '.local/relay-mcp.sh');
await writeFile(launcherFile, `#!/bin/sh\nset -eu\nexport CODEX_REMOTE_RELAY_FILE=/etc/codex-session-relay/controller.json\nexport CODEX_REMOTE_HEADLESS=1\nexec /usr/bin/node ${quote(`${remoteRelease}/mcp.mjs`)}\n`);
const unit = `[Unit]
Description=Codex session relay
After=network.target

[Service]
Type=simple
DynamicUser=yes
LoadCredential=config.json:/etc/codex-session-relay/config.json
Environment=CODEX_RELAY_CONFIG=%d/config.json
ExecStart=/usr/bin/node ${directory}/current/server.mjs
Restart=on-failure
RestartSec=3
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
MemoryMax=256M

[Install]
WantedBy=multi-user.target
`;
const unitFile = path.join(root, '.local/codex-session-relay.service');
await writeFile(unitFile, unit);
console.log(await ssh('node --version'));
await ssh(`umask 022; mkdir -p ${quote(remoteRelease)}; install -d -m 700 /etc/codex-session-relay`);
for (const [local, remote] of [
  [path.join(root, 'dist/relay/server.mjs'), `${remoteRelease}/server.mjs`],
  [path.join(root, `dist/plugin/server-${manifest.version}.mjs`), `${remoteRelease}/mcp.mjs`],
  [launcherFile, launcher],
  [configFile, '/etc/codex-session-relay/config.json'],
  [controllerFile, '/etc/codex-session-relay/controller.json'],
  [unitFile, '/etc/systemd/system/codex-session-relay.service'],
]) {
  await run('scp', ['-q', '-o', 'BatchMode=yes', '--', local, `${target}:${remote}`], { windowsHide: true, timeout: 60000 });
}
console.log(await ssh(`set -eu
chmod 600 /etc/codex-session-relay/config.json /etc/codex-session-relay/controller.json
chmod 644 /etc/systemd/system/codex-session-relay.service ${quote(`${remoteRelease}/server.mjs`)} ${quote(`${remoteRelease}/mcp.mjs`)} ${quote(launcher)}
ln -sfn ${quote(remoteRelease)} ${directory}/current.next
mv -Tf ${directory}/current.next ${directory}/current
systemctl daemon-reload
systemctl enable codex-session-relay.service >/dev/null 2>&1
systemctl restart codex-session-relay.service
systemctl is-active codex-session-relay.service
curl --fail --silent --retry 8 --retry-connrefused --retry-delay 1 http://127.0.0.1:3420/health`));
const url = 'ws://127.0.0.1:3425/relay';
await writeFile(path.join(root, '.local/relay-agent.json'), `${JSON.stringify({
  url, token: credentials.agentToken, id: credentials.agentId, name: os.hostname(), allowWrite: false,
  tunnel: { target, localPort: 3425, remotePort: 3420 },
}, null, 2)}\n`, { mode: 0o600 });
await writeFile(path.join(root, '.local/relay-controller.json'), `${JSON.stringify({
  url, token: credentials.controllerToken, viewerId: credentials.agentId, nativeHosts: {},
}, null, 2)}\n`, { mode: 0o600 });
await writeFile(path.join(root, '.local/deployment.json'), `${JSON.stringify({ mode: 'relay', target, directory, release, launcher, version: manifest.version }, null, 2)}\n`);
console.log(JSON.stringify({ mode: 'relay', target, directory, release, service: 'codex-session-relay.service',
  computer: os.hostname(), localComputerHidden: true, codexRequiredOnRelay: false }));
