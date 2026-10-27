import { RelayConnection } from './relay-connection.mjs';
import { SessionBridge } from './bridge.mjs';
import { SettingsStore } from './settings.mjs';
import { hostname } from 'node:os';
import { watchFile, unwatchFile } from 'node:fs';

export async function connectAgent(config, bridge = new SessionBridge([{
  id: config.id, transport: 'local', allowWrite: config.allowWrite === true,
}]), options = {}) {
  const settings = options.settings || new SettingsStore();
  const name = async () => (await settings.load()).deviceName || config.name || hostname();
  const connection = new RelayConnection({ ...config, name: await name(), role: 'agent' });
  let watching = false, updatingName = Promise.resolve();
  function updateName() {
    updatingName = updatingName.then(async () => {
      const next = await name();
      if (connection.connected && next !== connection.options.name) {
        connection.send({ type: 'rename', name: next });
        connection.options.name = next;
      }
    }).catch(() => { /* Keep the last valid name if settings are temporarily unreadable. */ });
  }
  function stopWatching() {
    if (watching) { unwatchFile(settings.file, updateName); watching = false; }
  }
  const handlers = {
    threads: ({ cursor, search }) => bridge.threads(config.id, cursor, search),
    read: ({ threadId, cursor }) => bridge.read(config.id, threadId, cursor),
    start: ({ cwd }) => bridge.start(config.id, cwd),
    prompt: ({ threadId, text }) => bridge.prompt(config.id, threadId, text),
    status: ({ threadId }) => bridge.status(config.id, threadId),
    interrupt: ({ threadId, turnId }) => bridge.interrupt(config.id, threadId, turnId),
  };
  connection.on('request', async (message) => {
    let response;
    try {
      if (!Object.hasOwn(handlers, message.method)) throw new Error('Unsupported agent method');
      response = { result: await handlers[message.method](message.args || {}) };
    } catch (error) { response = { error: error.message }; }
    try { connection.send({ type: 'response', id: message.id, ...response }); } catch {}
  });
  connection.once('disconnect', () => { stopWatching(); void bridge.close(); });
  try { await connection.start(); } catch (error) { await connection.close(); await bridge.close(); throw error; }
  watchFile(settings.file, { persistent: false, interval: options.namePollIntervalMs || 1000 }, updateName);
  watching = true;
  updateName();
  return { connection, async close() { stopWatching(); await connection.close(); await bridge.close(); } };
}
