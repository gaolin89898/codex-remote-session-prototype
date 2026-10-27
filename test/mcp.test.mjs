import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

for (const entry of ['../src/mcp.mjs', '../dist/plugin/server.mjs']) {
  test(`MCP handshake and read-only enforcement: ${entry}`, async (t) => {
    const client = new Client({ name: 'remote-session-test', version: '1.0.0' });
    const home = await mkdtemp(path.join(tmpdir(), 'remote-mcp-test-'));
    const file = path.join(home, 'hosts.json');
    await writeFile(file, JSON.stringify({ hosts: [{ id: 'local', transport: 'local', allowWrite: false }] }));
    const env = { ...process.env, CODEX_HOME: home, CODEX_REMOTE_HOSTS_FILE: file };
    delete env.CODEX_REMOTE_RELAY_FILE;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL(entry, import.meta.url))],
      stderr: 'pipe',
      env,
    });
    t.after(async () => { await client.close(); await rm(home, { recursive: true, force: true }); });
    await client.connect(transport);
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 11);
    assert.deepEqual(client.getServerCapabilities().extensions['openai/settings'], {
      readTool: 'remote_settings_read', updateTool: 'remote_settings_update',
    });
    assert.equal(tools.tools.some((tool) => ['remote_open', 'remote_native_open'].includes(tool.name)), false);
    assert.equal(tools.tools.some((tool) => tool._meta?.['openai/ui']?.entrypoints), false);
    assert.equal(client.getServerCapabilities().resources, undefined);
    const hosts = await client.callTool({ name: 'remote_hosts', arguments: {} });
    assert.equal(JSON.parse(hosts.content[0].text).hosts[0].id, 'local');
    const denied = await client.callTool({ name: 'remote_prompt', arguments: {
      host: 'local', threadId: 'synthetic-thread', text: 'Synthetic test',
    } });
    assert.equal(denied.isError, true);
    assert.match(denied.content[0].text, /read-only/);
  });
}
