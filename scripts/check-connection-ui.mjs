import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';
import { testConnection } from '../src/connection-test.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, '.local/connection-ui');
await mkdir(output, { recursive: true });
const html = await readFile(path.join(root, 'dist/connection-test.html'));
const host = await build({
  stdin: { resolveDir: root, contents: `
    import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
    const frame = document.createElement('iframe');
    frame.src = '/view';
    frame.style.cssText = 'width:100%;height:200px;border:0;display:block';
    document.body.append(frame);
    const theme = new URLSearchParams(location.search).get('theme') || 'light';
    const bridge = new AppBridge(null, {name:'Connection test host',version:'1'}, {serverTools:{}}, {
      hostContext: {theme, displayMode:'inline', locale:'zh-CN'}
    });
    window.calls = 0;
    bridge.oncalltool = async (params) => {
      if (params.name !== 'remote_test_connection') throw Error('Unexpected tool');
      window.calls++;
      return new Promise(resolve => { window.completeRetry = resolve; });
    };
    bridge.onsizechange = ({height}) => { if (height) frame.style.height = height + 'px'; };
    bridge.oninitialized = async () => { await bridge.sendToolInput({arguments:{}}); window.ready = true; };
    window.sendResult = result => bridge.sendToolResult(result);
    window.cancel = () => bridge.sendToolCancelled({reason:'test'});
    bridge.connect(new PostMessageTransport(frame.contentWindow, frame.contentWindow));
  ` },
  bundle: true, write: false, platform: 'browser', format: 'iife', minify: true,
});
const server = createServer((request, response) => {
  const route = new URL(request.url, 'http://localhost').pathname;
  response.setHeader('Content-Type', route === '/host.js' ? 'text/javascript' : 'text/html; charset=utf-8');
  response.end(route === '/view' ? html : route === '/host.js' ? host.outputFiles[0].text :
    '<!doctype html><html><body style="margin:0"><script src="/host.js"></script></body></html>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
let browser;
const errors = [];
const report = [];
const success = await testConnection({ call: async () => ({ connected: true, computers: 2, mode: 'relay' }) });
const empty = await testConnection({ call: async () => ({ connected: true, computers: 0, mode: 'relay' }) });
const failure = await testConnection({ call: async () => { throw new Error('Relay authentication failed'); } });
try {
  browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : 'chrome') });
  for (const width of [520, 320]) for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width, height: 480 }, colorScheme: theme });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/?theme=${theme}`);
    await page.waitForFunction(() => window.ready);
    const view = page.frameLocator('iframe');
    const retry = view.getByRole('button', { name: '\u91cd\u65b0\u6d4b\u8bd5' });
    await view.getByRole('heading', { name: '\u6b63\u5728\u6d4b\u8bd5\u8fde\u63a5\u2026' }).waitFor();
    assert.equal(await retry.isDisabled(), true);
    await page.locator('iframe').screenshot({ path: path.join(output, `${width}-${theme}-loading.png`) });
    for (const [name, result] of [['success', success], ['empty', empty], ['failure', failure]]) {
      await page.evaluate((data) => window.sendResult(data), result);
      await view.getByRole('heading', { name: result.structuredContent.connected ? '\u4e2d\u7ee7\u8fde\u63a5\u6210\u529f' : '\u8fde\u63a5\u5931\u8d25' }).waitFor();
      assert.equal(await retry.isEnabled(), true);
      if (name === 'empty') await view.getByText(result.structuredContent.hint).waitFor();
      if (name === 'failure') await view.getByText(result.structuredContent.message).waitFor();
      const layout = await page.frames()[1].evaluate(() => ({
        overflow: document.documentElement.scrollWidth > innerWidth,
        clipped: [...document.querySelectorAll('h1,p,button,footer span')].some((element) => {
          const box = element.getBoundingClientRect();
          return box.left < 0 || box.right > innerWidth || box.bottom > document.documentElement.scrollHeight;
        }),
        theme: document.documentElement.dataset.theme,
      }));
      assert.deepEqual(layout, { overflow: false, clipped: false, theme });
      await page.locator('iframe').screenshot({ path: path.join(output, `${width}-${theme}-${name}.png`) });
    }
    await retry.click();
    await view.getByRole('heading', { name: '\u6b63\u5728\u6d4b\u8bd5\u8fde\u63a5\u2026' }).waitFor();
    assert.equal(await retry.isDisabled(), true);
    await page.waitForFunction(() => window.calls === 1);
    await page.evaluate((data) => window.completeRetry(data), success);
    await view.getByRole('heading', { name: '\u4e2d\u7ee7\u8fde\u63a5\u6210\u529f' }).waitFor();
    await page.evaluate(() => window.cancel());
    await view.getByText('\u6d4b\u8bd5\u5df2\u53d6\u6d88\u3002').waitFor();
    assert.equal(await retry.isEnabled(), true);
    report.push({ width, theme, loading: true, success: true, empty: true, failure: true, retry: true, cancelled: true, overflow: false });
    await page.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ ok: true, cases: report }, null, 2));
  console.log(JSON.stringify({ ok: true, screenshots: output, cases: report }, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
