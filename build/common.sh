#!/usr/bin/env bash
# Source after defining ROOT and BUILD. All artifacts are pinned in versions.json.
JOBS=${JOBS:-4}
PREFIX="$BUILD/prefix"
SOURCES="$BUILD/sources"
mkdir -p "$PREFIX" "$SOURCES" "$BUILD/downloads" "$BUILD/licenses"
export PKG_CONFIG_LIBDIR="$PREFIX/lib/pkgconfig:$PREFIX/share/pkgconfig"
export PKG_CONFIG_PATH="$PKG_CONFIG_LIBDIR"
export CFLAGS="-O2 -fPIC"
export CXXFLAGS="-O2 -fPIC"
export CPPFLAGS="-I$PREFIX/include"
export LDFLAGS="-L$PREFIX/lib"

fetch_source() {
  local key=$1 destination=$2 repository commit url digest archive fingerprint
  fingerprint=$(jq -ceS "$key" "$ROOT/versions.json" | sha256sum | cut -d' ' -f1)
  if [[ -f "$destination/.source-ready" ]] && [[ $(cat "$destination/.source-ready") == "$fingerprint" ]]; then
    return
  fi
  # A new lock entry must never reuse an old or partly extracted source tree.
  [[ "$destination" == "$SOURCES/"* && "$destination" != "$SOURCES/" ]] || {
    printf 'Refusing source replacement outside %s: %s\n' "$SOURCES" "$destination" >&2
    return 1
  }
  rm -rf -- "$destination"
  repository=$(jq -r "$key.repository // empty" "$ROOT/versions.json")
  if [[ -n "$repository" ]]; then
    commit=$(jq -er "$key.commit" "$ROOT/versions.json")
    mkdir -p "$destination"
    git -C "$destination" init -q
    git -C "$destination" fetch --depth 1 "$repository" "$commit"
    git -C "$destination" checkout --detach FETCH_HEAD
    [[ $(git -C "$destination" rev-parse HEAD) == "$commit" ]]
  else
    url=$(jq -er "$key.url" "$ROOT/versions.json")
    digest=$(jq -er "$key.sha256" "$ROOT/versions.json")
    archive="$BUILD/downloads/$digest.tar"
    if [[ ! -f "$archive" ]]; then
      curl --fail --location --retry 5 --connect-timeout 30 "$url" -o "$archive.tmp"
      mv "$archive.tmp" "$archive"
    fi
    printf '%s  %s\n' "$digest" "$archive" | sha256sum --check
    mkdir -p "$destination"
    tar --extract --file "$archive" --directory "$destination" --strip-components=1 --no-same-owner
  fi
  printf '%s\n' "$fingerprint" > "$destination/.source-ready"
}

cmake_library() {
  local name=$1
  shift
  emcmake cmake -S "$SOURCES/$name" -B "$BUILD/obj-$name" -G Ninja \
    -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$PREFIX" \
    -DCMAKE_INSTALL_LIBDIR=lib -DBUILD_SHARED_LIBS=OFF "$@"
  cmake --build "$BUILD/obj-$name" --parallel "$JOBS"
  cmake --install "$BUILD/obj-$name"
}

save_license() {
  local name=$1; shift
  mkdir -p "$BUILD/licenses/$name"
  local file
  for file in "$@"; do
    [[ ! -f "$SOURCES/$name/$file" ]] || cp "$SOURCES/$name/$file" "$BUILD/licenses/$name/$(basename "$file")"
  done
}
