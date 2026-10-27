import { loadHosts } from '../src/hosts.mjs';
import { SessionBridge } from '../src/bridge.mjs';

const hosts = await loadHosts();
if (!hosts.length) hosts.push({ id: 'local', transport: 'local', allowWrite: false });
const selected = process.argv.find((arg) => arg.startsWith('--host='))?.slice(7) || hosts[0].id;
const bridge = new SessionBridge(hosts);
const report = { host: selected, checkedAt: new Date().toISOString(), inferenceRequested: false };
try {
  const rpc = await bridge.connection(selected);
  report.handshake = Boolean(rpc.info);
  report.server = rpc.info?.userAgent || null;
  const models = await rpc.request('model/list', {});
  report.models = models.data?.length || 0;
  const threads = await bridge.threads(selected);
  report.threadCountOnPage = threads.data?.length || 0;
  report.hasMoreThreads = Boolean(threads.nextCursor);
  if (threads.data?.[0]) {
    const result = await bridge.read(selected, threads.data[0].id);
    report.historyReadable = Boolean(result.thread?.id);
    report.turnsOnPage = result.turns?.data?.length || 0;
  }
  if (process.argv.includes('--exercise')) {
    const created = await rpc.request('thread/start', {
      cwd: process.cwd(), ephemeral: true, sandbox: 'read-only', approvalPolicy: 'on-request',
    });
    report.ephemeralThreadCreated = Boolean(created.thread?.id);
  }
  report.ok = true;
} catch (error) {
  report.ok = false;
  report.error = error.message;
  process.exitCode = 1;
} finally {
  await bridge.close();
  // Deliberately omit conversation IDs, titles, paths, prompts, and credentials.
  console.log(JSON.stringify(report, null, 2));
}
