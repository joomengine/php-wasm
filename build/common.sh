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

download_archive() (
  # A subshell keeps cleanup local, including failed conditional callers.
  local key=$1 digest=$2 archive=$3 url temporary
  shift 3
  [[ "$digest" =~ ^[a-f0-9]{64}$ && $# -gt 0 ]] || {
    printf 'Invalid archive source configuration for %s.\n' "$key" >&2
    return 1
  }
  if [[ -f "$archive" ]]; then
    if printf '%s  %s\n' "$digest" "$archive" | sha256sum --check --status; then
      printf 'Using verified archive for %s: %s\n' "$key" "$archive"
      return 0
    fi
    printf 'Discarding corrupt cached archive for %s: %s\n' "$key" "$archive" >&2
    rm -f -- "$archive" || return
  fi
  temporary=$(mktemp "$archive.part.XXXXXX") || return
  trap 'rm -f -- "$temporary"' EXIT
  for url in "$@"; do
    [[ "$url" == https://* ]] || {
      printf 'Source URL for %s must use HTTPS: %s\n' "$key" "$url" >&2
      return 1
    }
    printf 'Downloading %s from %s\n' "$key" "$url"
    if curl --fail --location --silent --show-error \
        --proto '=https' --proto-redir '=https' \
        --retry 3 --retry-all-errors --retry-connrefused --retry-delay 2 \
        --retry-max-time 120 --connect-timeout 20 --max-time 180 \
        --url "$url" --output "$temporary"; then
      if printf '%s  %s\n' "$digest" "$temporary" | sha256sum --check --status; then
        mv -f -- "$temporary" "$archive" || return
        printf 'Verified archive for %s (SHA-256 %s).\n' "$key" "$digest"
        return 0
      fi
      printf 'SHA-256 mismatch for %s from %s; rejecting download.\n' "$key" "$url" >&2
    else
      printf 'Download failed for %s from %s; trying the next configured source.\n' "$key" "$url" >&2
    fi
  done
  printf 'No verified archive could be downloaded for %s (SHA-256 %s).\n' "$key" "$digest" >&2
  return 1
)

fetch_source() {
  local key=$1 destination=$2 repository commit digest archive fingerprint source_spec url_list
  local -a urls
  source_spec=$(jq -ceS "$key" "$ROOT/versions.json") || return
  fingerprint=$(printf '%s\n' "$source_spec" | sha256sum | cut -d' ' -f1) || return
  if [[ -f "$destination/.source-ready" ]] && [[ $(cat "$destination/.source-ready") == "$fingerprint" ]]; then
    return
  fi
  # A new lock entry must never reuse an old or partly extracted source tree.
  [[ "$destination" == "$SOURCES/"* && "$destination" != "$SOURCES/" ]] || {
    printf 'Refusing source replacement outside %s: %s\n' "$SOURCES" "$destination" >&2
    return 1
  }
  rm -rf -- "$destination" || return
  repository=$(jq -r "$key.repository // empty" "$ROOT/versions.json") || return
  if [[ -n "$repository" ]]; then
    commit=$(jq -er "$key.commit" "$ROOT/versions.json") || return
    printf 'Fetching %s from %s at %s\n' "$key" "$repository" "$commit"
    mkdir -p "$destination" || return
    git -C "$destination" init -q || return
    git -C "$destination" fetch --depth 1 "$repository" "$commit" || return
    git -C "$destination" checkout --detach FETCH_HEAD || return
    [[ $(git -C "$destination" rev-parse HEAD) == "$commit" ]] || return
  else
    url_list=$(jq -er "$key | [.url] + (.fallbackUrls // []) | .[]" "$ROOT/versions.json") || return
    mapfile -t urls <<< "$url_list"
    digest=$(jq -er "$key.sha256" "$ROOT/versions.json") || return
    archive="$BUILD/downloads/$digest.tar"
    download_archive "$key" "$digest" "$archive" "${urls[@]}" || return
    mkdir -p "$destination" || return
    tar --extract --file "$archive" --directory "$destination" --strip-components=1 --no-same-owner || return
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
