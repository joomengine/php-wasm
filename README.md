# JoomEngine PHP WebAssembly

A self-maintained PHP runtime for browser workers, built from official PHP
sources with Emscripten. The runtime has no WordPress or Herman Peeren runtime
dependency. Its C adapter and small JavaScript API support PHP scripts, HTTP
requests, virtual files and optional browser persistence.

This is the PHP layer of [JoomEngine Playground](https://github.com/joomengine/playground).
The [MariaDB bridge](https://github.com/joomengine/mariadb-wasm-bridge) releases
the database engine and driver source independently. This runtime compiles its
native PDO `mysql` driver into each PHP engine; the database worker is supplied
separately. Joomla installation remains the playground's responsibility.

## Capabilities

- Independently built PHP **8.3, 8.4 and 8.5** engines; exact patch releases and
  dependency inputs live in [`versions.json`](versions.json).
- Dedicated workers, serialized PHP invocations, request timeouts and bounded
  output. CLI arguments and binary input/output preserve their boundaries.
- HTTP status, repeated headers, cookies, request bodies and PHP request globals.
- An isolated virtual filesystem per instance, with opt-in IndexedDB persistence
  and an explicit flush operation.
- Checksummed engine manifests and a versioned native ABI.
- A statically compiled MariaDB PDO driver using the versioned `mariadb.v1`
  asynchronous host protocol, with driver provenance in each engine manifest.
- Real WebAssembly execution tests in Node.js and browsers. Release jobs require
  all supported engines to pass those tests before producing release assets.

Releases must pass both the PHP runtime and combined PHP/MariaDB test matrix.
These checks do not certify Joomla installation or any particular component.

## Build and run locally

Use Linux, Node.js 24 or later, Python 3, Git and the native build prerequisites:

```sh
sudo apt-get install build-essential autoconf automake libtool pkg-config \
  bison re2c cmake ninja-build curl jq xz-utils patch
npm ci
bash build/setup-emsdk.sh "$PWD/.emsdk"
source .emsdk/emsdk_env.sh
npm run build -- 8.4
npm run manifest -- --php 8.4
```

The first build compiles PHP and its native libraries. Generated engines are
written to `dist/php/<minor>/`; no Docker daemon is needed.

Serve this checkout over HTTP and open `/examples/`:

```sh
python3 -m http.server 8080
```

The example uses the local `dist/runtime-manifest.json`. Change the manifest's
selected PHP build by compiling another minor and regenerating the manifest.
Run `npm run manifest` without `--php` after all three engines have been built
to include every engine.

## Browser API

The following example assumes the source checkout is served at the origin root:

```js
import { createPHP } from './src/index.mjs';

const php = await createPHP({
  manifestUrl: new URL('./dist/runtime-manifest.json', location.href).href,
  phpVersion: '8.4',
  // Omit persistence for a fresh, temporary instance.
  persistence: { key: 'my-php84-test-site' },
});

try {
  await php.fs.writeFile('/workspace/hello.php',
    '<?php echo "Hello, " . $argv[1];');
  const result = await php.run({
    script: '/workspace/hello.php',
    args: ['Joomla'],
  });
  console.log(result.exitCode, new TextDecoder().decode(result.stdout));
  await php.flush();
} finally {
  await php.close();
}
```

`run()` executes a PHP script with CLI semantics, including `PHP_SAPI`, `$argv`
and standard streams. Arguments are script arguments, not PHP interpreter flags
or a shell command. Set PHP configuration using the `ini` object and process
variables using the `env` object on a call. Both are scoped to that invocation.

Within an open instance, execute an HTTP request with:

```js
await php.fs.writeFile('/workspace/index.php', `<?php
http_response_code(201);
header('Content-Type: application/json');
echo json_encode(['method' => $_SERVER['REQUEST_METHOD'], 'query' => $_GET]);
`);
const response = await php.request({
  script: '/workspace/index.php',
  url: 'https://playground.example/index.php?example=1',
  method: 'GET',
});
console.log(response.status, response.headers);
console.log(new TextDecoder().decode(response.body));
```

The URL supplies PHP request metadata; it does not make an outbound request.
The playground is responsible for routing browser requests to `request()` and
returning cookies on subsequent calls. Response headers are pairs so repeated
`Set-Cookie` values remain intact. Use `/workspace` paths for application files.
See [`types/index.d.ts`](types/index.d.ts) for the complete public contract.

For a site stored in a subdirectory, pass `documentRoot: '/workspace/site'`
alongside its script path. Defaults are a 30-second operation timeout, a
120-second startup timeout, a 64 MiB input limit and a 16 MiB output limit;
configure them when working with larger archives or slower installations.
PHP defaults to a 256 MiB memory limit and UTC.

Optional `hostCalls` handlers expose explicit asynchronous operations to PHP's
`php_wasm_host_call(name, payload)` function. Handlers exchange strings, normally
JSON. They must not call back into the same PHP instance. Immediate reentry is
rejected with `REENTRANT_CALL`; a callback that reenters after an `await` creates
a cycle bounded by the operation timeout. Unrelated requests arriving while a
host operation awaits IO are accepted into the normal serialized queue.

## MariaDB through PDO

Create a database with the independently released MariaDB bridge, then pass
`database.hostCalls` to `createPHP()`. PHP can use
`new PDO('mysql:dbname=joomla;charset=utf8mb4', 'root', '')` through the compiled
`pdo_mariadb_wasm` extension. The bridge supports one live PDO connection per
engine and emulated prepared statements; it does not provide `mysqli`.

See [MariaDB integration](docs/mariadb.md) for complete browser and Node.js
examples, persistence, failure recovery and matching release versions. The
combined browser application requires cross-origin isolation for MariaDB's
threads, even though PHP by itself does not.

## Static hosting and releases

The runtime serves as ordinary static JavaScript and WebAssembly, including
on GitHub Pages. Its PHP engine does not require a server, threads or special
cross-origin isolation headers. Use HTTPS or localhost for Web Crypto asset
verification. Persistent browser instances additionally require IndexedDB and
Web Locks.

If the embedding site sets a Content Security Policy, allow same-origin module
workers, `blob:` script imports, WebAssembly compilation (`'wasm-unsafe-eval'`)
and connections to the chosen asset origins. The loader imports the verified
JavaScript bytes; it does not bypass integrity checks with a second URL import.

Release assets contain the public API, all tested PHP engines, their licenses,
a runtime manifest, checksums and verification receipts. Extract the release
archive and serve its `package/` directory. Import `package/src/index.mjs` and
point `manifestUrl` at `package/runtime-manifest.json`. Keep these files from the
same release together. No npm publication is required.

Deploy each release under a versioned directory, for example
`runtimes/php-wasm/0.1.0/`, rather than replacing files from an earlier release
in place. This prevents browser and CDN caches from mixing release assets.

The playground can automatically resolve the latest stable GitHub release,
verify and test it, then copy its assets into a Pages deployment. Its deployment
must record the exact resolved version and hashes. Build inputs inside this
repository remain pinned so that updating one dependency is a reviewable change.

## Validation

```sh
npm run check
PHP_WASM_VERSION=8.4 npm run test:integration
npx playwright install --with-deps chromium firefox
PHP_WASM_VERSION=8.4 PHP_WASM_BROWSERS=chromium,firefox npm run test:browser
npm run prepare:mariadb
PHP_WASM_VERSION=8.4 npm run test:database
PHP_WASM_VERSION=8.4 PHP_WASM_BROWSERS=chromium,firefox npm run test:database:browser
```

Tests execute the compiled engine; they do not substitute mock PHP results.
Coverage includes CLI/HTTP mode switching, request isolation, sessions, fibers,
native extension operations, binary IO, worker termination and persisted files
across browser reloads. Missing build artifacts fail the test run.
The database suites run the compiled PDO driver inside PHP WASM against the
real MariaDB WASM worker, including transaction cleanup and browser persistence.

## Runtime boundaries

Browser PHP cannot spawn operating-system programs or connect through ordinary
native TCP sockets. Download installation packages with browser `fetch`, subject
to CORS, and write them into the virtual filesystem. A PHP extension being
compiled does not give it browser network access.

These are **wasm32 builds**: `PHP_INT_SIZE` is 4 and `PHP_INT_MAX` is 2147483647.
Applications requiring native 64-bit PHP integer semantics must account for
this difference; use strings or bcmath for larger integer values. OPcache, JIT
and preloading are disabled because their native shared-memory behavior is not
supported by this engine. Attempts to enable them through the API are rejected.

The native profile includes DOM/XML, mbstring, intl, ZIP/zlib, OpenSSL, GD, PDO
and the MariaDB bridge's PDO `mysql` driver. The database engine is a separate
release and requires its host handlers when PHP connects. Joomla and JCB still
need application-level installation and execution tests. GD's image profile
supports PNG, GIF and JPEG; WebP and FreeType are not compiled into this profile.

Read [architecture](docs/architecture.md), [security](SECURITY.md) and
[contribution guidance](CONTRIBUTING.md) before extending the runtime. Own code is
Apache-2.0; upstream PHP, linked libraries and compatibility patches retain their
respective licenses and notices.
