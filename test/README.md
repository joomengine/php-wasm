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
```

Repeat with each supported PHP minor. Without `PHP_WASM_MANIFEST`, the test helper
hashes `dist/php/<minor>/php.mjs` and `php.wasm` and constructs a direct engine
descriptor using the exact PHP version in `versions.json`.

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

For a local browser installed outside Playwright's cache, set
`PHP_WASM_CHROMIUM_EXECUTABLE`, `PHP_WASM_FIREFOX_EXECUTABLE`, or
`PHP_WASM_WEBKIT_EXECUTABLE` to its absolute executable path. CI should normally
use Playwright's pinned browser binaries.
