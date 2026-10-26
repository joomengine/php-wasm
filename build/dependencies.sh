#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
BUILD=${BUILD:-"$ROOT/.build"}
mkdir -p "$BUILD"
BUILD=$(cd "$BUILD" && pwd)
exec 9>"$BUILD/dependencies.lock"
flock 9
source "$ROOT/build/common.sh"
fingerprint=$({ sha256sum "$ROOT/versions.json" "$ROOT/build/dependencies.sh" "$ROOT/build/common.sh" "$ROOT/build/setup-emsdk.sh" "$ROOT"/patches/emscripten-*.patch; emcc --version; printf '%s\n' "$CFLAGS" "$CXXFLAGS" "$CPPFLAGS" "$LDFLAGS"; } | sha256sum | cut -d' ' -f1)
if [[ -f "$BUILD/dependencies.ready" ]] && [[ $(cat "$BUILD/dependencies.ready") == "$fingerprint" ]]; then exit 0; fi
if [[ -f "$BUILD/dependencies.build-id" ]] && [[ $(cat "$BUILD/dependencies.build-id") != "$fingerprint" ]]; then
  rm -rf "$PREFIX" "$BUILD/icu-host" "$BUILD/icu-wasm" "$BUILD/licenses"
  for name in zlib openssl libxml2 libzip oniguruma icu libpng; do
    rm -rf "$SOURCES/$name" "$BUILD/obj-$name"
  done
  mkdir -p "$PREFIX" "$BUILD/licenses"
fi
printf '%s\n' "$fingerprint" > "$BUILD/dependencies.build-id"

for name in zlib openssl libxml2 libzip oniguruma icu libpng; do
  fetch_source ".libraries.$name" "$SOURCES/$name"
done

(cd "$SOURCES/zlib"; emconfigure ./configure --prefix="$PREFIX" --static; emmake make -j"$JOBS"; emmake make install)
cmake_library libpng -DPNG_SHARED=OFF -DPNG_TESTS=OFF -DPNG_TOOLS=OFF \
  -DZLIB_LIBRARY="$PREFIX/lib/libz.a" -DZLIB_INCLUDE_DIR="$PREFIX/include"
cmake_library oniguruma -DBUILD_TEST=OFF
cmake_library libxml2 -DLIBXML2_WITH_PROGRAMS=OFF -DLIBXML2_WITH_TESTS=OFF \
  -DLIBXML2_WITH_PYTHON=OFF -DLIBXML2_WITH_THREADS=OFF -DLIBXML2_WITH_ICONV=OFF \
  -DLIBXML2_WITH_ZLIB=ON -DLIBXML2_WITH_LZMA=OFF \
  -DZLIB_LIBRARY="$PREFIX/lib/libz.a" -DZLIB_INCLUDE_DIR="$PREFIX/include"
cmake_library libzip -DBUILD_TOOLS=OFF -DBUILD_REGRESS=OFF -DBUILD_EXAMPLES=OFF -DBUILD_DOC=OFF \
  -DENABLE_OPENSSL=OFF -DENABLE_GNUTLS=OFF -DENABLE_MBEDTLS=OFF \
  -DENABLE_BZIP2=OFF -DENABLE_LZMA=OFF -DENABLE_ZSTD=OFF \
  -DZLIB_LIBRARY="$PREFIX/lib/libz.a" -DZLIB_INCLUDE_DIR="$PREFIX/include"

(cd "$SOURCES/openssl"
  env CC=emcc CXX=em++ AR=emar RANLIB=emranlib CROSS_COMPILE= \
    ./Configure linux-generic32 no-shared no-asm no-threads no-dso no-module no-engine \
    no-tests no-apps no-ui-console no-dgram no-async -DNO_FORK \
    --prefix="$PREFIX" --libdir=lib
  emmake make -j"$JOBS" build_sw
  emmake make install_sw)

# ICU's generators execute on the build host; its library is cross-compiled.
mkdir -p "$BUILD/icu-host" "$BUILD/icu-wasm"
(cd "$BUILD/icu-host"
  env -u CC -u CXX -u AR -u RANLIB -u CPPFLAGS -u LDFLAGS \
    CFLAGS=-O2 CXXFLAGS=-O2 "$SOURCES/icu/source/configure" \
    --disable-tests --disable-samples --disable-shared --enable-static --with-data-packaging=static
  make -j"$JOBS")
(cd "$BUILD/icu-wasm"
  emconfigure "$SOURCES/icu/source/configure" --host=wasm32-unknown-emscripten \
    --with-cross-build="$BUILD/icu-host" --prefix="$PREFIX" --disable-shared --enable-static \
    --disable-tests --disable-samples --disable-extras --disable-tools \
    --disable-dyload --disable-plugins --with-data-packaging=archive --disable-renaming \
    icu_cv_host_frag=mh-linux \
    CFLAGS='-O2 -fPIC -DUCONFIG_NO_THREADS=1' CXXFLAGS='-O2 -fPIC -DUCONFIG_NO_THREADS=1'
  emmake make -j"$JOBS"
  emmake make install)

# Convert the whole portable archive into one WASM data object. ICU's native
# pkgdata default writes host ELF; its -w fallback compiles thousands of tiny
# objects serially. genccode emits portable C while keeping a single data file.
icu_version=$(jq -r '.libraries.icu.version' "$ROOT/versions.json")
icu_major=${icu_version%%.*}
mkdir -p "$BUILD/icu-embedded"
"$BUILD/icu-host/bin/genccode" -q -e "icudt$icu_major" -f icudata \
  -d "$BUILD/icu-embedded" "$PREFIX/share/icu/$icu_version/icudt${icu_major}l.dat"
emcc -O2 -I"$SOURCES/icu/source/common" -I"$BUILD/icu-wasm/common" \
  -c "$BUILD/icu-embedded/icudata.c" -o "$BUILD/icu-embedded/icudata.o"
rm -f "$PREFIX/lib/libicudata.a"
emar rcs "$PREFIX/lib/libicudata.a" "$BUILD/icu-embedded/icudata.o"

save_license zlib LICENSE README
save_license openssl LICENSE.txt NOTICE.md
save_license libxml2 Copyright COPYING
save_license libzip LICENSE
save_license oniguruma COPYING
save_license icu LICENSE
save_license libpng LICENSE
printf '%s\n' "$fingerprint" > "$BUILD/dependencies.ready"
