# Contributing

Keep PHP execution, browser lifecycle and application provisioning separate.
Prefer a small explicit API over adding framework dependencies. Changes to the
C ABI must update the ABI version and be exercised through the public API.

Use the exact compiler and source inputs in `versions.json`. When changing an
upstream patch, record the origin and reason in `patches/README.md`, and rebuild
every supported PHP version. Do not edit generated engine files by hand.

Use the current security patch in each supported native-library branch and
review upstream security notices before a release. When a relevant fix has not
been released, keep any necessary backport small, attributed and tied to its
upstream commit. Verify observable library versions in the built engine as well
as the source catalog, so stale artifacts cannot masquerade as an update.

Run the repository checks and the real WebAssembly integration tests before
requesting review. Tests which only mock a PHP result cannot validate an engine
change. In particular, preserve coverage for CLI/HTTP mode switching, PHP
errors, repeated requests, fibers, binary IO, persistence and worker termination.

Application-specific functionality belongs in the playground or the database
bridge. A PHP module appearing in `get_loaded_extensions()` does not by itself
prove that all its system-dependent operations work in a browser.

Use conventional, reviewable pull requests with the problem, resulting behavior
and validation evidence. Do not label unexecuted checks as passing or publish a
stable release with skipped engine tests.

## Preparing and publishing a release

The tag, `package.json` and both root version fields in `package-lock.json`
must agree. A tag does not update these files. Prepare a new, unused stable
version on a branch before creating its tag:

```sh
npm run release:prepare -- 0.1.2
npm run release:check -- v0.1.2
npm run check
npm run test:release
```

`release:prepare` uses npm's version command to update both files without
creating a commit or tag, or running lifecycle scripts. Commit both files in a
pull request, let the complete runtime matrix pass, and merge it. Then fetch
and check out the merged commit and verify that its `main` workflow succeeded.
With a clean working tree at that exact tested commit, derive the tag from the
committed version instead of typing a second version number:

```sh
release_tag="v$(node -p 'require("./package.json").version')"
npm run release:check -- "$release_tag"
git tag -a "$release_tag" -m "PHP WASM $release_tag"
git push origin "refs/tags/$release_tag"
```

The tag triggers the Release workflow, which checks metadata, rebuilds and
tests every PHP engine in Node.js, Chromium and Firefox, verifies the archive,
and publishes the assets with provenance. Wait for that workflow to succeed;
a tag alone is not a usable runtime release. Let the workflow create the GitHub
release so it can attach the verified assets.

If a tag points to the wrong package version, retrying its workflow will fail
again: the tagged source has not changed. Preserve public tags and use a new,
unused version through the process above. In particular, `v0.1.1` points to
source declaring `0.1.0` and produced no release assets; `0.1.2` supersedes that
unsuccessful attempt. Do not move an existing tag or disable version checks to
make a release pass.
