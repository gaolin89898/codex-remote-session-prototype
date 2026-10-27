import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { nativeSshUrl, sshAliasPattern } from './native-links.mjs';
import { openNativeConnection, openNativeConnectionsSettings } from './native-open.mjs';
import { discoverSshAliases } from './ssh-discovery.mjs';

export const computersUri = 'ui://remote-session/computers.html';
const idSchema = z.string().min(1).max(260).regex(/^(ssh|direct|relay):[a-zA-Z0-9_.-]+$/);
const bindingSchema = z.strictObject({
  id: idSchema, name: z.string().max(120), sshAlias: z.string().regex(sshAliasPattern), projectPath: z.string().max(4096),
});
const savedSchema = z.array(bindingSchema).max(100);

export class Computers {
  constructor(store, bridge, options = {}) {
    this.store = store;
    this.bridge = bridge;
    this.file = path.join(store.directory, 'native-connections.json');
    this.discover = options.discover || discoverSshAliases;
    this.open = options.open || openNativeConnection;
    this.openSettings = options.openSettings || openNativeConnectionsSettings;
    this.pending = Promise.resolve();
  }
  async load() {
    try { return savedSchema.parse(JSON.parse(await readFile(this.file, 'utf8'))); }
    catch (error) { if (error.code === 'ENOENT') return []; throw new Error('Saved native connections are invalid'); }
  }
  mutate(change) {
    const operation = this.pending.then(async () => {
      const values = savedSchema.parse(change(await this.load()));
      await mkdir(this.store.directory, { recursive: true, mode: 0o700 });
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(values, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
        await rename(temporary, this.file);
      } finally { await rm(temporary, { force: true }); }
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  async list() {
    const [saved, aliasesResult, configuredResult] = await Promise.all([
      this.load(), this.discover().then((aliases) => ({ aliases }), () => ({ aliases: [], failed: true })),
      (async () => {
        const config = await this.store.connection();
        const hosts = config.relay ? await this.bridge.call('discoverHosts') : config.hosts;
        return { hosts, relay: Boolean(config.relay) };
      })().catch(() => ({ hosts: [], failed: true })),
    ]);
    const rows = new Map(saved.map((binding) => [binding.id, {
      ...binding, source: binding.id.split(':')[0], online: null, saved: true,
    }]));
    for (const host of configuredResult.hosts) {
      if (host.transport === 'local' || host.remote === false) continue;
      const source = configuredResult.relay ? 'relay' : 'direct';
      const id = `${source}:${host.id}`;
      const binding = rows.get(id);
      const alias = source === 'direct' && sshAliasPattern.test(host.target) ? host.target : '';
      rows.set(id, { id, name: String(host.name || host.id).slice(0, 120), source,
        online: source === 'relay' ? host.connected === true : null,
        sshAlias: binding?.sshAlias || alias, projectPath: binding?.projectPath || '', saved: Boolean(binding),
      });
    }
    for (const row of rows.values()) {
      if (row.source === 'relay' && row.online === null && !configuredResult.failed) row.online = false;
    }
    const used = new Set([...rows.values()].filter((row) => row.source !== 'ssh').map((row) => row.sshAlias));
    for (const row of rows.values()) if (row.source === 'ssh' && used.has(row.sshAlias)) rows.delete(row.id);
    for (const alias of aliasesResult.aliases) {
      const id = `ssh:${alias}`;
      if (!used.has(alias) && !rows.has(id)) rows.set(id, { id, name: alias, source: 'ssh', online: null,
        sshAlias: alias, projectPath: '', saved: false });
    }
    const warnings = [];
    if (aliasesResult.failed) warnings.push('\u65e0\u6cd5\u8bfb\u53d6 SSH \u914d\u7f6e');
    if (configuredResult.failed) warnings.push('\u8bbe\u5907\u53d1\u73b0\u5931\u8d25\uff0c\u53ef\u4ee5\u7ee7\u7eed\u4f7f\u7528 SSH \u8fde\u63a5');
    return { computers: [...rows.values()], aliases: aliasesResult.aliases, warnings };
  }
  async action({ action, id, sshAlias, projectPath = '', name }) {
    if (action === 'settings') return this.openSettings();
    if (action === 'forget') {
      idSchema.parse(id);
      await this.mutate((values) => values.filter((value) => value.id !== id));
      return { forgotten: true };
    }
    nativeSshUrl(sshAlias, projectPath);
    const key = id || `ssh:${sshAlias}`;
    const binding = bindingSchema.parse({ id: key, name: name || sshAlias, sshAlias, projectPath });
    await this.mutate((values) => [...values.filter((value) => value.id !== key), binding]);
    return this.open(sshAlias, projectPath);
  }
}

export function registerComputers(server, store, bridge, icons) {
  const computers = new Computers(store, bridge);
  const meta = { ui: { csp: { connectDomains: [], resourceDomains: [] }, prefersBorder: false } };
  registerAppResource(server, 'Remote computers', computersUri, { _meta: meta }, async () => ({
    contents: [{ uri: computersUri, mimeType: RESOURCE_MIME_TYPE, _meta: meta,
      text: typeof __COMPUTERS_HTML__ !== 'undefined' ? __COMPUTERS_HTML__ :
        await readFile(new URL('../dist/computers.html', import.meta.url), 'utf8') }],
  }));
  registerAppTool(server, 'remote_computers', {
    title: '\u8fdc\u7a0b\u7535\u8111', icons, inputSchema: {},
    _meta: { ui: { resourceUri: computersUri, visibility: ['app'] },
      'openai/ui': { entrypoints: [{ type: 'global', header: { enabled: false } }] } },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async () => {
    try { return { content: [], structuredContent: await computers.list() }; }
    catch { return { content: [], structuredContent: { error: '\u65e0\u6cd5\u8bfb\u53d6\u5df2\u4fdd\u5b58\u7684\u8fde\u63a5\u914d\u7f6e' } }; }
  });
  server.registerTool('remote_native_action', {
    title: '\u539f\u751f\u8fdc\u7a0b\u8fde\u63a5',
    inputSchema: { action: z.enum(['connect', 'settings', 'forget']), id: idSchema.optional(),
      sshAlias: z.string().regex(sshAliasPattern).optional(), projectPath: z.string().max(4096).optional(),
      name: z.string().max(120).optional() },
    _meta: { ui: { visibility: ['app'] } },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  }, async (args) => {
    try { return { content: [], structuredContent: await computers.action(args) }; }
    catch { return { isError: true, content: [{ type: 'text', text: '\u65e0\u6cd5\u6253\u5f00\u539f\u751f\u8fde\u63a5\uff0c\u8bf7\u68c0\u67e5 SSH \u522b\u540d\u3001\u7edd\u5bf9\u76ee\u5f55\u548c Codex \u684c\u9762\u5ba2\u6237\u7aef' }] }; }
  });
}
