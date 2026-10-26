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
