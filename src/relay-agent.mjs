import { RelayConnection } from './relay-connection.mjs';
import { SessionBridge } from './bridge.mjs';

export async function connectAgent(config, bridge = new SessionBridge([{
  id: config.id, transport: 'local', allowWrite: config.allowWrite === true,
}])) {
  const connection = new RelayConnection({ ...config, role: 'agent' });
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
  connection.once('disconnect', () => void bridge.close());
  try { await connection.start(); } catch (error) { await connection.close(); await bridge.close(); throw error; }
  return { connection, async close() { await connection.close(); await bridge.close(); } };
}
