import { fail } from './errors.mjs';

const encoder = new TextEncoder();
const DISABLED_ONLY_INI = new Map([
  ['opcache.enable', ['', '0', 'off', 'false', 'no', 'none']],
  ['opcache.enable_cli', ['', '0', 'off', 'false', 'no', 'none']],
  ['opcache.jit', ['', '0', 'off', 'disable', 'false', 'no']],
  ['opcache.jit_buffer_size', ['', '0', '0k', '0m', '0g']],
  ['opcache.preload', ['']],
]);
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_REQUEST_BYTES = 64 * 1024 * 1024;

export function record(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('INVALID_ARGUMENT', `${name} must be an object`);
  return value;
}

export function string(value, name, { empty = false } = {}) {
  if (typeof value !== 'string' || (!empty && value.length === 0) || value.includes('\0')) {
    fail('INVALID_ARGUMENT', `${name} must be ${empty ? 'a' : 'a nonempty'} string without NUL bytes`);
  }
  return value;
}

export function integer(value, name, fallback, maximum = 2_147_483_647) {
  value ??= fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) fail('INVALID_ARGUMENT', `${name} must be an integer between 1 and ${maximum}`);
  return value;
}

export function workspacePath(value, name = 'path') {
  string(value, name);
  if (encoder.encode(value).byteLength > 4095) fail('INVALID_ARGUMENT', `${name} exceeds the 4095-byte filesystem path limit`);
  if (value.includes('\\') || value.split('/').includes('..') || !value.startsWith('/')) {
    fail('INVALID_ARGUMENT', `${name} must be an absolute path inside /workspace without parent traversal`);
  }
  const normalized = value.split('/').filter((part) => part !== '' && part !== '.').join('/');
  if (normalized !== 'workspace' && !normalized.startsWith('workspace/')) fail('INVALID_ARGUMENT', `${name} must be inside /workspace`);
  return `/${normalized}`;
}

export function bytes(value, name, { text = false } = {}) {
  if (text && typeof value === 'string') return encoder.encode(value);
  if (!(value instanceof Uint8Array)) fail('INVALID_ARGUMENT', `${name} must be a Uint8Array${text ? ' or string' : ''}`);
  return new Uint8Array(value);
}

export function environment(value = {}) {
  record(value, 'env');
  const result = Object.create(null);
  for (const [key, val] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) fail('INVALID_ARGUMENT', `Invalid environment variable name: ${key}`);
    result[key] = string(val, `env.${key}`, { empty: true });
  }
  return result;
}

export function iniText(value = {}) {
  record(value, 'ini');
  return Object.entries(value).map(([key, raw]) => {
    if (!/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(key)) fail('INVALID_ARGUMENT', `Invalid INI setting: ${key}`);
    if (!['string', 'number', 'boolean'].includes(typeof raw) || (typeof raw === 'number' && !Number.isFinite(raw))) {
      fail('INVALID_ARGUMENT', `INI setting ${key} must be a string, finite number, or boolean`);
    }
    const value = typeof raw === 'boolean' ? (raw ? '1' : '0') : String(raw);
    if (/[\r\n\0]/.test(value)) fail('INVALID_ARGUMENT', `INI setting ${key} cannot contain newlines or NUL bytes`);
    const allowed = DISABLED_ONLY_INI.get(key.toLowerCase());
    if (allowed && !allowed.includes(value.toLowerCase())) {
      fail('INVALID_ARGUMENT', `${key} must remain disabled in the WebAssembly runtime`);
    }
    return `${key}="${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  }).join('\n');
}

export function runOptions(input) {
  record(input, 'run options');
  const args = input.args ?? [];
  if (!Array.isArray(args)) fail('INVALID_ARGUMENT', 'args must be an array of strings');
  if (args.length > 4096) fail('INVALID_ARGUMENT', 'args must contain at most 4096 arguments');
  return {
    script: workspacePath(input.script, 'script'),
    args: Array.from(args, (arg, index) => string(arg, `args[${index}]`, { empty: true })),
    cwd: workspacePath(input.cwd ?? '/workspace', 'cwd'),
    env: environment(input.env), ini: iniText(input.ini),
    stdin: input.stdin === undefined ? new Uint8Array() : bytes(input.stdin, 'stdin'),
  };
}

export function requestOptions(input) {
  record(input, 'request options');
  let url;
  try { url = new URL(string(input.url, 'url')); } catch { fail('INVALID_ARGUMENT', 'url must be an absolute HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('INVALID_ARGUMENT', 'url must be an HTTP(S) URL without credentials');
  const method = string(input.method ?? 'GET', 'method').toUpperCase();
  if (!/^[!#$%&'*+.^_`|~0-9A-Z-]+$/.test(method)) fail('INVALID_ARGUMENT', 'Invalid HTTP method');
  const headers = input.headers ?? [];
  if (!Array.isArray(headers)) fail('INVALID_ARGUMENT', 'headers must be an array of [name, value] pairs');
  if (headers.length > 1024) fail('INVALID_ARGUMENT', 'headers must contain at most 1024 pairs');
  const normalized = Array.from(headers, (pair) => {
    if (!Array.isArray(pair) || pair.length !== 2) fail('INVALID_ARGUMENT', 'Each header must be a [name, value] pair');
    const name = string(pair[0], 'header name').toLowerCase();
    const value = string(pair[1], 'header value', { empty: true });
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(name) || /[\r\n]/.test(value)) fail('INVALID_ARGUMENT', 'Invalid HTTP header');
    return [name, value];
  });
  const script = workspacePath(input.script, 'script');
  const documentRoot = workspacePath(input.documentRoot ?? '/workspace', 'documentRoot');
  if (!script.startsWith(`${documentRoot}/`)) fail('INVALID_ARGUMENT', 'script must be a file inside documentRoot');
  return {
    script, documentRoot, url: url.href, method, headers: normalized,
    cwd: workspacePath(input.cwd ?? '/workspace', 'cwd'),
    body: input.body === undefined ? new Uint8Array() : bytes(input.body, 'body'),
    env: environment(input.env), ini: iniText(input.ini),
  };
}

export function payloadBytes(value) {
  if (value instanceof Uint8Array) return 24 + value.byteLength;
  if (typeof value === 'string') return 16 + encoder.encode(value).byteLength;
  if (Array.isArray(value)) return value.reduce((total, item) => total + payloadBytes(item), 24 + value.length * 8);
  if (value && typeof value === 'object') return Object.entries(value).reduce((total, [key, val]) => total + payloadBytes(key) + payloadBytes(val) + 8, 32);
  return 8;
}
