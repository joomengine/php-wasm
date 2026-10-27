# MariaDB through native PDO

Each PHP build includes the bridge's `pdo_mariadb_wasm` extension, registered
under PDO's `mysql` driver name. The driver sends `mariadb.v1` host calls through
PHP's Asyncify transport to a separate MariaDB WebAssembly worker. SQL is
executed by MariaDB; PHP is not using a SQL translator or a remote server.

The MariaDB engine and JavaScript bridge remain an independent release from
[joomengine/mariadb-wasm-bridge](https://github.com/joomengine/mariadb-wasm-bridge).
They are not bundled into the PHP runtime archive. `mysqli` is not provided.

## Choose a tested release pair

Use a PHP engine whose runtime-manifest entry contains
`extensions.pdo_mariadb_wasm`. This records the compiled bridge version,
protocol version and exact source commit. Adding a JavaScript host handler
cannot add the driver to an older PHP binary that lacks it.

`versions.json` pins the independently released bridge source and the SHA-256
digest of its database runtime archive. The build compiles that source into
PHP 8.3, 8.4 and 8.5, and tests the resulting engines against the matching
archive. Release receipts record the tested engine and bridge identities.

A downstream playground may resolve the latest stable release of each project
at build time. It must verify their checksums, check driver/protocol compatibility,
run its integration tests and record the exact selected versions and hashes.
Matching a protocol number alone does not prove application compatibility.
Deploy immutable versioned assets and keep each release's files together.

## Run a query in the browser or Node.js

Extract both release archives and arrange their contents relative to an
`app.mjs` file:

| Directory | Contents |
| --- | --- |
| `runtimes/php/` | Contents of the PHP archive's `package/`, including `src/`, `php/` and `runtime-manifest.json` |
| `runtimes/mariadb/` | Contents of the bridge archive's `mariadb-wasm-bridge-<version>/`, including `src/`, `vendor/` and `bridge-manifest.json` |

The following module works in Node.js 24 or later with `node app.mjs`, or as
`<script type="module" src="./app.mjs"></script>` on an appropriately isolated
browser page. Node uses ephemeral storage; the browser example enables both
stores' persistence. Bridge v0.1.1 loads its prepared engine from the archive's
`vendor/` directory by default in both environments.

```js
import { createPHP } from './runtimes/php/src/index.mjs';
import { createMariaDB } from './runtimes/mariadb/src/index.mjs';

const browser = typeof window !== 'undefined';
let database;
let php;

try {
  database = await createMariaDB({
    database: 'joomla',
    ...(browser ? { persistence: { key: 'example-php84-database' } } : {}),
  });
  php = await createPHP({
    manifestUrl: new URL('./runtimes/php/runtime-manifest.json', import.meta.url).href,
    phpVersion: '8.4',
    hostCalls: database.hostCalls,
    ...(browser ? { persistence: { key: 'example-php84-files' } } : {}),
  });

  await php.fs.writeFile('/workspace/database.php', `<?php
$pdo = new PDO('mysql:dbname=joomla;charset=utf8mb4', 'root', '', [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
]);
$pdo->exec('CREATE TABLE IF NOT EXISTS messages (
    id INT PRIMARY KEY AUTO_INCREMENT,
    body VARCHAR(255) NOT NULL
)');
$insert = $pdo->prepare('INSERT INTO messages (body) VALUES (:body)');
$insert->execute(['body' => 'Hello from PHP WASM']);
$id = $pdo->lastInsertId();
$select = $pdo->prepare('SELECT id, body FROM messages WHERE id = ?');
$select->execute([$id]);
echo json_encode($select->fetch(PDO::FETCH_ASSOC), JSON_THROW_ON_ERROR);
$select = $insert = null;
$pdo = null;
`);

  const result = await php.run({ script: '/workspace/database.php' });
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
  console.log(JSON.parse(new TextDecoder().decode(result.stdout)));

  // PHP has finished and released its PDO connection before checkpointing.
  await database.flush();
  await php.flush();
} finally {
  // Also closes the database if PHP startup or script execution fails.
  try { await php?.close(); }
  finally { await database?.close(); }
}
```

In a long-lived application, retain the two workers and invoke PHP repeatedly.
Each PHP invocation starts fresh request/module state while database contents
remain in the database worker. Pass host handlers only to the PHP instance
that owns that bridge; handlers must not call back into the same PHP instance.

## Browser hosting

PHP alone runs without cross-origin isolation. MariaDB's threaded engine
additionally requires a secure context, `crossOriginIsolated === true` and
`SharedArrayBuffer`. For a conventional same-origin deployment, serve the
application and its assets with:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Use HTTPS or localhost and serve JavaScript modules and WebAssembly with their
correct MIME types. Keep the assets on the same origin, or satisfy the chosen
COEP policy when loading cross-origin resources. Persistent browser instances
also require IndexedDB and Web Locks.

The database browser tests use a local server supplying these headers.
GitHub Pages requires a separate hosting/isolation integration, such as a
tested isolation service-worker arrangement owned by the playground. This
runtime does not install that service worker, and a plain Pages deployment
does not become isolated by importing the bridge.

## Connections, persistence and failures

The current bridge supports **one live PDO handle per database engine**.
Release the previous handle and any statements that reference it before
opening another. Use one bridge per trusted application instance. The DSN
database must match `createMariaDB({ database })`; use `utf8mb4`, user `root`
and an empty password for the embedded engine. These are not remote database
credentials or an application authentication mechanism.

Prepared statements are emulated by PDO. Results are buffered, and each query
contains one SQL statement. BIGINT and DECIMAL values remain strings so that
wasm32 PHP does not lose precision. Direct `mysqli` callers and native network
sockets are unsupported. See the bridge's
[protocol limitations](https://github.com/joomengine/mariadb-wasm-bridge/blob/main/docs/protocol.md)
for result-column, metadata and SQL-session restrictions.

Normal request shutdown releases the PDO lease and rolls back an unfinished
transaction, including shutdown after `exit` or a PHP fatal error. Keep the
database and its host handler alive until PHP cleanup finishes. Close PHP
before closing the database, using nested `finally` blocks as in the example.

If a PHP timeout or runtime failure forcibly kills its worker, destructors
cannot release the lease. Wait until that PHP worker has stopped, then call
`await database.reset()` on the surviving ready bridge before creating a new
PHP instance with its host handlers. `reset()` drains accepted work, rolls
back and releases the abandoned lease; it does not erase committed data or
fully reset every MariaDB session variable. If reset fails, close and replace
the affected bridge instead of using stale handles.

A database timeout terminates the database worker. Stop and replace the PHP
instance that held its connection, and recreate the database bridge. A timed-out
write may already have executed: its outcome is unknown, so do not automatically
replay it. Recovery must inspect durable application state before retrying.

After successful application work, explicitly flush both `database` and `php`.
Their IndexedDB stores are independent: these calls are **not an atomic
cross-store transaction**. Record a provisioning checkpoint only after every
required store has flushed successfully. Browser unload is not a durability
guarantee, and browser storage is not a backup.

## Validate a local build

After building the chosen PHP minor and generating its manifest:

```sh
npm run prepare:mariadb
PHP_WASM_VERSION=8.4 npm run test:database
npx playwright install --with-deps chromium firefox
PHP_WASM_VERSION=8.4 PHP_WASM_BROWSERS=chromium,firefox npm run test:database:browser
```

Repeat for every supported PHP minor. These tests exercise the native driver
inside PHP WASM against real MariaDB WASM, including request cleanup and
browser persistence. Full Joomla 5/6 installation and JCB execution remain
application-level tests for the playground; passing the database suites does
not establish those results.
