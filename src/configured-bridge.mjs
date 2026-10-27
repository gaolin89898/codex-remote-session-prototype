import { SessionBridge } from './bridge.mjs';
import { RelayBridge } from './relay-bridge.mjs';

export class ConfiguredBridge {
  constructor(store, factories = {}) {
    this.store = store;
    this.direct = factories.direct || ((hosts) => new SessionBridge(hosts));
    this.relay = factories.relay || ((config) => new RelayBridge(config).startConnection());
    this.pending = Promise.resolve();
  }
  call(method, ...args) {
    const acquired = this.pending.then(async () => {
      if (this.closed) throw new Error('Plugin connection is closed');
      const config = await this.store.connection();
      const key = JSON.stringify(config);
      if (this.current?.key !== key) {
        await this.retire();
        const bridge = config.relay ? await this.relay(config.relay) : await this.direct(config.hosts);
        this.current = { key, config, bridge, users: 0 };
      }
      const record = this.current;
      if (record.users++ === 0) record.idle = new Promise((resolve) => { record.release = resolve; });
      return record;
    });
    this.pending = acquired.then(() => {}, () => {});
    return acquired.then(async (record) => {
      const { bridge, config } = record;
      try {
        if (method === 'testConnection') {
          if (config.relay) await bridge.connection.check();
          const hosts = bridge.listHosts();
          if (!config.relay && !hosts.length) throw new Error('Choose a connection in plugin settings');
          if (!config.relay) {
            for (const host of hosts) await (await bridge.connection(host.id)).request('model/list', {});
          }
          return { connected: true, computers: hosts.length, mode: config.relay ? 'relay' : 'direct' };
        }
        return await bridge[method](...args);
      } finally { if (--record.users === 0) record.release(); }
    });
  }
  async retire() {
    const record = this.current;
    this.current = undefined;
    // Wait for existing requests while allowing independent requests on a stable connection.
    if (record) { await record.idle; await record.bridge.close(); }
  }
  invalidate() {
    const operation = this.pending.then(() => this.retire());
    this.pending = operation.catch(() => {});
    return operation;
  }
  async close() {
    this.closed = true;
    await this.pending;
    await this.retire();
  }
}
