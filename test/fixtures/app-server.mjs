import { createInterface } from 'node:readline';

function send(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
const reader = createInterface({ input: process.stdin });
reader.on('line', (line) => {
  const message = JSON.parse(line);
  if (!message.method) {
    send({ method: 'test/approvalAnswer', params: message });
    return;
  }
  if (message.method === 'initialize') return send({ id: message.id, result: { userAgent: 'Fixture/1' } });
  if (message.method === 'initialized') return;
  if (message.method === 'stall') return;
  if (message.method === 'exit') return process.exit(4);
  if (message.method === 'malformed') return process.stdout.write('not-json\n');
  if (message.method === 'approval') {
    send({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1' } });
  }
  if (message.method === 'error') return send({ id: message.id, error: { code: -32000, message: 'Fixture error' } });
  send({ id: message.id, result: { method: message.method, params: message.params } });
});
