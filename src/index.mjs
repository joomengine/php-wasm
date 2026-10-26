import { PHPWasmError, deserializeError, fail, serializeError } from './errors.mjs';
import {
  bytes, integer, payloadBytes, record, requestOptions, runOptions, string, workspacePath,
  DEFAULT_TIMEOUT_MS, DEFAULT_MAX_OUTPUT_BYTES, DEFAULT_MAX_REQUEST_BYTES,
} from './validation.mjs';

export { PHPWasmError } from './errors.mjs';

function absoluteURL(value, name) {
  if (typeof value !== 'string' && !(value instanceof URL)) fail('INVALID_ARGUMENT', `${name} must be a URL`);
  try { return new URL(String(value), globalThis.location?.href).href; }
  catch { fail('INVALID_ARGUMENT', `${name} must be a URL${globalThis.location ? '' : ' (absolute in Node.js)'}`); }
}

function optionsForWorker(input) {
  record(input, 'options');
  if ((input.manifestUrl === undefined) === (input.engine === undefined)) fail('INVALID_ARGUMENT', 'Specify exactly one of manifestUrl or engine');
  const options = {
    timeoutMs: integer(input.timeoutMs, 'timeoutMs', DEFAULT_TIMEOUT_MS),
    startupTimeoutMs: integer(input.startupTimeoutMs, 'startupTimeoutMs', 120_000),
    maxOutputBytes: integer(input.maxOutputBytes, 'maxOutputBytes', DEFAULT_MAX_OUTPUT_BYTES),
    maxRequestBytes: integer(input.maxRequestBytes, 'maxRequestBytes', DEFAULT_MAX_REQUEST_BYTES),
    maxQueuedRequests: integer(input.maxQueuedRequests, 'maxQueuedRequests', 64, 1024),
    maxQueuedBytes: integer(input.maxQueuedBytes, 'maxQueuedBytes', 128 * 1024 * 1024),
  };
  if (input.manifestUrl !== undefined) {
    options.manifestUrl = absoluteURL(input.manifestUrl, 'manifestUrl');
    options.phpVersion = string(input.phpVersion, 'phpVersion');
  } else {
    const engine = record(input.engine, 'engine');
    options.engine = {
      phpVersion: string(engine.phpVersion, 'engine.phpVersion'),
      module: { url: absoluteURL(engine.module?.url, 'engine.module.url'), sha256: engine.module?.sha256 },
      wasm: { url: absoluteURL(engine.wasm?.url, 'engine.wasm.url'), sha256: engine.wasm?.sha256 },
    };
  }
  if (input.persistence !== undefined) {
    record(input.persistence, 'persistence');
    if (typeof input.persistence.key !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(input.persistence.key)) {
      fail('INVALID_ARGUMENT', 'persistence.key must contain 1–128 letters, digits, dots, underscores, or hyphens and start with a letter or digit');
    }
    options.persistence = { key: input.persistence.key };
  }
  return options;
}

class PHPRuntime {
  #worker;
  #options;
  #hostCalls;
  #state = 'starting';
  #nextId = 0;
  #pending = null;
  #queue = Promise.resolve();
  #queuedCount = 0;
  #queuedBytes = 0;
  #hostCallDepth = 0;
  #closePromise;

  constructor(worker, options, hostCalls) {
    this.#worker = worker;
    this.#options = options;
    this.#hostCalls = hostCalls;
    const receive = (message) => {
      this.#receive(message).catch((error) => this.#kill(new PHPWasmError('WORKER_FAILED', error.message, { cause: error })));
    };
    if (typeof worker.on === 'function') {
      worker.on('message', receive);
      worker.on('messageerror', () => this.#kill(new PHPWasmError('WORKER_FAILED', 'PHP worker returned an unreadable message')));
      worker.on('error', (error) => this.#kill(new PHPWasmError('WORKER_FAILED', error.message, { cause: error })));
      worker.on('exit', (code) => {
        if (this.#state !== 'closed') this.#kill(new PHPWasmError('WORKER_FAILED', `PHP worker exited unexpectedly (${code})`));
      });
    } else {
      worker.addEventListener('message', (event) => receive(event.data));
      worker.addEventListener('error', (event) => this.#kill(new PHPWasmError('WORKER_FAILED', event.message || 'PHP worker failed')));
      worker.addEventListener('messageerror', () => this.#kill(new PHPWasmError('WORKER_FAILED', 'PHP worker returned an unreadable message')));
    }
    Object.defineProperty(this, 'fs', { enumerable: true, value: Object.freeze({
      writeFile: async (path, data) => this.#enqueue('fs', { name: 'writeFile', path: workspacePath(path), data: bytes(data, 'data', { text: true }) }),
      readFile: async (path) => this.#enqueue('fs', { name: 'readFile', path: workspacePath(path) }),
      mkdir: async (path, options = {}) => {
        record(options, 'mkdir options');
        if (options.recursive !== undefined && typeof options.recursive !== 'boolean') fail('INVALID_ARGUMENT', 'recursive must be boolean');
        return this.#enqueue('fs', { name: 'mkdir', path: workspacePath(path), recursive: options.recursive ?? false });
      },
      readdir: async (path) => this.#enqueue('fs', { name: 'readdir', path: workspacePath(path) }),
      stat: async (path) => this.#enqueue('fs', { name: 'stat', path: workspacePath(path) }),
      unlink: async (path) => this.#enqueue('fs', { name: 'unlink', path: workspacePath(path) }),
    }) });
  }

  get state() { return this.#state; }

  async initialize() {
    try {
      const information = await this.#send('initialize', this.#options, this.#options.startupTimeoutMs);
      Object.defineProperties(this, {
        phpVersion: { value: information.phpVersion, enumerable: true },
        runtimeVersion: { value: information.runtimeVersion, enumerable: true },
      });
      this.#state = 'ready';
      return this;
    } catch (error) { this.#kill(error); throw error; }
  }

  async run(input) { return this.#enqueue('run', runOptions(input)); }
  async request(input) { return this.#enqueue('request', requestOptions(input)); }
  async flush() { return this.#enqueue('flush', {}); }

  close() {
    if (this.#closePromise) return this.#closePromise;
    if (this.#state === 'closed') return Promise.resolve();
    if (this.#hostCallDepth) return Promise.reject(new PHPWasmError('REENTRANT_CALL', 'A host callback cannot close its own PHP runtime'));
    this.#state = 'closing';
    this.#closePromise = this.#queue.then(async () => {
      if (this.#state === 'closed') return;
      try { await this.#send('close', {}, this.#options.timeoutMs); }
      finally { this.#kill(new PHPWasmError('CLOSED', 'PHP runtime is closed')); }
    });
    return this.#closePromise;
  }

  #enqueue(operation, args) {
    if (this.#state !== 'ready') return Promise.reject(new PHPWasmError('CLOSED', 'PHP runtime is closing or closed'));
    if (this.#hostCallDepth) return Promise.reject(new PHPWasmError('REENTRANT_CALL', 'A host callback cannot call back into its own PHP runtime'));
    const size = payloadBytes(args);
    if (size > this.#options.maxRequestBytes) return Promise.reject(new PHPWasmError('REQUEST_LIMIT', 'Request exceeds maxRequestBytes'));
    if (this.#queuedCount >= this.#options.maxQueuedRequests || this.#queuedBytes + size > this.#options.maxQueuedBytes) {
      return Promise.reject(new PHPWasmError('QUEUE_LIMIT', 'PHP runtime queue is full'));
    }
    this.#queuedCount++;
    this.#queuedBytes += size;
    const result = this.#queue.then(() => {
      if (this.#state === 'closed') fail('CLOSED', 'PHP runtime is closed');
      return this.#send(operation, args, this.#options.timeoutMs);
    }).finally(() => { this.#queuedCount--; this.#queuedBytes -= size; });
    this.#queue = result.catch(() => {});
    return result;
  }

  #send(operation, args, timeout) {
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#kill(new PHPWasmError('TIMEOUT', `PHP ${operation} exceeded ${timeout} ms; the runtime has been terminated`)), timeout);
      this.#pending = { id, resolve, reject, timer };
      try {
        const binary = args.data ?? args.stdin ?? args.body;
        const transfers = binary instanceof Uint8Array ? [binary.buffer] : [];
        this.#worker.postMessage({ type: 'call', id, operation, args }, transfers);
      }
      catch (error) { this.#kill(new PHPWasmError('WORKER_FAILED', error.message, { cause: error })); }
    });
  }

  async #receive(message) {
    if (!message || this.#state === 'closed') return;
    if (message.type === 'host-call') {
      try {
        if (!Object.hasOwn(this.#hostCalls, message.name)) fail('UNKNOWN_HOST_CALL', `No host callback registered for ${message.name}`);
        let result;
        // Detect immediate callback cycles without rejecting unrelated callers while
        // asynchronous host I/O is pending. After-await cycles are bounded by timeout.
        this.#hostCallDepth++;
        try { result = this.#hostCalls[message.name](message.payload); }
        finally { this.#hostCallDepth--; }
        const value = await result;
        string(value, 'host callback result', { empty: true });
        if (payloadBytes(value) > this.#options.maxRequestBytes) fail('REQUEST_LIMIT', 'Host callback result exceeds maxRequestBytes');
        if (this.#state !== 'closed') this.#worker.postMessage({ type: 'host-result', id: message.id, value });
      } catch (error) {
        if (this.#state !== 'closed') this.#worker.postMessage({ type: 'host-result', id: message.id, error: serializeError(error) });
      }
      return;
    }
    const pending = this.#pending;
    if (!pending || pending.id !== message.id) return;
    clearTimeout(pending.timer);
    this.#pending = null;
    if (message.type === 'result') pending.resolve(message.value);
    else {
      const error = deserializeError(message.error);
      pending.reject(error);
      if (message.fatal) this.#kill(error);
    }
  }

  #kill(error) {
    if (this.#state === 'closed') return;
    this.#state = 'closed';
    if (this.#pending) {
      clearTimeout(this.#pending.timer);
      this.#pending.reject(error);
      this.#pending = null;
    }
    Promise.resolve(this.#worker.terminate()).catch(() => {});
  }
}

/** Create an isolated PHP instance, owning exactly one worker and virtual filesystem. */
export async function createPHP(input) {
  const options = optionsForWorker(input);
  const hostCalls = input.hostCalls === undefined ? {} : { ...record(input.hostCalls, 'hostCalls') };
  for (const [name, callback] of Object.entries(hostCalls)) {
    string(name, 'host callback name');
    if (typeof callback !== 'function') fail('INVALID_ARGUMENT', `hostCalls.${name} must be a function`);
  }
  const url = new URL('./worker.mjs', import.meta.url);
  let worker;
  if (typeof process !== 'undefined' && process.versions?.node) {
    const { Worker } = await import('node:worker_threads');
    worker = new Worker(url, { type: 'module', execArgv: [] });
  } else {
    if (typeof Worker === 'undefined') fail('WORKER_UNAVAILABLE', 'This environment does not support dedicated module workers');
    worker = new Worker(url, { type: 'module', name: 'joomengine-php' });
  }
  return new PHPRuntime(worker, options, hostCalls).initialize();
}
