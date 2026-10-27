import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import { CircleCheck, CircleX, LoaderCircle, RotateCw } from 'lucide-react';

const app = new App({ name: 'Remote connection test', version: '0.4.3' }, {}, { autoResize: true });
let setResult, setReady;
let pending = true;
let initialTimer;

function accept(result) {
  clearTimeout(initialTimer);
  pending = false;
  const data = result?.structuredContent;
  setResult(data && typeof data.connected === 'boolean' ? data : {
    connected: false, message: '\u672a\u6536\u5230\u68c0\u6d4b\u7ed3\u679c\uff0c\u8bf7\u91cd\u8bd5\u3002',
  });
}

function theme(context) {
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
}

async function retry() {
  if (pending) return;
  pending = true;
  setResult(null);
  try { accept(await app.callServerTool({ name: 'remote_test_connection', arguments: {} }, { timeout: 90000 })); }
  catch { accept({ structuredContent: { connected: false, message: '\u68c0\u6d4b\u8bf7\u6c42\u5931\u8d25\uff0c\u8bf7\u91cd\u8bd5\u3002' } }); }
}

function ConnectionTest() {
  const [result, update] = useState(null);
  const [ready, updateReady] = useState(false);
  setResult = update;
  setReady = updateReady;
  const loading = result === null;
  const Icon = loading ? LoaderCircle : result.connected ? CircleCheck : CircleX;
  return <main aria-busy={loading}>
    <div className="result" role="status" aria-live="polite" aria-atomic="true">
      <Icon className={`status-icon ${loading ? 'spinning' : result.connected ? 'success' : 'failure'}`} aria-hidden="true" />
      <div className="copy">
        <h1>{loading ? '\u6b63\u5728\u6d4b\u8bd5\u8fde\u63a5\u2026' : result.connected
          ? result.mode === 'relay' ? '\u4e2d\u7ee7\u8fde\u63a5\u6210\u529f' : '\u8fde\u63a5\u6210\u529f' : '\u8fde\u63a5\u5931\u8d25'}</h1>
        <p>{loading ? '\u6b63\u5728\u68c0\u67e5\u5df2\u4fdd\u5b58\u7684\u8fde\u63a5' : result.connected
          ? `${result.mode === 'relay' ? '\u5728\u7ebf\u8bbe\u5907' : '\u53ef\u7528\u7535\u8111'} ${result.computers} \u53f0` : result.message}</p>
        {result?.hint && <p>{result.hint}</p>}
      </div>
    </div>
    <footer>
      <span>{Number.isFinite(result?.elapsedMs) ? `\u8017\u65f6 ${(result.elapsedMs / 1000).toFixed(1)} \u79d2` : ''}</span>
      <button type="button" disabled={loading || !ready} onClick={retry}>
        <RotateCw size={16} aria-hidden="true" />{'\u91cd\u65b0\u6d4b\u8bd5'}
      </button>
    </footer>
  </main>;
}

// Install notification handlers before connecting so cached results cannot be missed.
flushSync(() => createRoot(document.getElementById('root')).render(<ConnectionTest />));
app.ontoolresult = accept;
app.ontoolcancelled = () => accept({ structuredContent: { connected: false, message: '\u6d4b\u8bd5\u5df2\u53d6\u6d88\u3002' } });
app.onhostcontextchanged = theme;
async function connect() {
  initialTimer = setTimeout(() => accept({ structuredContent: {
    connected: false, message: '\u7b49\u5f85\u68c0\u6d4b\u7ed3\u679c\u8d85\u65f6\uff0c\u8bf7\u91cd\u8bd5\u3002',
  } }), 95000);
  try { await app.connect(); theme(app.getHostContext()); setReady(true); }
  catch { accept({ structuredContent: { connected: false, message: '\u65e0\u6cd5\u542f\u52a8\u8fde\u63a5\u68c0\u6d4b\uff0c\u8bf7\u5173\u95ed\u540e\u91cd\u8bd5\u3002' } }); }
}
void connect();
