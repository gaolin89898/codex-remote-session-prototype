import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { createSettings } from '@openai/mcp-extensions/server';
import { configDirectory, connectionConfig } from './config.mjs';
import { validateHosts } from './hosts.mjs';
import { RelayConnection } from './relay-connection.mjs';

export const settingsFields = {
  mode: { title: '\u8fde\u63a5\u65b9\u5f0f', schema: z.enum(['\u672a\u8fde\u63a5', 'SSH \u76f4\u8fde', '\u670d\u52a1\u4e2d\u7ee7', '\u914d\u7f6e\u6587\u4ef6']) },
  sshTargets: { title: 'SSH \u4e3b\u673a', schema: z.string().max(4096), description: '\u591a\u53f0\u4e3b\u673a\u7528\u9017\u53f7\u5206\u9694' },
  allowWrite: { title: '\u5141\u8bb8\u53d1\u9001\u548c\u505c\u6b62\u4f1a\u8bdd', schema: z.boolean() },
  relayUrl: { title: '\u4e2d\u7ee7\u5730\u5740', schema: z.string().max(2048) },
  relayToken: { title: '\u63a7\u5236\u7aef\u4ee4\u724c', schema: z.string().max(4096).meta({ format: 'password', writeOnly: true }), description: '\u7559\u7a7a\u4fdd\u7559\u5df2\u4fdd\u5b58\u7684\u4ee4\u724c' },
  viewerId: { title: '\u672c\u673a\u4ee3\u7406 ID', schema: z.string().max(64) },
  configFile: { title: '\u914d\u7f6e\u6587\u4ef6\u8def\u5f84', schema: z.string().max(4096) },
};
const schema = z.strictObject(Object.fromEntries(Object.entries(settingsFields).map(([key, field]) => [key, field.schema])));
const defaults = { mode: '\u672a\u8fde\u63a5', sshTargets: '', allowWrite: false, relayUrl: '', relayToken: '', viewerId: '', configFile: '' };
const appOnly = { ui: { visibility: ['app'] } };

function sshHosts(value) {
  const targets = [...new Set(value.split(/[\s,]+/).filter(Boolean))];
  return validateHosts(targets.map((target) => ({
    id: `ssh-${createHash('sha256').update(target).digest('hex').slice(0, 16)}`,
    name: target, transport: 'ssh', target,
  })));
}

export class SettingsStore {
  constructor(env = process.env) {
    this.env = env;
    this.directory = configDirectory(env);
    this.file = path.join(this.directory, 'settings.json');
    this.pending = Promise.resolve();
  }
  async load() {
    if (!this.env.CODEX_REMOTE_HOSTS_FILE && !this.env.CODEX_REMOTE_RELAY_FILE) {
      try { return schema.parse(JSON.parse(await readFile(this.file, 'utf8'))); }
      catch (error) { if (error.code !== 'ENOENT') throw new Error('Saved plugin settings are invalid'); }
    }
    const config = await connectionConfig(this.env);
    const file = config.hosts || config.relay;
    return { ...defaults, ...(file ? { mode: '\u914d\u7f6e\u6587\u4ef6', configFile: file } : {}) };
  }
  async read() { return { ...await this.load(), relayToken: '' }; }
  validate(values) {
    schema.parse(values);
    if (values.sshTargets) sshHosts(values.sshTargets);
    if (values.viewerId && !/^[a-zA-Z0-9_-]{1,64}$/.test(values.viewerId)) throw new Error('Invalid viewer agent ID');
    if (values.relayUrl) {
      new RelayConnection({ url: values.relayUrl, token: values.relayToken || 'x'.repeat(32) });
    }
    if (values.relayToken && values.relayToken.length < 32) throw new Error('Relay token must contain at least 32 characters');
    if (values.configFile && !path.isAbsolute(values.configFile)) throw new Error('Configuration file path must be absolute');
  }
  async persist(values) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = path.join(this.directory, `.settings-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(values, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      await rename(temporary, this.file);
    } finally { await rm(temporary, { force: true }); }
    return { ...values, relayToken: '' };
  }
  update(set) {
    const operation = this.pending.then(async () => {
      if (this.env.CODEX_REMOTE_HOSTS_FILE || this.env.CODEX_REMOTE_RELAY_FILE) {
        throw new Error('Remove the launcher configuration override before editing plugin settings');
      }
      const patch = schema.partial().parse(set);
      // An empty password field keeps the saved token and never echoes it to the host.
      if (patch.relayToken === '') delete patch.relayToken;
      const values = { ...await this.load(), ...patch };
      this.validate(values);
      return this.persist(values);
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  reset() {
    const operation = this.pending.then(() => {
      if (this.env.CODEX_REMOTE_HOSTS_FILE || this.env.CODEX_REMOTE_RELAY_FILE) throw new Error('Remove the launcher configuration override before clearing plugin settings');
      return this.persist({ ...defaults });
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  async connection() {
    const values = await this.load();
    this.validate(values);
    if (values.mode === '\u672a\u8fde\u63a5') return { hosts: [] };
    if (values.mode === 'SSH \u76f4\u8fde') {
      const hosts = sshHosts(values.sshTargets).map((host) => ({ ...host, allowWrite: values.allowWrite }));
      if (!hosts.length) throw new Error('Enter an SSH host in plugin settings');
      return { hosts };
    }
    if (values.mode === '\u670d\u52a1\u4e2d\u7ee7') {
      if (!values.relayUrl || !values.relayToken) throw new Error('Enter a relay address and controller token in plugin settings');
      return { relay: { url: values.relayUrl, token: values.relayToken, viewerId: values.viewerId || undefined } };
    }
    if (!values.configFile) throw new Error('Select a configuration file in plugin settings');
    let config;
    try { config = JSON.parse(await readFile(values.configFile, 'utf8')); }
    catch { throw new Error('Unable to read the selected configuration file'); }
    if (Object.hasOwn(config, 'hosts')) return { hosts: validateHosts(config.hosts) };
    new RelayConnection(config);
    return { relay: config };
  }
}

export function registerSettings(server, store, bridge) {
  const facade = {
    server: server.server,
    registerTool: (name, config, handler) => server.registerTool(name, { ...config, _meta: appOnly }, handler),
  };
  createSettings(facade).register({
    readTool: 'remote_settings_read', updateTool: 'remote_settings_update', fields: settingsFields,
    layout: [
      { kind: 'group', title: '\u8fde\u63a5', items: [{ kind: 'property', property: 'mode' }] },
      { kind: 'group', title: 'SSH', items: ['sshTargets', 'allowWrite'].map((property) => ({ kind: 'property', property })) },
      { kind: 'group', title: '\u670d\u52a1\u4e2d\u7ee7', items: ['relayUrl', 'relayToken', 'viewerId'].map((property) => ({ kind: 'property', property })) },
      { kind: 'group', title: '\u9ad8\u7ea7', items: [{ kind: 'property', property: 'configFile' }] },
      { kind: 'group', title: '\u8fde\u63a5\u68c0\u67e5', items: [
        { kind: 'tool', tool: 'remote_test_connection' }, { kind: 'tool', tool: 'remote_settings_reset' },
      ] },
    ],
    read: () => store.read(),
    update: async (set) => {
      const values = await store.update(set);
      await bridge.invalidate();
      return values;
    },
  });
  server.registerTool('remote_test_connection', {
    title: '\u6d4b\u8bd5\u8fde\u63a5', inputSchema: {}, _meta: appOnly,
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async () => {
    try {
      const result = await bridge.call('testConnection');
      return { structuredContent: result, content: [{ type: 'text', text: `\u8fde\u63a5\u6210\u529f\uff0c\u53ef\u7528\u7535\u8111 ${result.computers} \u53f0\u3002` }] };
    }
    catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] }; }
  });
  server.registerTool('remote_settings_reset', {
    title: '\u6e05\u9664\u8bbe\u7f6e', inputSchema: {}, _meta: appOnly,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }, async () => {
    const values = await store.reset();
    await bridge.invalidate();
    return { content: [], structuredContent: { values } };
  });
}
