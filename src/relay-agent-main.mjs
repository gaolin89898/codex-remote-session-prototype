import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { connectAgent } from './relay-agent.mjs';

const file = process.argv.find((arg) => arg.startsWith('--config='))?.slice(9);
if (!file) throw new Error('An agent --config=file is required');
const config = JSON.parse(await readFile(file, 'utf8'));
let stopping = false, tunnel, agent;
async function stop() { stopping = true; tunnel?.kill(); await agent?.close(); }
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => void stop());
let failures = 0;
while (!stopping) {
  try {
    if (config.tunnel) {
      const { target, localPort, remotePort } = config.tunnel;
      if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]{0,200}$/.test(target) || ![localPort, remotePort].every((port) => Number.isInteger(port) && port > 1024 && port < 65536)) throw new Error('Invalid relay tunnel configuration');
      tunnel = spawn('ssh', ['-NT', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=10',
        '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3', '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`, '--', target],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      tunnel.stderr.resume();
      tunnel.on('error', () => {});
      await delay(1500);
      if (tunnel.exitCode !== null || tunnel.signalCode !== null) throw new Error('Relay tunnel failed');
    }
    agent = await connectAgent(config);
    failures = 0;
    console.log('Computer agent connected to the relay');
    const connectedAgent = agent, connectedTunnel = tunnel;
    await new Promise((resolve) => {
      function disconnected() {
        connectedAgent.connection.off('disconnect', disconnected);
        connectedTunnel?.off('exit', tunnelExited);
        resolve();
      }
      function tunnelExited() { void connectedAgent.close().finally(disconnected); }
      connectedAgent.connection.once('disconnect', disconnected);
      connectedTunnel?.once('exit', tunnelExited);
      if (stopping) disconnected();
    });
  } catch { if (!stopping) console.error('Relay unavailable; reconnecting'); }
  await agent?.close(); agent = null;
  tunnel?.kill(); tunnel = null;
  if (!stopping) await delay(Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)));
}
