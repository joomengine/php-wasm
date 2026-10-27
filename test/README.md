# Runtime integration tests

These tests execute the compiled PHP WebAssembly engine. They fail when artifacts
are missing; a mocked engine cannot satisfy the runtime suite.

From the repository root, after installing the build prerequisites:

```sh
npm ci
npm run build -- 8.4
npm run manifest -- --php 8.4
PHP_WASM_VERSION=8.4 PHP_WASM_MANIFEST=dist/runtime-manifest.json npm run test:integration
npx playwright install --with-deps chromium firefox
PHP_WASM_VERSION=8.4 PHP_WASM_MANIFEST=dist/runtime-manifest.json PHP_WASM_BROWSERS=chromium,firefox npm run test:browser
npm run prepare:mariadb
PHP_WASM_VERSION=8.4 PHP_WASM_MANIFEST=dist/runtime-manifest.json npm run test:database
PHP_WASM_VERSION=8.4 PHP_WASM_MANIFEST=dist/runtime-manifest.json PHP_WASM_BROWSERS=chromium,firefox npm run test:database:browser
```

Repeat with each supported PHP minor. Without `PHP_WASM_MANIFEST`, the test helper
hashes `dist/php/<minor>/php.mjs` and `php.wasm` and constructs a direct engine
descriptor using the exact PHP version in `versions.json`.
Builds must include `pdo_mariadb_wasm`; generating a new manifest for an old
pre-driver engine fails its engine-bound provenance check.

`runtime.test.mjs` exercises actual CLI and HTTP semantics, uploads, sessions,
native extensions, Fibers, asynchronous host calls, request isolation, concurrent
queueing, standard stream lifecycle, limits, asset integrity, and filesystem
boundaries. Native dependency versions must match the source catalog, and a gzip
forward-seek regression checks the zero-fill behavior of the patched zlib build.
Its repeated mixed-request test checks that declarations and globals
reset across CLI, HTTP, and fatal invocations. It is not a memory-leak proof or a
Joomla compatibility certification.

`browser.test.mjs` serves the runtime over ordinary local HTTP without isolation
headers. It verifies worker responsiveness, HTTP/CLI execution, independent
filesystems, IndexedDB restoration after reload, and exclusion of simultaneous
writers to the same persistent filesystem. CI runs Chromium and Firefox.
`PHP_WASM_BROWSERS` also accepts `webkit` for additional local coverage after
installing its Playwright browser.

`database.test.mjs` executes the native PDO `mysql` driver inside PHP WASM and
forwards its asynchronous host calls to a real MariaDB WASM worker. It covers
prepared bindings, binary bytes, Unicode, exact BIGINT/DECIMAL strings,
transactions, implicit commits, error metadata and Joomla's quoting convention.
Repeated CLI/HTTP requests verify that normal return, `exit` and fatal errors
release the connection lease and roll back open transactions. A timed-out PHP
worker is replaced only after explicitly resetting the surviving database.

`database-browser.test.mjs` runs the same combined execution in Chromium and
Firefox and reads committed SQL after a real page reload. Its separate test
server supplies COOP/COEP headers for MariaDB's threads; this does not change
the isolation-free PHP-only suite. Database tests accept only Chromium and
Firefox. They do not install Joomla or compile JCB.

`prepare:mariadb` downloads the exact bridge archive recorded in `versions.json`,
verifies its SHA-256 digest, release identity and file inventory, and stages it
under `.build/mariadb-bridge`. `PHP_WASM_MARIADB_DIR` can select another staging
directory inside `.build/`, whose contents must pass the same verification.
The database tests write successful-run receipts for Node.js and each browser.
The aggregate receipt and release packager require all three matching database receipts in
addition to the PHP-only suites, preventing untested engine/database pairs
from entering a release.

For a local browser installed outside Playwright's cache, set
`PHP_WASM_CHROMIUM_EXECUTABLE`, `PHP_WASM_FIREFOX_EXECUTABLE`, or
`PHP_WASM_WEBKIT_EXECUTABLE` to its absolute executable path. CI should normally
use Playwright's pinned browser binaries.
