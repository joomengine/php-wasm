#!/usr/bin/env bash
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
sdk=${1:?Usage: build/setup-emsdk.sh /path/to/emsdk}
version=$(jq -r '.emscripten.version' "$root/versions.json")
sdk_commit=$(jq -er '.emscripten.sdkCommit' "$root/versions.json")
if [[ ! -x "$sdk/emsdk" ]]; then
  mkdir -p "$sdk"
  git -C "$sdk" init -q
  git -C "$sdk" remote add origin https://github.com/emscripten-core/emsdk.git
fi
if [[ $(git -C "$sdk" rev-parse HEAD 2>/dev/null || true) != "$sdk_commit" ]]; then
  git -C "$sdk" fetch --depth 1 origin "$sdk_commit"
  git -C "$sdk" checkout --detach "$sdk_commit"
fi
TAR_OPTIONS="${TAR_OPTIONS:+$TAR_OPTIONS }--no-same-owner" "$sdk/emsdk" install "$version"
"$sdk/emsdk" activate "$version"
patch_file="$root/patches/emscripten-$version.patch"
if patch -d "$sdk/upstream/emscripten" -p1 --dry-run -R -s < "$patch_file"; then
  printf 'Emscripten compatibility patch already applied.\n'
else
  patch -d "$sdk/upstream/emscripten" -p1 --forward < "$patch_file"
fi
printf 'Activate this SDK with: source %q/emsdk_env.sh\n' "$sdk"
