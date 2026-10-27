import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchSpec } from '../src/hosts.mjs';
import { AppServerRpc } from '../src/rpc.mjs';
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
    cwd: testHome, env, windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024,
  })).stdout;
}

const client = new Client({ name: 'plugin-package-check', version: '0.5.0' });
const appServer = new AppServerRpc(spec.command, spec.args, { cwd: testHome, env, timeoutMs: 45000 });
try {
  await cli(['marketplace', 'add', source]);
  const list = JSON.parse(await cli(['list', '--marketplace', 'codex-remote-session-lab', '--available', '--json']));
  assert.ok(JSON.stringify(list).includes('codex-remote-session'));
  const installed = JSON.parse(await cli(['add', 'codex-remote-session@codex-remote-session-lab', '--json']));
  const mcp = JSON.parse(await readFile(path.join(installed.installedPath, '.mcp.json'), 'utf8')).mcpServers.codex_remote;
  assert.equal(mcp.command, 'node');
  assert.deepEqual(mcp.args, ['./server.mjs']);
  assert.equal(mcp.cwd, '.');
  assert.equal(mcp.env, undefined);
  // Exercise Codex's plugin parser and discovery, including its path resolution.
  await appServer.start();
  const catalog = await appServer.request('mcpServerStatus/list', {
    serverName: 'codex_remote', detail: 'toolsAndAuthOnly',
  });
  const discoveredServer = catalog.data.find((server) => server.name === 'codex_remote');
  assert.ok(discoveredServer, 'Codex did not discover the installed MCP server');
  assert.equal(discoveredServer.toolsError, null);
  assert.equal(discoveredServer.pluginId, 'codex-remote-session@codex-remote-session-lab');
  assert.deepEqual(discoveredServer.serverCapabilities.extensions['openai/settings'], {
    readTool: 'remote_settings_read', updateTool: 'remote_settings_update',
  });
  const discoveredTools = Object.values(discoveredServer.tools);
  for (const name of ['remote_settings_read', 'remote_settings_update']) {
    assert.ok(discoveredTools.some((tool) => tool.name === name), `Codex did not discover ${name}`);
  }
  await client.connect(new StdioClientTransport({
    command: mcp.command, args: mcp.args, cwd: path.resolve(installed.installedPath, mcp.cwd), env,
  }));
  const tools = (await client.listTools()).tools;
  assert.equal(tools.length, 13);
  assert.deepEqual(client.getServerCapabilities().extensions['openai/settings'], {
    readTool: 'remote_settings_read', updateTool: 'remote_settings_update',
  });
  const settings = await client.callTool({ name: 'remote_settings_read', arguments: {} });
  assert.equal(settings.structuredContent.values.mode, '\u672a\u8fde\u63a5');
  assert.equal(typeof settings.structuredContent.values.deviceName, 'string');
  assert.ok(settings.structuredContent.layout.some((group) => group.items.some((item) => item.property === 'deviceName')));
  const sidebar = tools.find((tool) => tool.name === 'remote_computers');
  assert.deepEqual(sidebar._meta['openai/ui'].entrypoints, [{ type: 'global', header: { enabled: false } }]);
  assert.deepEqual(sidebar._meta.ui.visibility, ['app']);
  assert.deepEqual(discoveredTools.find((tool) => tool.name === sidebar.name)._meta['openai/ui'], sidebar._meta['openai/ui']);
  const resources = (await client.listResources()).resources;
  assert.deepEqual(resources.map((resource) => resource.uri), ['ui://remote-session/connection-test.html', 'ui://remote-session/computers.html']);
  assert.equal(sidebar._meta.ui.resourceUri, resources[1].uri);
  const action = tools.find((tool) => tool.name === 'remote_test_connection');
  assert.equal(action._meta.ui.resourceUri, resources[0].uri);
  assert.deepEqual(action._meta.ui.visibility, ['app']);
  assert.equal(discoveredTools.find((tool) => tool.name === action.name)._meta.ui.resourceUri, resources[0].uri);
  const diagnostic = await client.callTool({ name: action.name, arguments: {} });
  assert.equal(diagnostic.structuredContent.connected, false);
  assert.equal(diagnostic.isError, undefined);
  const discovered = await client.callTool({ name: 'remote_hosts', arguments: {} });
  assert.deepEqual(JSON.parse(discovered.content[0].text).hosts, []);
  console.log(JSON.stringify({ source, version: discoveredServer.serverInfo.version, nativeSettings: true,
    codexAppServerDiscoveredSettings: true, connectionTestDialog: true, nativeSidebarDiscovered: true,
    marketplaceDiscovered: true, packagedMcpConnected: true, defaultHosts: [],
    tools: tools.map((tool) => tool.name) }, null, 2));
} finally {
  await client.close();
  await appServer.close();
  const cleanup = { recursive: true, force: true, maxRetries: 10, retryDelay: 100 };
  for (const entry of await readdir(testHome)) await rm(path.join(testHome, entry), cleanup);
  try { await rm(testHome, cleanup); }
  catch (error) {
    if (error.code !== 'EBUSY' || (await readdir(testHome)).length) throw error;
    console.warn(`Plugin installation removed; Windows is still holding the empty temporary directory: ${testHome}`);
  }
}
