import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, '.local/computers-ui');
await mkdir(output, { recursive: true });
const html = await readFile(path.join(root, 'dist/computers.html'));
const fixture = { computers: [
  { id: 'relay:office', name: '\u529e\u516c\u7535\u8111', source: 'relay', online: true, sshAlias: '', projectPath: '', saved: false },
  { id: 'ssh:devbox', name: 'devbox-with-a-long-computer-name', source: 'ssh', online: null, sshAlias: 'devbox', projectPath: '/home/dev/project', saved: true },
  { id: 'relay:home', name: '\u5bb6\u91cc\u7684\u7535\u8111', source: 'relay', online: false, sshAlias: 'home', projectPath: '', saved: true },
], aliases: ['office', 'home', 'devbox'], warnings: [] };
const host = await build({
  stdin: { resolveDir: root, contents: `
    import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
    const frame = document.createElement('iframe');
    frame.src = '/view';
    frame.style.cssText = 'width:100%;height:600px;border:0;display:block';
    document.body.append(frame);
    const theme = new URLSearchParams(location.search).get('theme') || 'light';
    const bridge = new AppBridge(null, {name:'Computers test host',version:'1'}, {serverTools:{}}, {
      hostContext: {theme, displayMode:'fullscreen', locale:'zh-CN'}
    });
    window.fixture = ${JSON.stringify(fixture)};
    window.calls = [];
    let first = true;
    bridge.oncalltool = async params => {
      window.calls.push(params);
      if (params.name === 'remote_computers') {
        if (first) { first = false; return new Promise(resolve => { window.completeList = () => resolve({content:[],structuredContent:window.fixture}); }); }
        return {content:[],structuredContent:window.fixture};
      }
      if (params.name !== 'remote_native_action') throw Error('Unexpected tool');
      if (window.failAction) return {isError:true,content:[]};
      return {content:[],structuredContent:params.arguments.action === 'forget' ? {forgotten:true} : {dispatched:true}};
    };
    bridge.onsizechange = ({height}) => { if (height) frame.style.height = Math.max(height, 200) + 'px'; };
    bridge.oninitialized = async () => { await bridge.sendToolInput({arguments:{}}); window.ready = true; };
    window.sendResult = result => bridge.sendToolResult({content:[],structuredContent:result});
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
try {
  browser = await chromium.launch({ headless: true, channel: process.env.PLAYWRIGHT_CHANNEL || (process.platform === 'win32' ? 'msedge' : 'chrome') });
  for (const width of [900, 520, 320]) for (const theme of ['light', 'dark']) {
    const page = await browser.newPage({ viewport: { width, height: 760 }, colorScheme: theme });
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/?theme=${theme}`);
    await page.waitForFunction(() => window.ready && window.completeList);
    const view = page.frameLocator('iframe');
    await view.getByText('\u6b63\u5728\u8bfb\u53d6\u7535\u8111').waitFor();
    await page.evaluate(() => window.completeList());
    await view.getByRole('button', { name: '\u7ed1\u5b9a \u529e\u516c\u7535\u8111', exact: true }).waitFor();
    await page.locator('iframe').screenshot({ path: path.join(output, `${width}-${theme}-list.png`) });
    await view.getByRole('button', { name: '\u7ed1\u5b9a \u529e\u516c\u7535\u8111', exact: true }).click();
    let form = view.getByRole('form', { name: '\u529e\u516c\u7535\u8111', exact: true });
    await form.getByLabel('SSH \u522b\u540d').fill('office');
    await form.getByLabel('\u8fdc\u7aef\u76ee\u5f55').fill('/home/user/a & b');
    await page.locator('iframe').screenshot({ path: path.join(output, `${width}-${theme}-binding.png`) });
    const layout = await page.frames()[1].evaluate(() => ({
      overflow: document.documentElement.scrollWidth > innerWidth,
      clipped: [...document.querySelectorAll('button,input,label,h1')].some((element) => {
        const box = element.getBoundingClientRect();
        return box.left < 0 || box.right > innerWidth + 1 || element.scrollWidth > element.clientWidth + 2;
      }),
      theme: document.documentElement.dataset.theme,
    }));
    assert.deepEqual(layout, { overflow: false, clipped: false, theme });
    await form.getByRole('button', { name: '\u6253\u5f00\u9879\u76ee', exact: true }).click();
    await view.getByText('\u5df2\u4ea4\u7ed9 Codex \u5efa\u7acb\u8fde\u63a5').waitFor();
    const bindingCall = await page.evaluate(() => window.calls.find((call) => call.name === 'remote_native_action'));
    assert.deepEqual(bindingCall.arguments, { action: 'connect', id: 'relay:office', name: '\u529e\u516c\u7535\u8111', sshAlias: 'office', projectPath: '/home/user/a & b' });
    await view.getByRole('button', { name: '\u6dfb\u52a0\u8fde\u63a5', exact: true }).click();
    form = view.getByRole('form', { name: '\u6dfb\u52a0\u8fde\u63a5', exact: true });
    await form.getByLabel('SSH \u522b\u540d').fill('user@host');
    await form.getByRole('button', { name: '\u8fde\u63a5', exact: true }).click();
    await form.getByText('\u8bf7\u586b\u5199 SSH \u522b\u540d').waitFor();
    await form.getByLabel('SSH \u522b\u540d').fill('devbox');
    await form.getByLabel('\u8fdc\u7aef\u76ee\u5f55').fill('relative');
    await form.getByRole('button', { name: '\u6253\u5f00\u9879\u76ee', exact: true }).click();
    await form.getByText('\u8bf7\u586b\u5199\u8fdc\u7aef\u7edd\u5bf9\u76ee\u5f55').waitFor();
    await form.getByRole('button', { name: '\u53d6\u6d88', exact: true }).click();
    await page.evaluate(() => { window.failAction = true; });
    await view.getByRole('button', { name: '\u8fde\u63a5 devbox-with-a-long-computer-name', exact: true }).click();
    await view.getByRole('alert').waitFor();
    await page.evaluate(() => { window.failAction = false; });
    await view.getByRole('button', { name: '\u8fde\u63a5 devbox-with-a-long-computer-name', exact: true }).click();
    await view.getByText('\u5df2\u4ea4\u7ed9 Codex \u5efa\u7acb\u8fde\u63a5').waitFor();
    await view.getByRole('button', { name: '\u8fde\u63a5\u8bbe\u7f6e', exact: true }).click();
    await page.waitForFunction(() => window.calls.some((call) => call.arguments.action === 'settings'));
    await page.evaluate(() => window.sendResult({ computers: [], aliases: [], warnings: [] }));
    await view.getByText('\u6682\u65e0\u8fdc\u7a0b\u7535\u8111').waitFor();
    await page.evaluate(() => window.sendResult({ error: '\u65e0\u6cd5\u8bfb\u53d6\u5df2\u4fdd\u5b58\u7684\u8fde\u63a5\u914d\u7f6e' }));
    await view.getByRole('alert').waitFor();
    await view.getByRole('button', { name: '\u5237\u65b0', exact: true }).click();
    await view.getByRole('button', { name: '\u7ed1\u5b9a \u529e\u516c\u7535\u8111', exact: true }).waitFor();
    report.push({ width, theme, binding: true, nativeDispatch: true, validation: true, errorRetry: true, settings: true, empty: true, overflow: false });
    await page.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ ok: true, cases: report }, null, 2));
  console.log(JSON.stringify({ ok: true, screenshots: output, cases: report }, null, 2));
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
