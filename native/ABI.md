# Native host ABI, version 1

The generated `php.mjs` exports an asynchronous Emscripten module factory.
`php_wasm_abi_version()` returns `1`; `php_wasm_version()` returns the actual
upstream PHP patch version as a UTF-8 string. Call `php_wasm_run` through
`ccall(..., { async: true })`, since PHP can suspend for the host bridge or a
Fiber. Do not run two invocations on one module at once.

```c
int php_wasm_run(const char *script, int cli, int argc, char **argv);
```

`script` is an absolute virtual filesystem path. `cli` is 1 for CLI and 0 for
HTTP. CLI arguments include the script path at `argv[0]`; PHP executable flags
are not accepted here. The caller keeps argument buffers alive until execution
settles. The return value is PHP's exit status. A new PHP module/request lifecycle
is started for each invocation; filesystem contents survive. `PHP_SAPI` is
`cli` or `cgi-fcgi`, respectively. Commands cannot launch a host shell or process.

Before calling, set `Module.phpWasm`:

```js
{
  request: {
    method: 'GET', uri: '/', query: '', contentType: '', cookie: '',
    body: new Uint8Array(), stdin: new Uint8Array(),
    server: {}, env: {}, ini: ''
  },
  onStdout(bytes) {},
  onStderr(message) {},
  onHeaders(status, headerLines) {},
  async hostCall(name, payloadJson) { return resultJson; }
}
```

`server` contains CGI-style `$_SERVER` variables. `ini` is INI text evaluated at
startup. The host supplies sensible defaults and exposes an allowlist to users.
Output callbacks receive copies, so memory growth does not invalidate them.
Header lines remain an array to preserve repeated `Set-Cookie` values.

At module creation also supply Emscripten `stdin`, `stdout`, and `stderr`
callbacks. These operate on raw bytes and capture PHP standard streams (such as
`fwrite(STDOUT, ...)`) independently of the SAPI's ordinary PHP output callback.
The input callback returns `null` on EOF. Reset input offsets for every run.

PHP exposes `php_wasm_host_call(string $name, string $payload): string`.
The function suspends until the host resolves its promise. Host errors become
PHP exceptions. JSON is a convention for payloads; the bridge transports strings
and rejects embedded NUL characters. This is an integration boundary, not a PDO
driver or an implementation of MariaDB. The host chooses permitted operations.

The module exports `FS`, `IDBFS`, `ENV`, `HEAPU8`, `ccall`, `cwrap`, UTF-8 helpers,
`malloc`, and `free`. Persistence and Worker lifecycle are owned by the JS API.
The module uses Asyncify and does not require shared memory or browser threads.
