import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import { ArrowUpRight, ChevronDown, Link2, LoaderCircle, Monitor, Plus, RotateCw, Settings2, Trash2, X } from 'lucide-react';

const app = new App({ name: 'Remote computers', version: '0.5.0' }, {}, { autoResize: true });
let updateData, updateLoading, updateReady;
let received = false;
let refreshing = false;

function theme(context) {
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
}
function accept(result) {
  received = true;
  const data = result?.structuredContent;
  updateData(data && (Array.isArray(data.computers) || data.error) ? data : { error: '\u672a\u6536\u5230\u7535\u8111\u5217\u8868\uff0c\u8bf7\u5237\u65b0' });
  updateLoading(false);
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  updateLoading(true);
  try { accept(await app.callServerTool({ name: 'remote_computers', arguments: {} }, { timeout: 90000 })); }
  catch { accept({ structuredContent: { error: '\u65e0\u6cd5\u8bfb\u53d6\u7535\u8111\u5217\u8868\uff0c\u8bf7\u91cd\u8bd5' } }); }
  finally { refreshing = false; }
}

function IconButton({ label, children, ...props }) {
  return <button type="button" className="icon-button" aria-label={label} title={label} {...props}>{children}</button>;
}

function ConnectionForm({ computer, onConnect, onCancel, busy }) {
  const [alias, setAlias] = useState(computer?.sshAlias || '');
  const [folder, setFolder] = useState(computer?.projectPath || '');
  const [error, setError] = useState('');
  function submit(event) {
    event.preventDefault();
    const sshAlias = alias.trim();
    const projectPath = folder.trim();
    if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,200}$/.test(sshAlias)) {
      setError('\u8bf7\u586b\u5199 SSH \u522b\u540d'); return;
    }
    if (/[\x00-\x1f\x7f]/.test(projectPath) || projectPath && !projectPath.startsWith('/') && !/^[a-zA-Z]:[\\/]/.test(projectPath)) {
      setError('\u8bf7\u586b\u5199\u8fdc\u7aef\u7edd\u5bf9\u76ee\u5f55'); return;
    }
    setError('');
    void onConnect({ id: computer?.id, name: computer?.name || sshAlias, sshAlias, projectPath });
  }
  return <form onSubmit={submit} className="connection-form" aria-label={computer?.name || '\u6dfb\u52a0\u8fde\u63a5'}>
    <label>{'SSH \u522b\u540d'}<input autoFocus list="ssh-aliases" value={alias} onChange={(event) => setAlias(event.target.value)} maxLength={201} required disabled={busy} autoComplete="off" /></label>
    <label>{'\u8fdc\u7aef\u76ee\u5f55'}<input value={folder} onChange={(event) => setFolder(event.target.value)} placeholder="/home/user/project" maxLength={4096} disabled={busy} autoComplete="off" /></label>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="form-actions">
      <button type="button" onClick={onCancel} disabled={busy}>{'\u53d6\u6d88'}</button>
      <button type="submit" className="primary" disabled={busy}>{busy ? <LoaderCircle className="spinning" /> : <ArrowUpRight />}{folder.trim() ? '\u6253\u5f00\u9879\u76ee' : '\u8fde\u63a5'}</button>
    </div>
  </form>;
}

function Computers() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [ready, setReady] = useState(false);
  const [expanded, setExpanded] = useState(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  updateData = setData;
  updateLoading = setLoading;
  updateReady = setReady;
  async function action(args) {
    if (busy || !ready) return;
    setBusy(true);
    setNotice(null);
    try {
      const result = await app.callServerTool({ name: 'remote_native_action', arguments: args }, { timeout: 30000 });
      if (result.isError) throw new Error();
      if (args.action === 'connect') {
        if (!result.structuredContent?.dispatched) throw new Error();
        setNotice({ text: '\u5df2\u4ea4\u7ed9 Codex \u5efa\u7acb\u8fde\u63a5' });
        setExpanded(null);
        void refresh();
      } else if (args.action === 'forget') {
        setExpanded(null);
        await refresh();
      }
    } catch { setNotice({ error: true, text: '\u64cd\u4f5c\u5931\u8d25\uff0c\u8bf7\u68c0\u67e5 SSH \u522b\u540d\u548c Codex \u5ba2\u6237\u7aef\u540e\u91cd\u8bd5' }); }
    finally { setBusy(false); }
  }
  const connect = (values) => action({ action: 'connect', ...values });
  return <main>
    <header>
      <h1>{'\u8fdc\u7a0b\u7535\u8111'}</h1>
      <nav aria-label={'\u8fde\u63a5\u64cd\u4f5c'}>
        <IconButton label={'\u5237\u65b0'} disabled={!ready || loading || busy} onClick={() => void refresh()}><RotateCw className={loading ? 'spinning' : ''} /></IconButton>
        <IconButton label={'\u8fde\u63a5\u8bbe\u7f6e'} disabled={!ready || busy} onClick={() => void action({ action: 'settings' })}><Settings2 /></IconButton>
        <IconButton label={expanded === 'new' ? '\u5173\u95ed\u6dfb\u52a0' : '\u6dfb\u52a0\u8fde\u63a5'} disabled={!ready || busy} onClick={() => setExpanded(expanded === 'new' ? null : 'new')}>{expanded === 'new' ? <X /> : <Plus />}</IconButton>
      </nav>
    </header>
    <datalist id="ssh-aliases">{data?.aliases?.map((alias) => <option key={alias} value={alias} />)}</datalist>
    {notice && <p role={notice.error ? 'alert' : 'status'} className={`notice ${notice.error ? 'error' : ''}`}>{notice.text}</p>}
    {data?.warnings?.map((warning) => <p role="status" className="warning" key={warning}>{warning}</p>)}
    {data?.error && <p role="alert" className="error notice">{data.error}</p>}
    {expanded === 'new' && <section className="add-connection"><ConnectionForm busy={busy} onConnect={connect} onCancel={() => setExpanded(null)} /></section>}
    {data?.computers?.length ? <ul aria-label={'\u8fdc\u7a0b\u7535\u8111\u5217\u8868'} aria-busy={loading}>
      {data.computers.map((computer) => <li key={computer.id}>
        <div className="computer-row">
          <button type="button" className="computer-toggle" aria-expanded={expanded === computer.id} disabled={busy} onClick={() => setExpanded(expanded === computer.id ? null : computer.id)}>
            <Monitor className="computer-icon" /><span className="computer-name">{computer.name}</span><ChevronDown className={`chevron ${expanded === computer.id ? 'expanded' : ''}`} />
          </button>
          <span className={`connection-state ${computer.source === 'relay' && computer.online === true ? 'online' : ''}`}>
            {computer.source === 'relay' && <i aria-hidden="true" />}{computer.source === 'relay' ? computer.online === true ? '\u4e2d\u7ee7\u5728\u7ebf' : computer.online === false ? '\u4e2d\u7ee7\u79bb\u7ebf' : '\u72b6\u6001\u672a\u77e5' : 'SSH'}
          </span>
          <IconButton label={computer.sshAlias ? `\u8fde\u63a5 ${computer.name}` : `\u7ed1\u5b9a ${computer.name}`} disabled={busy || !ready} onClick={() => computer.sshAlias ? void connect({ id: computer.id, name: computer.name, sshAlias: computer.sshAlias, projectPath: computer.projectPath }) : setExpanded(computer.id)}>
            {computer.sshAlias ? <ArrowUpRight /> : <Link2 />}
          </IconButton>
        </div>
        {expanded === computer.id && <div className="computer-details">
          <ConnectionForm key={computer.id} computer={computer} busy={busy} onConnect={connect} onCancel={() => setExpanded(null)} />
          {computer.saved && <IconButton label={'\u6e05\u9664\u4fdd\u5b58\u7684\u7ed1\u5b9a'} className="icon-button forget" disabled={busy} onClick={() => void action({ action: 'forget', id: computer.id })}><Trash2 /></IconButton>}
        </div>}
      </li>)}
    </ul> : !data?.error && expanded !== 'new' && <div className="empty" role="status">{loading ? <><LoaderCircle className="spinning" />{'\u6b63\u5728\u8bfb\u53d6\u7535\u8111'}</> : <><Monitor />{'\u6682\u65e0\u8fdc\u7a0b\u7535\u8111'}</>}</div>}
  </main>;
}

flushSync(() => createRoot(document.getElementById('root')).render(<Computers />));
app.ontoolresult = accept;
app.ontoolcancelled = () => accept({ structuredContent: { error: '\u8bfb\u53d6\u5df2\u53d6\u6d88\uff0c\u8bf7\u5237\u65b0' } });
app.onhostcontextchanged = theme;
async function connect() {
  try {
    await app.connect();
    theme(app.getHostContext());
    updateReady(true);
    if (!received) void refresh();
  } catch { accept({ structuredContent: { error: '\u65e0\u6cd5\u6253\u5f00\u7535\u8111\u5217\u8868\uff0c\u8bf7\u91cd\u65b0\u6253\u5f00' } }); }
}
void connect();
