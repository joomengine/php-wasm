import { Engine } from './engine.mjs';
import { deserializeError, fail, serializeError } from './errors.mjs';
import { payloadBytes } from './validation.mjs';

const node = typeof process !== 'undefined' && Boolean(process.versions?.node);
let send;
let receive;
if (node) {
  const { parentPort } = await import('node:worker_threads');
  if (!parentPort) throw new Error('php-wasm/worker.mjs must run in a worker');
  send = (message, transfers = []) => parentPort.postMessage(message, transfers);
  receive = (listener) => parentPort.on('message', listener);
} else {
  send = (message, transfers = []) => self.postMessage(message, transfers);
  receive = (listener) => self.addEventListener('message', (event) => listener(event.data));
}

let engine;
let chain = Promise.resolve();
let nextHostId = 0;
const hostRequests = new Map();

function hostCall(name, payload) {
  if (typeof name !== 'string' || typeof payload !== 'string') fail('ENGINE_PROTOCOL_ERROR', 'Host calls require a string name and JSON string payload');
  if (payloadBytes(name) + payloadBytes(payload) > engine.options.maxRequestBytes) fail('REQUEST_LIMIT', 'Host call exceeds maxRequestBytes');
  const id = ++nextHostId;
  return new Promise((resolve, reject) => {
    hostRequests.set(id, { resolve, reject });
    send({ type: 'host-call', id, name, payload });
  });
}

async function dispatch(message) {
  let value;
  try {
    if (message.operation === 'initialize') {
      if (engine) fail('ENGINE_PROTOCOL_ERROR', 'Runtime was already initialized');
      engine = new Engine(message.args, hostCall);
      value = await engine.initialize();
    } else {
      if (!engine?.module) fail('CLOSED', 'Runtime has not initialized');
      switch (message.operation) {
        case 'run': case 'request': value = await engine.execute(message.operation, message.args); break;
        case 'flush': await engine.filesystem.sync(); break;
        case 'close': await engine.close(); break;
        case 'fs': value = engine.filesystem.operation(message.args.name, message.args); break;
        default: fail('ENGINE_PROTOCOL_ERROR', 'Unknown worker operation');
      }
      if (payloadBytes(value) > engine.options.maxOutputBytes + 4096) fail('OUTPUT_LIMIT', 'Worker response exceeds maxOutputBytes');
    }
    const transfers = value instanceof Uint8Array ? [value.buffer] : value?.stdout ? [value.stdout.buffer, value.stderr.buffer] : value?.body ? [value.body.buffer, value.stderr.buffer] : [];
    send({ type: 'result', id: message.id, value }, transfers);
  } catch (error) {
    send({ type: 'error', id: message.id, error: serializeError(error), fatal: message.operation === 'initialize' || Boolean(engine?.poisoned) });
  }
}

receive((message) => {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'host-result') {
    const pending = hostRequests.get(message.id);
    if (!pending) return;
    hostRequests.delete(message.id);
    if (message.error) pending.reject(deserializeError(message.error));
    else pending.resolve(message.value);
  } else if (message.type === 'call' && Number.isSafeInteger(message.id)) {
    chain = chain.then(() => dispatch(message));
  }
});
