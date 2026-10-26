/** An operational runtime error with a stable, machine-readable code. */
export class PHPWasmError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PHPWasmError';
    this.code = code;
    if (options.errno !== undefined) this.errno = options.errno;
  }
}

export function fail(code, message) {
  throw new PHPWasmError(code, message);
}

export function serializeError(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'RUNTIME_ERROR',
    message: error instanceof Error ? error.message : String(error),
    ...(typeof error?.errno === 'number' ? { errno: error.errno } : {}),
  };
}

export function deserializeError(error) {
  return new PHPWasmError(error?.code ?? 'RUNTIME_ERROR', error?.message ?? 'Worker failed', {
    errno: error?.errno,
  });
}
