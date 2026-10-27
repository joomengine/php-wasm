# Building the engine

The build compiles upstream PHP and its native libraries from source. The
attributed patches in `patches/` cover Zend fiber/Emscripten compatibility and
two upstream zlib security fixes awaiting a release. Their source commits and
licenses are recorded in `patches/NOTICE`. The runtime does not import a
WordPress or Joomla playground package.

On Ubuntu install `build-essential autoconf automake libtool pkg-config bison
re2c cmake ninja-build jq curl xz-utils unzip git`. Then:

```sh
bash build/setup-emsdk.sh "$PWD/.emsdk"
source .emsdk/emsdk_env.sh
bash build/build.sh 8.4
```

The other selectors are `8.3` and `8.5`. `versions.json` records exact PHP source
archives and their SHA-256 values, dependency archives or immutable Git commits,
the Emscripten toolchain version, and the MariaDB bridge release source commit.
The bridge remains independently versioned: its native PDO driver is fetched
from that immutable commit, copied into the PHP source tree, and compiled
statically after regenerating PHP configure files. Changing the driver invalidates
the PHP source/object cache. Change this catalog and run the native
integration suite before releasing an upgrade. Dependency source/build caches
are under `.build/` (override with `BUILD`); compilation defaults to four jobs
(override with `JOBS`).

Archive entries may include `fallbackUrls` for official mirrors serving the
same bytes. Downloads use bounded retries and HTTPS redirects, and each URL
must match the entry's SHA-256 before the archive enters the cache. Corrupt
cached archives are discarded and downloaded again. The zlib fallbacks were
checked against the checksum published at <https://zlib.net/>.

Run `node --test test/source-downloads.test.mjs` to exercise download failures,
retries, mirrors, and cache integrity. This local test uses Bash, curl, jq, tar,
and OpenSSL to create an ephemeral HTTPS fixture; it needs no public network.

Each engine produces `dist/php/<minor>/php.mjs`, `php.wasm`, and `licenses/`.
The final module is statically linked: no dynamically loaded PHP extension
packages, side-module ABI matrix, or separate ICU data fetch. PHP source licenses
and linked library licenses accompany each build; the repository's Apache-2.0
license applies to the project's own code, not to all bundled dependencies.

ICU is built twice: native host generators first, then the WASM library and data.
The result includes full locale data. This deliberately favors correctness and
one fetchable engine over minimal download size. ZIP supports deflate/store;
optional ZIP encryption and extra compression codecs are not enabled. GD has
PNG/GIF/JPEG support; WebP/FreeType are not compiled in this initial profile.

Oniguruma 6.9.10 supplies PHP's multibyte regular expressions. Its upstream
project ended maintenance on April 24, 2025; monitor PHP's
[replacement discussion](https://github.com/php/php-src/issues/18467) and review
security fixes independently until PHP provides a supported replacement.

There is no socket proxy or browser TCP server. HTTPS downloads should be made
by the JavaScript host and written to the virtual filesystem. OpenSSL supports
local cryptographic operations; including it does not bypass browser networking
restrictions. PDO core and the separately maintained `pdo_mariadb_wasm` extension
are compiled in. The extension registers PDO's `mysql` name and calls the
`mariadb.v1` host hook; do not enable PHP's socket-based `pdo_mysql` alongside it.
The MariaDB engine and JavaScript bridge run separately and must be supplied
by the application (see the integration example in the repository README).

Each successful link writes `mariadb-driver.json` beside the engine, recording
the exact bridge version, protocol, source commit, and resulting module/WASM
hashes. Manifest creation verifies this proof before advertising the PDO driver;
old PHP builds without the extension must be rebuilt. The native extension's
Apache-2.0 license and notices accompany the PHP artifacts. MariaDB itself is
not linked into the PHP binary.

Run `node --test test/extension-source.test.mjs` to check driver version validation,
source fingerprinting, staging, and failure recovery without compiling PHP.
The combined PHP WASM/MariaDB integration suites remain the required evidence
that the compiled driver works; successful staging alone is insufficient.

After building, run the package's real engine tests. They must use these locally
built artifacts; a fake module test is not evidence of a working PHP runtime.
