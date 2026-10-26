/** An operational runtime error with a stable, machine-readable code. */
export class PHPWasmError extends Error {
  readonly code: string;
  readonly errno?: number;
  constructor(code: string, message: string, options?: { cause?: unknown; errno?: number });
}

export interface EngineAsset {
  /** Absolute URL for direct descriptors; relative to manifest URL in manifests. */
  url: string | URL;
  /** SHA-256 digest of the exact asset bytes, as 64 hexadecimal characters. */
  sha256: string;
}

export interface EngineDescriptor {
  /** Exact PHP version, e.g. 8.4.27. */
  phpVersion: string;
  module: EngineAsset;
  wasm: EngineAsset;
}

export interface RuntimeManifest {
  schemaVersion: 1;
  abiVersion: 1;
  runtimeVersion: string;
  engines: Record<string, EngineDescriptor>;
}

interface CommonOptions {
  /** Maximum duration of an active operation. Queued waiting time is excluded. Default: 30000. */
  timeoutMs?: number;
  /** Engine fetch, verification, compilation and persistence restoration timeout. Default: 120000. */
  startupTimeoutMs?: number;
  /** Combined output, diagnostics and response headers limit. Default: 16 MiB. */
  maxOutputBytes?: number;
  /** Request input and filesystem write limit. Default: 16 MiB. */
  maxRequestBytes?: number;
  /** Maximum queued/active operation count. Default: 64. */
  maxQueuedRequests?: number;
  /** Maximum queued/active input bytes. Default: 64 MiB. */
  maxQueuedBytes?: number;
  /** Browser-only IndexedDB persistence, with an exclusive Web Lock per key. */
  persistence?: { key: string };
  /**
   * Async host capabilities available to PHP's php_wasm_host_call(name, payloadJson).
   * Handlers return strings, normally JSON. A handler cannot reenter its own runtime.
   * This hook does not implement mysqli, PDO MySQL, networking, or a database server.
   */
  hostCalls?: Record<string, (payloadJson: string) => string | Promise<string>>;
}

export type CreatePHPOptions = CommonOptions & (
  | { manifestUrl: string | URL; phpVersion: string; engine?: never }
  | { engine: EngineDescriptor; manifestUrl?: never; phpVersion?: never }
);

export interface ExecutionOptions {
  /** Absolute path to an existing PHP script inside /workspace. */
  script: string;
  /** Working directory inside /workspace. Default: /workspace. */
  cwd?: string;
  /** Invocation-local environment variables. */
  env?: Record<string, string>;
  /** Invocation-local php.ini settings. Newline injection is rejected. */
  ini?: Record<string, string | number | boolean>;
}

export interface RunOptions extends ExecutionOptions {
  /** Arguments after argv[0] (the script). Shell syntax is never interpreted. */
  args?: string[];
  /** Binary data exposed through PHP's STDIN stream. */
  stdin?: Uint8Array;
}

export interface RequestOptions extends ExecutionOptions {
  /** Absolute HTTP(S) URL used to populate PHP request globals. No network fetch is performed. */
  url: string;
  method?: string;
  /** Pairs preserve duplicate headers. */
  headers?: [string, string][];
  body?: Uint8Array;
}

export interface RunResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export interface RequestResult {
  exitCode: number;
  status: number;
  /** Lowercase header names; repeated Set-Cookie headers remain separate. */
  headers: [string, string][];
  body: Uint8Array;
  stderr: Uint8Array;
}

export interface RuntimeFilesystem {
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ type: 'file' | 'directory' | 'other'; size: number; mtime: number }>;
  unlink(path: string): Promise<void>;
}

export interface PHPRuntime {
  readonly phpVersion: string;
  /** Null for direct engine descriptors. */
  readonly runtimeVersion: string | null;
  readonly state: 'starting' | 'ready' | 'closing' | 'closed';
  readonly fs: RuntimeFilesystem;
  /** Executes a PHP script with real PHP_SAPI=cli, argv and standard streams. */
  run(options: RunOptions): Promise<RunResult>;
  /** Executes one PHP HTTP request with fresh request globals. */
  request(options: RequestOptions): Promise<RequestResult>;
  /** Saves the workspace to IndexedDB when persistence is enabled. */
  flush(): Promise<void>;
  /** Drains accepted work, persists the workspace, releases the lock, and terminates the worker. */
  close(): Promise<void>;
}

/** Creates an isolated, serialized runtime in a dedicated browser or Node.js worker. */
export function createPHP(options: CreatePHPOptions): Promise<PHPRuntime>;
