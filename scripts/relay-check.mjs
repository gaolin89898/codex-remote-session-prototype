import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RelayBridge } from '../src/relay-bridge.mjs';
import { SessionBridge } from '../src/bridge.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const configFile = process.argv.find((arg) => arg.startsWith('--config='))?.slice(9);
if (!configFile) throw new Error('Use --config=controller.json for the relay to verify');
const config = JSON.parse(await readFile(configFile, 'utf8'));
const observer = await new RelayBridge({ ...config, viewerId: 'deployment-verifier' }).startConnection();
const local = new SessionBridge([{ id: 'local', transport: 'local' }]);
const own = await new RelayBridge(config).startConnection();
const client = new Client({ name: 'relay-deployment-check', version: '0.4.1' });
const report = { mode: 'relay', checks: [] };
try {
  if (!observer.listHosts().length) await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { observer.connection.off('hosts', available); reject(new Error('Computer agent did not connect')); }, 15000);
    function available(hosts) { if (hosts.length) { clearTimeout(timer); observer.connection.off('hosts', available); resolve(); } }
    observer.connection.on('hosts', available);
  });
  const hosts = observer.listHosts();
  assert.equal(hosts.length, 1);
  assert.equal(hosts[0].id, config.viewerId);
  assert.deepEqual(own.listHosts(), []);
  report.checks.push('Computer agent registered on the remote relay; own computer hidden');
  const [relayed, direct] = await Promise.all([observer.threads(hosts[0].id), local.threads('local')]);
  assert.deepEqual(relayed.data.map((thread) => thread.id), direct.data.map((thread) => thread.id));
  report.conversationCount = relayed.data.length;
  report.checks.push('Real local Codex conversation list matches the list returned through the remote relay');
  await assert.rejects(observer.prompt(hosts[0].id, 'synthetic-thread', 'blocked test'), /read-only/);
  report.checks.push('Read-only protection rejects prompt before inference');
  const launch = JSON.parse(await readFile(path.join(root, 'dist/plugin/.mcp.json'), 'utf8')).mcpServers.codex_remote;
  const env = { ...process.env, CODEX_REMOTE_RELAY_FILE: configFile };
  delete env.CODEX_REMOTE_HOSTS_FILE;
  await client.connect(new StdioClientTransport({
    command: launch.command, args: launch.args, cwd: path.resolve(root, 'dist/plugin', launch.cwd), env, stderr: 'pipe',
  }));
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 11);
  assert.equal(tools.some((tool) => tool._meta?.['openai/ui']?.entrypoints), false);
  assert.equal(client.getServerCapabilities().resources, undefined);
  const discovered = await client.callTool({ name: 'remote_hosts', arguments: {} });
  assert.deepEqual(JSON.parse(discovered.content[0].text).hosts, []);
  report.checks.push('MCP relay adapter exposes backend tools without a page entrypoint or HTML resource');
  report.ok = true;
} finally {
  await Promise.allSettled([observer.close(), own.close(), local.close(), client.close()]);
  await writeFile(path.join(root, '.local/relay-check.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}
