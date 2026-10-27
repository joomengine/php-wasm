# Runtime architecture

This repository owns the PHP execution layer for JoomEngine. It builds official
PHP source into WebAssembly using Emscripten and supplies a small JavaScript API.
Its build and release lifecycle is independent of application playground packages.

## Boundaries

| Layer | Owns | Does not own |
| --- | --- | --- |
| `native/` | C SAPI adapter, PHP request lifecycle, binary input/output | Joomla installation or browser UI |
| `build/`, `patches/`, `versions.json` | Compiler inputs, upstream compatibility patches, engine artifacts | Floating upstream source revisions |
| `src/` | Worker lifecycle, serialized calls, verified artifact loading, filesystem and persistence | SQL dialect conversion or application authentication |
| `mariadb-wasm-bridge` repository | Database engine integration and a real PHP database driver | PHP source releases |
| `playground` repository | Joomla recipes, extension installation, routing, sessions, version controls | Building PHP on each page visit |

Each PHP instance has one dedicated worker and one virtual filesystem. Calls
are serialized because the PHP engine and its request globals are not reentrant.
CLI execution uses the CLI SAPI name, argument vectors and standard streams;
HTTP execution supplies request metadata and returns status, repeated response
headers and binary bodies. These modes are tested in the same instance so that
one request cannot leave PHP globals or execution mode behind for the next.

JavaScript imports and WebAssembly binaries are verified against the release
manifest before use. A worker that exceeds its timeout or suffers a runtime
failure is discarded. PHP script errors are distinguishable from a broken
engine; a normal PHP error must not silently kill future requests.

## Files and persistence

Application files live under `/workspace`. The JavaScript filesystem API checks
paths before forwarding them to Emscripten. This is an API invariant, not a
security boundary between PHP scripts in the same instance: all such scripts
share that instance's virtual filesystem.

Browser persistence is opt-in and backed by IndexedDB. `flush()` is the explicit
durability boundary. A successful PHP request is not itself evidence that the
browser has persisted its changes. Do not rely on asynchronous writes completing
during tab unload, and do not treat browser storage as a backup.

Use a separate persistence key for each playground instance and PHP/application
version combination. Version switching should provision a new instance until
the playground explicitly supports and tests a migration path. IndexedDB keys
are scoped to an origin; a key is not an access-control credential.

## Versioning and supply chain

The public JavaScript API and native ABI are versioned separately in release
metadata. Exact PHP patch versions, compiler versions and dependency sources
are recorded in `versions.json`; source downloads are integrity checked.
Compatibility patches are checked into this repository with attribution.

The playground may follow the latest stable release automatically. Its update
workflow should resolve that release to immutable assets and checksums, run the
Joomla integration suite, and deploy only after that suite passes. Fetching an
unreviewed floating branch during a browser visit defeats this design.

Releasing this runtime requires real PHP execution tests and combined
PHP-WASM/PDO/MariaDB-WASM tests in Node.js, Chromium and Firefox. Test receipts
bind the engine hashes, compiled driver source and independently released
database archive to the tested source commit. Releasing the playground
additionally requires real Joomla and component installation tests. Passing
this repository's tests alone cannot certify Joomla or JCB compatibility.

## Hosting and operating-system limits

GitHub Pages can serve the JavaScript and `.wasm` files as static assets. PHP
runs on the visitor's device. There is no server process, Docker daemon, shell,
shared database service or private server-side environment on Pages.

The PHP engine uses Asyncify rather than pthreads, so its own runtime does not
require cross-origin isolation. The separate MariaDB engine uses threads and
requires a secure, cross-origin-isolated browser context with
`SharedArrayBuffer`. The combined test server supplies COOP/COEP headers.
Providing equivalent isolation on GitHub Pages belongs to the playground's
hosting integration; see [MariaDB integration](mariadb.md).

Install ZIPs through browser `fetch` and write the bytes into the runtime before
invoking PHP. Native PHP TCP sockets and native `curl` are not a browser network
transport. Cross-origin downloads must satisfy the source server's CORS policy.
Package mirrors can instead be staged alongside the playground during its build.

## Extension and Joomla orchestration

The runtime exposes PHP execution, not a configuration language for Joomla.
The playground validates its recipe and then provisions in this order:

1. Resolve a tested PHP/Joomla combination and create an isolated instance.
2. Initialize the database and verify that its PHP driver can connect.
3. Install Joomla and the packages selected by Joomla major version.
4. Execute configured Joomla console commands sequentially as argument arrays.
5. Optionally create a normal Joomla administrator session.
6. Open the configured frontend or administrator route.

Toolbar visibility, permitted version changes, landing route and automatic
login remain independent options. Commands intended only for first installation
must not rerun against a restored site. Record completed provisioning steps and
surface failures without reporting a partly provisioned site as ready.

The database boundary uses the bridge's **statically compiled**
`pdo_mariadb_wasm` extension, registered as PDO `mysql`. The build pins the
bridge source release to an exact Git commit in `versions.json`, copies its
native files into each PHP source tree and regenerates PHP's configuration.
An engine-bound build marker prevents old artifacts from acquiring new driver
metadata without rebuilding. Runtime manifests record the driver release,
protocol and source commit. Native PHP `.so` loading is not part of this runtime.

The bridge retains ownership of its driver source and JavaScript database
assets. Tests download its separately released archive using the pinned SHA-256
digest and verify its file inventory. The playground can resolve the latest
stable releases at deployment time, but must verify and test the selected
PHP/database pair and record immutable versions and hashes.

The native PDO driver calls `php_wasm_host_call()` using `mariadb.v1`; this
transport suspends PHP through Asyncify while a separate database worker runs
SQL. Pass `database.hostCalls` when creating PHP. A bridge owns one connection
lease, so each application instance should own one bridge and one PHP worker.
Normal PHP request cleanup closes the PDO lease and rolls back an open
transaction. If PHP is forcibly terminated, the embedding application must
stop that worker, reset the surviving bridge, then create replacement PHP.

Flush both the PHP filesystem and database explicitly after successful work.
They use independent stores and provide no atomic cross-store transaction.
The integration covers Joomla's PDO database path; `mysqli` remains
unsupported. Joomla 5/6 installation and the chosen extension packages still
require their own application-level tests.
