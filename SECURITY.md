# Security policy

Report vulnerabilities privately using GitHub's **Report a vulnerability**
feature when it is enabled for this repository. Do not post exploit details,
credentials or private site data in a public issue. If private reporting is
unavailable, open an issue requesting a private contact without sensitive
details.

This runtime executes application code in a browser worker. Code and assets
delivered to a browser are visible to that browser's user. Never put production
credentials or private server secrets in a playground configuration, PHP file,
release asset or browser environment variable.

Run untrusted applications on a dedicated origin. A worker is useful for
responsiveness and terminating execution, but it is not a separate browser
origin. Application scripts within one PHP instance share its virtual files.
The runtime is not a multi-tenant server isolation system.

The release manifest must come from a trusted source. Its hashes detect damaged
or substituted assets only while the manifest itself remains trusted. Deploy
over HTTPS and restrict executable asset origins using the host's CSP. The
verified module loader requires permission to import its verified module bytes;
test a proposed CSP against the browser integration suite before deployment.

Persisted browser storage can contain application data and can be cleared by
the browser. Do not use it as the only copy of valuable data. Do not silently
reuse a storage key across incompatible application or runtime versions.

Upstream PHP, Emscripten and library updates must pass the build and execution
matrix before release. A supported PHP minor series is not a guarantee that an
older runtime release contains every subsequent security fix.
