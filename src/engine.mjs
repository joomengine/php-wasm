import { PHPWasmError, fail } from './errors.mjs';
import { importEngine, resolveEngine } from './assets.mjs';
import { RuntimeFilesystem } from './filesystem.mjs';

const encoder = new TextEncoder();

class Output {
  constructor(limit) {
    this.limit = limit;
    this.length = 0;
    this.stdout = [];
    this.stderr = [];
    this.sizes = { stdout: 0, stderr: 0 };
    this.offsets = { stdout: 65536, stderr: 65536 };
    this.status = 200;
    this.headers = [];
    this.error = null;
  }

  count(length) {
    this.length += length;
    if (this.length > this.limit) {
      this.error ??= new PHPWasmError('OUTPUT_LIMIT', 'PHP output exceeds maxOutputBytes; the runtime has been terminated');
      throw this.error;
    }
  }

  append(channel, value) {
    const bytes = typeof value === 'string' ? encoder.encode(value) : typeof value === 'number' ? null : value;
    const length = bytes === null ? 1 : bytes.byteLength;
    this.count(length);
    this.sizes[channel] += length;
    let consumed = 0;
    while (consumed < length) {
      if (this.offsets[channel] === 65536) {
        this[channel].push(new Uint8Array(65536));
        this.offsets[channel] = 0;
      }
      const target = this[channel][this[channel].length - 1];
      const amount = Math.min(length - consumed, 65536 - this.offsets[channel]);
      if (bytes === null) target[this.offsets[channel]] = value;
      else target.set(bytes.subarray(consumed, consumed + amount), this.offsets[channel]);
      this.offsets[channel] += amount;
      consumed += amount;
    }
  }

  setHeaders(status, lines) {
    if (!Number.isInteger(status) || status < 100 || status > 599 || !Array.isArray(lines)) fail('ENGINE_PROTOCOL_ERROR', 'Native engine returned malformed HTTP headers');
    this.status = status;
    this.headers = lines.map((line) => {
      if (typeof line !== 'string' || /[\r\n\0]/.test(line)) fail('ENGINE_PROTOCOL_ERROR', 'Native engine returned an invalid HTTP header');
      this.count(encoder.encode(line).byteLength);
      const colon = line.indexOf(':');
      if (colon <= 0) fail('ENGINE_PROTOCOL_ERROR', 'Native engine returned an invalid HTTP header');
      return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()];
    });
  }

  join(channel) {
    const result = new Uint8Array(this.sizes[channel]);
    let offset = 0;
    for (const bytes of this[channel]) {
      const length = Math.min(bytes.length, result.length - offset);
      result.set(bytes.subarray(0, length), offset);
      offset += length;
    }
    return result;
  }

}

function httpInput(input) {
  const url = new URL(input.url);
  const values = new Map();
  for (const [name, value] of input.headers) {
    const previous = values.get(name);
    values.set(name, previous === undefined ? value : `${previous}${name === 'cookie' ? '; ' : ', '}${value}`);
  }
  const scriptName = input.script.slice(input.documentRoot.length);
  const server = {
    SERVER_SOFTWARE: 'Joomengine PHP WASM', SERVER_PROTOCOL: 'HTTP/1.1',
    SERVER_NAME: url.hostname, SERVER_PORT: url.port || (url.protocol === 'https:' ? '443' : '80'),
    REQUEST_METHOD: input.method, REQUEST_URI: `${url.pathname}${url.search}`,
    QUERY_STRING: url.search.slice(1), REQUEST_SCHEME: url.protocol.slice(0, -1),
    SCRIPT_FILENAME: input.script, SCRIPT_NAME: scriptName,
    PHP_SELF: scriptName, DOCUMENT_ROOT: input.documentRoot,
    HTTP_HOST: url.host, HTTPS: url.protocol === 'https:' ? 'on' : '',
    REMOTE_ADDR: '127.0.0.1', REMOTE_PORT: '0',
    CONTENT_LENGTH: String(input.body.byteLength),
  };
  for (const [name, value] of values) {
    if (name !== 'content-length' && name !== 'content-type' && name !== 'host') server[`HTTP_${name.toUpperCase().replaceAll('-', '_')}`] = value;
  }
  if (values.has('content-type')) server.CONTENT_TYPE = values.get('content-type');
  return {
    method: input.method, uri: `${url.pathname}${url.search}`, query: url.search.slice(1),
    contentType: values.get('content-type') ?? '', cookie: values.get('cookie') ?? '',
    body: input.body, stdin: new Uint8Array(), server, ini: input.ini,
  };
}

export class Engine {
  constructor(options, hostCall) {
    this.options = options;
    this.hostCall = hostCall;
    this.module = null;
    this.output = null;
    this.stdin = new Uint8Array();
    this.stdinOffset = 0;
    this.poisoned = false;
  }

  async initialize() {
    const resolved = await resolveEngine(this.options);
    const imported = await importEngine(resolved.module.data);
    if (typeof imported.default !== 'function') fail('ENGINE_ABI_MISMATCH', 'Engine module must export an Emscripten factory as default');
    const compiled = await WebAssembly.compile(resolved.wasm.data);
    const module = await imported.default({
      noInitialRun: true,
      // A blob module has no relative URL base. Instantiate verified bytes directly,
      // bypassing Emscripten's eager import.meta.url sidecar resolution.
      instantiateWasm: (imports, receive) => {
        const instance = new WebAssembly.Instance(compiled, imports);
        receive(instance, compiled);
        return instance.exports;
      },
      locateFile: (name) => {
        if (!name.endsWith('.wasm')) fail('ENGINE_ABI_MISMATCH', `Unexpected engine sidecar: ${name}`);
        return resolved.wasm.url.href;
      },
      stdin: () => this.stdinOffset < this.stdin.length ? this.stdin[this.stdinOffset++] : null,
      stdout: (byte) => this.output?.append('stdout', byte),
      stderr: (byte) => this.output?.append('stderr', byte),
      print: (line) => this.output?.append('stdout', `${line}\n`),
      printErr: (line) => this.output?.append('stderr', `${line}\n`),
    });
    this.module = module;
    const requiredFunctions = ['ccall', '_malloc', '_free', 'lengthBytesUTF8', 'stringToUTF8', '_php_wasm_run', '_php_wasm_exit_code', '_php_wasm_abi_version', '_php_wasm_version'];
    if (!module.FS || !module.ENV || !module.HEAPU8 || requiredFunctions.some((name) => typeof module[name] !== 'function')) {
      fail('ENGINE_ABI_MISMATCH', 'Engine is missing required Emscripten runtime exports');
    }
    if (module.ccall('php_wasm_abi_version', 'number', [], []) !== 1) fail('ENGINE_ABI_MISMATCH', 'Native engine ABI must equal 1');
    const actualVersion = module.ccall('php_wasm_version', 'string', [], []);
    if (actualVersion !== resolved.phpVersion) fail('ENGINE_ABI_MISMATCH', `Native PHP ${actualVersion} does not match manifest PHP ${resolved.phpVersion}`);
    this.baseEnvironment = { PATH: '/usr/bin:/bin', HOME: '/workspace', TMPDIR: '/tmp', TZ: 'UTC', ...module.ENV };
    module.phpWasm = {
      request: {},
      onStdout: (value) => this.output?.append('stdout', value),
      onStderr: (value) => this.output?.append('stderr', value),
      onHeaders: (status, headers) => this.output?.setHeaders(status, headers),
      hostCall: this.hostCall,
    };
    this.filesystem = new RuntimeFilesystem(module, this.options.maxOutputBytes);
    await this.filesystem.initialize(this.options.persistence);
    this.filesystem.operation('mkdir', { path: '/workspace/.php-wasm/sessions', recursive: true });
    return { phpVersion: actualVersion, runtimeVersion: resolved.runtimeVersion };
  }

  async execute(mode, input) {
    if (this.poisoned) fail('CLOSED', 'The native engine is no longer usable');
    const module = this.module;
    this.filesystem.check(input.script);
    this.filesystem.check(input.cwd);
    if (input.documentRoot) this.filesystem.check(input.documentRoot);
    const allocations = [];
    this.output = new Output(this.options.maxOutputBytes);
    this.stdin = mode === 'run' ? input.stdin : new Uint8Array();
    this.stdinOffset = 0;
    const previousCwd = module.FS.cwd();
    const previousEnvironment = { ...module.ENV };
    const allocate = (size) => {
      const pointer = module._malloc(size);
      if (!pointer) fail('OUT_OF_MEMORY', 'Native engine could not allocate request arguments');
      allocations.push(pointer);
      return pointer;
    };
    let enteredNative = false;
    try {
      for (const key of Object.keys(module.ENV)) delete module.ENV[key];
      const environment = { ...this.baseEnvironment, ...input.env, PWD: input.cwd };
      for (const [key, value] of Object.entries(environment)) {
        Object.defineProperty(module.ENV, key, { value, writable: true, configurable: true, enumerable: true });
      }
      module.FS.chdir(input.cwd);
      module.phpWasm.request = mode === 'run'
        ? { method: 'GET', uri: input.script, query: '', contentType: '', cookie: '', body: new Uint8Array(), stdin: input.stdin, server: {}, ini: input.ini }
        : httpInput(input);
      module.phpWasm.request.env = { ...module.ENV };
      module.phpWasm.request.ini = 'memory_limit=256M\ndate.timezone=UTC\nlog_errors=1\ndisplay_errors=0\nsession.save_path="/workspace/.php-wasm/sessions"\n' + input.ini;
      const argv = mode === 'run' ? [input.script, ...input.args] : [];
      const pointers = argv.map((arg) => {
        const size = module.lengthBytesUTF8(arg) + 1;
        const pointer = allocate(size);
        module.stringToUTF8(arg, pointer, size);
        return pointer;
      });
      let argvPointer = 0;
      if (pointers.length) {
        argvPointer = allocate((pointers.length + 1) * 4);
        const view = new DataView(module.HEAPU8.buffer);
        pointers.forEach((pointer, index) => view.setUint32(argvPointer + index * 4, pointer, true));
        view.setUint32(argvPointer + pointers.length * 4, 0, true);
      }
      enteredNative = true;
      await module.ccall('php_wasm_run', 'number', ['string', 'number', 'number', 'number'], [input.script, mode === 'run' ? 1 : 0, pointers.length, argvPointer], { async: true });
      // Asyncify can resume through a void PHP Fiber entrypoint, losing the direct C return.
      // The native completion status also detects a premature Asyncify resolution.
      const exitCode = module.ccall('php_wasm_exit_code', 'number', [], []);
      if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 255) {
        fail('ENGINE_PROTOCOL_ERROR', 'Native execution did not complete with a valid exit status; the runtime has been terminated');
      }
      if (this.output.error) throw this.output.error;
      const stderr = this.output.join('stderr');
      return mode === 'run'
        ? { exitCode, stdout: this.output.join('stdout'), stderr }
        : { exitCode, status: this.output.status, headers: this.output.headers, body: this.output.join('stdout'), stderr };
    } catch (error) {
      // An exception escaping the C/Asyncify stack can leave PHP internally inconsistent.
      if (enteredNative) this.poisoned = true;
      throw this.output.error ?? error;
    } finally {
      if (!this.poisoned) for (const pointer of allocations) module._free(pointer);
      this.output = null;
      this.stdin = new Uint8Array();
      if (!this.poisoned) {
        module.FS.chdir(previousCwd);
        for (const key of Object.keys(module.ENV)) delete module.ENV[key];
        Object.assign(module.ENV, previousEnvironment);
        module.phpWasm.request = {};
      }
    }
  }

  async close() {
    try { await this.filesystem?.sync(); }
    finally { await this.filesystem?.release(); }
  }
}
