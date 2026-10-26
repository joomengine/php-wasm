#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
minor=${1:-8.4}
jq -e --arg minor "$minor" '.php[$minor]' "$ROOT/versions.json" >/dev/null
sdk_version=$(jq -r '.emscripten.version' "$ROOT/versions.json")
emcc --version | head -1 | grep -F " $sdk_version " >/dev/null || {
  printf 'Activate Emscripten %s using build/setup-emsdk.sh first.\n' "$sdk_version" >&2; exit 1;
}
BUILD=${BUILD:-"$ROOT/.build"}
mkdir -p "$BUILD"
BUILD=$(cd "$BUILD" && pwd)
export BUILD
# Native libraries, sources, and prefix are shared by local minor builds.
# GitHub's matrix uses separate workspaces and therefore still runs in parallel.
exec 8>"$BUILD/build.lock"
flock 8
# Autoconf's extensionless Emscripten probes use CommonJS. Do not let the
# package's browser-facing "type": "module" setting change those probes.
printf '{"type":"commonjs"}\n' > "$BUILD/package.json"
source "$ROOT/build/common.sh"
bash "$ROOT/build/dependencies.sh"
source_dir="$SOURCES/php-$minor"
fiber_patch="$ROOT/patches/php-$minor-fibers.patch"
fiber_fingerprint=$(sha256sum "$fiber_patch" | cut -d' ' -f1)
if [[ -f "$source_dir/.fibers-patched" ]] && [[ $(cat "$source_dir/.fibers-patched") != "$fiber_fingerprint" ]]; then
  # Restore the pinned upstream tree before applying a changed patch.
  rm -f "$source_dir/.source-ready"
fi
fetch_source ".php[\"$minor\"]" "$source_dir"
if [[ ! -f "$source_dir/.fibers-patched" ]]; then
  source_fingerprint=$(cat "$source_dir/.source-ready")
  rm -f "$source_dir/.source-ready"
  patch -d "$source_dir" -p1 --fuzz=0 --batch --forward < "$fiber_patch"
  printf '%s\n' "$fiber_fingerprint" > "$source_dir/.fibers-patched"
  printf '%s\n' "$source_fingerprint" > "$source_dir/.source-ready"
fi
output="$ROOT/dist/php/$minor"
mkdir -p "$output/licenses"
(
  cd "$source_dir"
  # Configure probes run in Node through emconfigure. Host libraries are
  # excluded by PKG_CONFIG_LIBDIR rather than detected accidentally.
  emconfigure ./configure PKG_CONFIG_PATH="$PKG_CONFIG_PATH" PKG_CONFIG_LIBDIR="$PKG_CONFIG_LIBDIR" \
    --prefix="$PREFIX/php-$minor" \
    --disable-all --disable-cli --disable-cgi --disable-phpdbg --enable-embed=static \
    --disable-fiber-asm --without-pcre-jit --disable-opcache-jit --without-pear \
    --with-config-file-path=/config --with-config-file-scan-dir=/config/conf.d \
    --enable-bcmath --enable-calendar --enable-ctype --enable-exif --enable-fileinfo \
    --enable-filter --enable-mbstring --enable-pdo --enable-phar --enable-session --enable-tokenizer \
    --with-iconv --with-openssl --with-zlib --with-zip --enable-intl --enable-gd --with-jpeg \
    --with-libxml --enable-dom --enable-simplexml --enable-xml --enable-xmlreader --enable-xmlwriter \
    ac_cv_func_fork=no ac_cv_func_vfork=no ac_cv_func_posix_spawn=no \
    php_cv_iconv_errno=yes php_cv_iconv_ignore=no
  emmake make -j"$JOBS" libphp.la
  includes=(-I. -I./main -I./Zend -I./TSRM -I./ext -I./ext/date/lib -I"$PREFIX/include")
  emcc -O2 "${includes[@]}" -c "$ROOT/native/runtime.c" -o "$BUILD/runtime-$minor.o"
  em++ -O2 "$BUILD/runtime-$minor.o" .libs/libphp.a \
    -L"$PREFIX/lib" -lzip -lpng16 -ljpeg -lxml2 -lonig -lssl -lcrypto -lz \
    -licuio -licui18n -licuuc -licudata -lm \
    --no-entry -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createPHP \
    -sENVIRONMENT=web,worker,node -sALLOW_MEMORY_GROWTH=1 \
    -sINITIAL_MEMORY=134217728 -sMAXIMUM_MEMORY=2147483648 -sSTACK_SIZE=16777216 \
    -sASYNCIFY=1 -sASYNCIFY_STACK_SIZE=131072 -sFORCE_FILESYSTEM=1 -sEXIT_RUNTIME=0 \
    -sINVOKE_RUN=0 -sASSERTIONS=1 -sWASM_BIGINT=1 -sDYNAMIC_EXECUTION=0 \
    '-sEXPORTED_FUNCTIONS=["_php_wasm_run","_php_wasm_exit_code","_php_wasm_abi_version","_php_wasm_version","_php_wasm_add_server_variable","_php_wasm_setenv","_malloc","_free"]' \
    '-sEXPORTED_RUNTIME_METHODS=["FS","IDBFS","ENV","ccall","cwrap","UTF8ToString","stringToUTF8","lengthBytesUTF8","HEAPU8"]' \
    '-sINCOMING_MODULE_JS_API=["wasmBinary","instantiateWasm","noInitialRun","locateFile","stdin","stdout","stderr","print","printErr","onAbort"]' \
    -lidbfs.js -o "$output/php.mjs"
)
cp -R "$BUILD/licenses/." "$output/licenses/"
mkdir -p "$output/licenses/php"
while IFS= read -r -d '' notice; do
  relative=${notice#"$source_dir/"}
  install -D -m 644 "$notice" "$output/licenses/php/$relative"
done < <(find "$source_dir" -type f \( -iname LICENSE -o -iname 'LICENSE.*' \
  -o -iname LICENCE -o -iname 'LICENCE.*' -o -iname COPYING -o -iname 'COPYING.*' \
  -o -iname COPYRIGHT -o -iname 'COPYRIGHT.*' -o -iname NOTICE -o -iname 'NOTICE.*' \) -print0)
cp "$ROOT/LICENSE" "$output/licenses/Apache-2.0.txt"
cp "$ROOT/patches/NOTICE" "$output/licenses/patches-NOTICE.txt"
emscripten_root=$(dirname "$(command -v emcc)")
mkdir -p "$output/licenses/emscripten"
cp "$emscripten_root/LICENSE" "$output/licenses/emscripten/LICENSE"
cp "$emscripten_root/system/lib/libc/musl/COPYRIGHT" "$output/licenses/emscripten/musl-COPYRIGHT"
cp "$emscripten_root/system/lib/libcxx/LICENSE.TXT" "$output/licenses/emscripten/libcxx-LICENSE.TXT"
cp "$emscripten_root/system/lib/libcxxabi/LICENSE.TXT" "$output/licenses/emscripten/libcxxabi-LICENSE.TXT"
cp "$emscripten_root/system/lib/compiler-rt/LICENSE.TXT" "$output/licenses/emscripten/compiler-rt-LICENSE.TXT"
if [[ -f "$emscripten_root/system/lib/libunwind/LICENSE.TXT" ]]; then
  cp "$emscripten_root/system/lib/libunwind/LICENSE.TXT" "$output/licenses/emscripten/libunwind-LICENSE.TXT"
fi
printf 'Built PHP %s: %s\n' "$(jq -r ".php[\"$minor\"].version" "$ROOT/versions.json")" "$output"
