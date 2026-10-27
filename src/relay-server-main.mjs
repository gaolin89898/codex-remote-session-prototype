import { readFile } from 'node:fs/promises';
import { startRelay } from './relay-server.mjs';

const config = JSON.parse(await readFile(process.env.CODEX_RELAY_CONFIG, 'utf8'));
const relay = await startRelay(config);
console.log(`Codex session relay listening on 127.0.0.1:${relay.port}`);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await relay.close(); });
