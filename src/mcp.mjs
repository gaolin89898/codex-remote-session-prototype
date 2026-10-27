import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { SettingsStore, registerSettings } from './settings.mjs';
import { ConfiguredBridge } from './configured-bridge.mjs';

const store = new SettingsStore();
const bridge = new ConfiguredBridge(store);
const icons = typeof __REMOTE_ICONS__ !== 'undefined' ? __REMOTE_ICONS__ :
  (await import('./icons.mjs')).remoteSessionIcons;
const server = new McpServer({ name: 'codex-remote-session', version: '0.4.0', icons });
registerSettings(server, store, bridge);
const host = z.string().min(1).max(64).describe('Configured host ID from remote_hosts');
const thread = z.string().min(1).max(200);

function tool(name, description, inputSchema, readOnly, handler) {
  server.registerTool(name, {
    description,
    inputSchema,
    annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: true },
  }, async (args) => {
    try {
      const result = await handler(args);
      return { content: [{ type: 'text', text: JSON.stringify(result) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  });
}

tool('remote_hosts', 'List computers available through the configured relay or direct connections.', {}, true, async () => ({ hosts: await bridge.call('listHosts') }));
tool('remote_threads', 'List a page of Codex conversations on a configured host.', {
  host, cursor: z.string().optional(), search: z.string().max(500).optional(),
}, true, ({ host, cursor, search }) => bridge.call('threads', host, cursor, search));
tool('remote_read', 'Read conversation metadata and up to ten recent turns; use the returned cursor for older history.', {
  host, threadId: thread, cursor: z.string().optional(),
}, true, ({ host, threadId, cursor }) => bridge.call('read', host, threadId, cursor));
tool('remote_start', 'Create a Codex conversation on a host with allowWrite enabled. Shell and file access use the read-only sandbox.', {
  host, cwd: z.string().min(1).max(4096).describe('Absolute project directory on the selected host'),
}, false, ({ host, cwd }) => bridge.call('start', host, cwd));
tool('remote_prompt', 'Send a user-authorized message to an idle conversation. Returns a started turn, not its completed result. Remote permission requests are declined.', {
  host, threadId: thread, text: z.string().min(1).max(100000),
}, false, ({ host, threadId, text }) => bridge.call('prompt', host, threadId, text));
tool('remote_status', 'Get the most recent turn status observed by this bridge. Unknown status is not proof of completion.', {
  host, threadId: thread,
}, true, ({ host, threadId }) => bridge.call('status', host, threadId));
tool('remote_interrupt', 'Stop a specific turn on a host with allowWrite enabled.', {
  host, threadId: thread, turnId: z.string().min(1).max(200),
}, false, ({ host, threadId, turnId }) => bridge.call('interrupt', host, threadId, turnId));

let stopping;
async function stop() {
  if (stopping) return stopping;
  stopping = (async () => { await bridge.close(); await server.close(); })();
  return stopping;
}
process.once('SIGINT', () => void stop());
process.once('SIGTERM', () => void stop());
process.stdin.once('end', () => void stop());
await server.connect(new StdioServerTransport());
