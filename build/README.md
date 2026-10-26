# Building the engine

The build compiles upstream PHP and its native libraries from source. The only
vendored compatibility code is the attributed Zend fiber/Emscripten patches in
`patches/`. The runtime does not import a WordPress or Joomla playground package.

On Ubuntu install `build-essential autoconf automake libtool pkg-config bison
re2c cmake ninja-build jq curl xz-utils unzip git`. Then:

```sh
bash build/setup-emsdk.sh "$PWD/.emsdk"
source .emsdk/emsdk_env.sh
bash build/build.sh 8.4
```

The other selectors are `8.3` and `8.5`. `versions.json` records exact PHP source
archives and their SHA-256 values, dependency archives or immutable Git commits,
and the Emscripten toolchain version. Change this catalog and run the native
integration suite before releasing an upgrade. Dependency source/build caches
are under `.build/` (override with `BUILD`); compilation defaults to four jobs
(override with `JOBS`).

Each engine produces `dist/php/<minor>/php.mjs`, `php.wasm`, and `licenses/`.
The final module is statically linked: no dynamically loaded PHP extension
packages, side-module ABI matrix, or separate ICU data fetch. PHP source licenses
and linked library licenses accompany each build; the repository's Apache-2.0
license applies to the project's own code, not to all bundled dependencies.

ICU is built twice: native host generators first, then the WASM library and data.
The result includes full locale data. This deliberately favors correctness and
one fetchable engine over minimal download size. ZIP supports deflate/store;
optional ZIP encryption and extra compression codecs are not enabled. GD has
PNG/GIF support; JPEG/WebP/FreeType are not compiled in this initial profile.

There is no socket proxy or browser TCP server. HTTPS downloads should be made
by the JavaScript host and written to the virtual filesystem. OpenSSL supports
local cryptographic operations; including it does not bypass browser networking
restrictions. PDO core is compiled, but a MariaDB PDO driver is a separate
project and must be integrated and tested before claiming Joomla installation.

After building, run the package's real engine tests. They must use these locally
built artifacts; a fake module test is not evidence of a working PHP runtime.
