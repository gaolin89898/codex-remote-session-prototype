import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchSpec } from '../src/hosts.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = process.argv.find((arg) => arg.startsWith('--source='))?.slice(9) || root;
const testHome = await mkdtemp(path.join(tmpdir(), 'codex-plugin-check-'));
const env = { ...process.env, CODEX_HOME: testHome };
delete env.CODEX_REMOTE_HOSTS_FILE;
delete env.CODEX_REMOTE_RELAY_FILE;
const spec = await launchSpec({ transport: 'local' }, env);
const prefix = spec.args.slice(0, spec.args.indexOf('app-server'));
const run = promisify(execFile);
async function cli(args) {
  return (await run(spec.command, [...prefix, 'plugin', ...args], {
    cwd: root, env, windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024,
  })).stdout;
}

const client = new Client({ name: 'plugin-package-check', version: '0.3.0' });
try {
  await cli(['marketplace', 'add', source]);
  const list = JSON.parse(await cli(['list', '--marketplace', 'codex-remote-session-lab', '--available', '--json']));
  assert.ok(JSON.stringify(list).includes('codex-remote-session'));
  const installed = JSON.parse(await cli(['add', 'codex-remote-session@codex-remote-session-lab', '--json']));
  const mcp = JSON.parse(await readFile(path.join(installed.installedPath, '.mcp.json'), 'utf8')).mcpServers.codex_remote;
  assert.equal(mcp.command, 'node');
  assert.deepEqual(mcp.args, ['${PLUGIN_ROOT}/server.mjs']);
  assert.equal(mcp.env, undefined);
  const args = mcp.args.map((arg) => arg.replaceAll('${PLUGIN_ROOT}', installed.installedPath));
  await client.connect(new StdioClientTransport({ command: mcp.command, args, env }));
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 7);
  assert.equal(tools.some((tool) => tool._meta?.['openai/ui']?.entrypoints), false);
  assert.equal(client.getServerCapabilities().resources, undefined);
  const discovered = await client.callTool({ name: 'remote_hosts', arguments: {} });
  assert.deepEqual(JSON.parse(discovered.content[0].text).hosts, []);
  console.log(JSON.stringify({ source, version: installed.plugin?.version || '0.3.0',
    marketplaceDiscovered: true, packagedMcpConnected: true, defaultHosts: [],
    tools: tools.map((tool) => tool.name) }, null, 2));
} finally {
  await client.close();
  await rm(testHome, { recursive: true, force: true });
}
