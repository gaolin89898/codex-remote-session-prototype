import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { registerAppResource, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';

export const connectionTestUri = 'ui://remote-session/connection-test.html';

// Return only known diagnostics: upstream errors may contain credentials or private paths.
function failureMessage(error) {
  const message = error?.message || '';
  if (/authentication failed/.test(message)) return '\u4ee4\u724c\u9a8c\u8bc1\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5\u63a7\u5236\u7aef\u4ee4\u724c\u3002';
  if (/endpoint not found/.test(message)) return '\u4e2d\u7ee7\u5730\u5740\u4e0d\u5b58\u5728\uff0c\u8bf7\u68c0\u67e5\u5730\u5740\u4e2d\u7684\u8def\u5f84\u3002';
  if (/timed out/.test(message)) return '\u8fde\u63a5\u8d85\u65f6\uff0c\u8bf7\u68c0\u67e5\u7f51\u7edc\u548c\u670d\u52a1\u72b6\u6001\u540e\u91cd\u8bd5\u3002';
  if (/Choose a connection/.test(message)) return '\u8bf7\u5148\u5728\u8bbe\u7f6e\u4e2d\u9009\u62e9\u8fde\u63a5\u65b9\u5f0f\u5e76\u4fdd\u5b58\u3002';
  if (/Enter an SSH host/.test(message)) return '\u8bf7\u586b\u5199 SSH \u4e3b\u673a\u5e76\u4fdd\u5b58\u3002';
  if (/Enter a relay address/.test(message)) return '\u8bf7\u586b\u5199\u4e2d\u7ee7\u5730\u5740\u548c\u63a7\u5236\u7aef\u4ee4\u724c\u5e76\u4fdd\u5b58\u3002';
  if (/Select a configuration|Unable to read the selected/.test(message)) return '\u65e0\u6cd5\u8bfb\u53d6\u914d\u7f6e\u6587\u4ef6\uff0c\u8bf7\u68c0\u67e5\u6587\u4ef6\u8def\u5f84\u3002';
  if (/Relay connection failed|Relay disconnected|Relay rejected/.test(message)) return '\u65e0\u6cd5\u8fde\u63a5\u4e2d\u7ee7\uff0c\u8bf7\u68c0\u67e5\u5730\u5740\u3001\u7f51\u7edc\u548c\u8bc1\u4e66\u3002';
  if (/WSS|credentials must not be in the URL|Invalid URL|Invalid relay token|Relay token/.test(message)) return '\u4e2d\u7ee7\u914d\u7f6e\u65e0\u6548\uff0c\u8bf7\u68c0\u67e5\u5730\u5740\u548c\u4ee4\u724c\u3002';
  if (/Codex|spawn|EPIPE|Connection is closed/.test(message)) return 'SSH \u6216\u8fdc\u7aef Codex \u542f\u52a8\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5\u514d\u5bc6\u767b\u5f55\u548c\u8fdc\u7aef\u5b89\u88c5\u3002';
  return '\u8fde\u63a5\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5\u5df2\u4fdd\u5b58\u7684\u8fde\u63a5\u914d\u7f6e\u548c\u670d\u52a1\u72b6\u6001\u3002';
}

export async function testConnection(bridge) {
  const started = performance.now();
  let result;
  try {
    const status = await bridge.call('testConnection');
    const relay = status.mode === 'relay';
    result = { ...status, message: relay
      ? `\u4e2d\u7ee7\u8fde\u63a5\u6210\u529f\uff0c\u5728\u7ebf\u8bbe\u5907 ${status.computers} \u53f0\u3002`
      : `\u8fde\u63a5\u6210\u529f\uff0c\u53ef\u7528\u7535\u8111 ${status.computers} \u53f0\u3002` };
    if (relay && status.computers === 0) result.hint = '\u5c1a\u65e0\u5176\u4ed6\u8bbe\u5907\u5728\u7ebf\uff0c\u8bf7\u5728\u76ee\u6807\u7535\u8111\u542f\u52a8\u8bbe\u5907\u4ee3\u7406\u3002';
  } catch (error) {
    result = { connected: false, message: failureMessage(error) };
  }
  // A completed diagnostic is a successful tool call, even when the connection failed.
  // Codex closes settings action dialogs on MCP isError results.
  return { content: [{ type: 'text', text: result.message }],
    structuredContent: { ...result, elapsedMs: Math.round(performance.now() - started) } };
}

export function registerConnectionTestView(server) {
  const meta = { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: false } };
  registerAppResource(server, 'Connection test', connectionTestUri, { _meta: meta }, async () => ({
    contents: [{ uri: connectionTestUri, mimeType: RESOURCE_MIME_TYPE, _meta: meta,
      text: typeof __CONNECTION_TEST_HTML__ !== 'undefined' ? __CONNECTION_TEST_HTML__ :
        await readFile(new URL('../dist/connection-test.html', import.meta.url), 'utf8') }],
  }));
}
