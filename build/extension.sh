#!/usr/bin/env bash
# Sourced by build.sh after common.sh. Driver code remains owned and versioned
# by mariadb-wasm-bridge; only its pinned native sources enter PHP's static build.

pdo_mariadb_fingerprint() {
  local driver_dir=$1 expected_version actual_version
  expected_version=$(jq -er '.extensions.pdo_mariadb_wasm.version' "$ROOT/versions.json") || return
  actual_version=$(jq -er '.version' "$driver_dir/package.json") || return
  [[ "$actual_version" == "$expected_version" ]] || {
    printf 'MariaDB bridge source version %s does not match %s.\n' "$actual_version" "$expected_version" >&2
    return 1
  }
  [[ $(jq -r '.extensions.pdo_mariadb_wasm.protocolVersion' "$ROOT/versions.json") == 1 ]] || {
    printf 'This runtime supports MariaDB bridge protocol 1.\n' >&2
    return 1
  }
  # Include actual copied bytes as well as the lock entry and staging recipe.
  # This also catches local source changes in a previously fetched tree.
  {
    jq -ceS '.extensions.pdo_mariadb_wasm' "$ROOT/versions.json" || return
    sha256sum "$ROOT/build/extension.sh" "$driver_dir/native/config.m4" \
      "$driver_dir/native/pdo_mariadb_wasm.c" "$driver_dir/native/php_pdo_mariadb_wasm.h" \
      "$driver_dir/LICENSE" "$driver_dir/NOTICE" || return
  } | sha256sum | cut -d' ' -f1
}

stage_pdo_mariadb() {
  local php_dir=$1 driver_dir=$2 fingerprint=$3 source_fingerprint
  if [[ -f "$php_dir/.pdo-mariadb-staged" ]] && \
      [[ $(cat "$php_dir/.pdo-mariadb-staged") == "$fingerprint" ]]; then
    return
  fi
  source_fingerprint=$(cat "$php_dir/.source-ready") || return
  # A failed copy or buildconf leaves the entire PHP source cache invalid.
  rm -f "$php_dir/.source-ready" "$php_dir/.pdo-mariadb-staged" || return
  rm -rf -- "$php_dir/ext/pdo_mariadb_wasm" || return
  mkdir -p "$php_dir/ext/pdo_mariadb_wasm" || return
  cp "$driver_dir/native/config.m4" "$driver_dir/native/pdo_mariadb_wasm.c" \
    "$driver_dir/native/php_pdo_mariadb_wasm.h" "$php_dir/ext/pdo_mariadb_wasm/" || return
  (cd "$php_dir" && ./buildconf --force) || return
  printf '%s\n' "$fingerprint" > "$php_dir/.pdo-mariadb-staged" || return
  printf '%s\n' "$source_fingerprint" > "$php_dir/.source-ready"
}
