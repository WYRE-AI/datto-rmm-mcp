## [Unreleased]

### Security

- **Cross-tenant elicitation/confirmation misroute (gateway mode).** The
  "server reference" used by elicitation helpers (`src/utils/elicitation.ts`
  — `elicitSelection` / `elicitText` / `elicitConfirmation`) was stored in a
  module-level `let _server: Server | null` singleton in
  `src/utils/server-ref.ts`, set synchronously per request via
  `setServerRef(server)` (called from `createMcpServer()` in
  `src/mcp-server.ts`) and read back later via `getServerRef()` — including
  after `await` gaps inside async tool handlers (e.g. after awaiting a
  Datto RMM API call, before sending an elicitation/confirmation prompt
  back through "the" server — as `datto_list_devices` and
  `datto_list_alerts` do when asking the user to narrow by site).
  - **Impact:** in gateway (multi-tenant HTTP) mode — `AUTH_MODE=gateway`
    — a fresh `Server` is created per inbound request (Node HTTP in
    `src/index.ts`, and the Cloudflare Workers entrypoint in
    `src/worker.ts`), so two concurrent tenant requests could race through
    the shared global: tenant A's request sets the ref and starts awaiting
    async work; before A resumes, tenant B's request runs and overwrites
    the module-level ref with B's server/transport; when A's awaited work
    resolves and it reads the ref back to call `elicitInput`, it gets B's
    server — so A's elicitation/confirmation prompt is sent down B's
    connection instead of A's (or vice versa, depending on timing). Same
    shared-mutable-state-across-await-gaps bug class as
    liongard-mcp#58, ninjaone-mcp#71, and halopsa-mcp#65, but in the
    server/transport routing subsystem for elicitation, not
    credential/token caching.
  - **Fix:** replaced the module-level singleton with an
    `AsyncLocalStorage<Server>` context in `src/utils/server-ref.ts`:
    `runWithServerRef(server, fn)` binds `server` to the async context for
    per-request transports (Node HTTP, Workers), and `bindServerRef(server)`
    binds it for the process lifetime in the single-session stdio
    transport. `getServerRef()` now reads from the ALS context instead of
    a shared variable, so it is correctly scoped to the request that
    created it and survives arbitrary `await` gaps without observing a
    concurrent request's server. There is no module-level mutable
    server/transport state left in `src/utils/server-ref.ts`. Call sites
    updated: `src/mcp-server.ts` (`createMcpServer` no longer calls
    `setServerRef`), `src/index.ts` (Node HTTP handler wraps the
    connect/handleRequest/catch chain in `runWithServerRef`; stdio calls
    `bindServerRef` once at startup), `src/worker.ts` (Workers `fetch`
    handler wraps the connect/handleRequest chain in `runWithServerRef`).
  - **Regression test:** `src/__tests__/server-ref.test.ts` forces a
    deterministic interleave (a manually-resolved "gate" promise, not a
    timing stagger) where tenant A binds its server and suspends on an
    await gap, tenant B's entire request runs to completion in the
    meantime, and only then does tenant A resume and elicit. The test
    asserts by value which tenant's mock `elicitInput` actually received
    each message. Verified to fail with the exact predicted symptom
    (`expected 'tenant-B' to be 'tenant-A'`) against a reinstated
    module-singleton implementation, and to pass against the ALS-based fix.

### Added

- **Interactive alert card via MCP Apps (SEP-1865).** A new `datto_get_alert` tool fetches a single alert by UID, and its results render as an interactive card in MCP Apps hosts (Claude Desktop/web, and other hosts advertising the `io.modelcontextprotocol/ui` extension), instead of a wall of JSON. The card shows the alert type (label-resolved from the alert context via the SDK's `ALERT_CONTEXT_TYPES` mapping), priority, status, device hostname, site name, category, timestamp, and message — and includes a working "Resolve alert" round-trip that calls `datto_resolve_alert` from inside the card. Non-App hosts are unaffected: the tool's JSON payload is the raw alert plus a new `_card` field.
  - The two renderable tools (`datto_get_alert`, `datto_resolve_alert`) advertise the UI via `_meta` (`ui/resourceUri`, plus the nested `ui.resourceUri` form) pointing at a new `ui://datto-rmm/alert-card.html` resource served as `text/html;profile=mcp-app`. The server now declares the `resources` capability and answers `resources/list` / `resources/read` for the card.
  - The card is **neutral by default** and brandable via `window.__BRAND__` injection or `MCP_BRAND_*` environment variables (`MCP_BRAND_NAME`, `MCP_BRAND_LOGO_URL`, `MCP_BRAND_PRIMARY_COLOR`, `MCP_BRAND_ACCENT_COLOR`, `MCP_BRAND_BG`, `MCP_BRAND_TEXT`), applied at serve time by replacing the card's `BRAND_INJECT` marker. No branding configured = the HTML is served unchanged and the card renders with no brand identity.
  - The card HTML is a self-contained vite single-file bundle embedded at build time (`src/generated/alert-card-html.ts`, committed), so it serves identically from stdio, Node HTTP, and the fs-less Cloudflare Workers runtime.
  - The card payload builder is best-effort: a sparse or unrecognized alert degrades the card (or drops it) without affecting the tool result. New contract tests in `test/mcp-apps.test.ts` drive the real Worker transport to pin the `_meta` advertisement, the `ui://` resource wire shape, and the `_card` normalization.
  - New `npm run build:ui` regenerates the embedded HTML after editing `ui/` (requires the new `vite`, `vite-plugin-singlefile`, and `@modelcontextprotocol/ext-apps` devDependencies); plain `npm run build` and CI are unaffected.
- **`datto_find_device` tool:** lightweight device lookup by hostname (exact or
  partial match, optional site filter, configurable max results) that resolves a
  hostname to a device UID plus a compact summary (site, online status, internal
  IP, OS, last seen, portal URL). Uses the Datto RMM API's server-side hostname
  filter instead of enumerating the full device inventory. Returns an explicit
  "No devices found" error on zero matches rather than an empty success.
  Idea and original implementation by [@DDePuy2015](https://github.com/DDePuy2015)
  in [#54](https://github.com/wyre-technology/datto-rmm-mcp/pull/54).

### Fixed

- **SDK:** bumped `@wyre-technology/node-datto-rmm` to
  [v1.0.5](https://github.com/wyre-technology/node-datto-rmm/releases/tag/v1.0.5),
  which reads HTTP response bodies exactly once. Previously a failed first read left
  error responses swallowed as `{}`, hiding the API's actual error message; failing
  requests now surface a descriptive error instead. Same pattern as
  [connectwise-automate-mcp#54](https://github.com/wyre-technology/connectwise-automate-mcp/issues/54),
  where the fix class originated.
- **Deploy buttons:** authenticate against the GitHub Packages npm registry during
  one-click cloud builds. The `@wyre-technology/node-datto-rmm` dependency lives on
  GitHub Packages, which has no anonymous read, so `npm install` failed with
  `401 Unauthorized` on DigitalOcean. Operators now supply a `read:packages` PAT as a
  build variable (`GITHUB_TOKEN` build-time secret for DigitalOcean, `NODE_AUTH_TOKEN`
  for Cloudflare Workers). The `.npmrc` reads the token and `.do/deploy.template.yaml`
  declares the build-time secret.
- **Dockerfile:** switched GitHub Packages auth from a BuildKit `--mount=type=secret`
  npmrc mount to an `ARG GITHUB_TOKEN` + temporary `.npmrc` pattern. DigitalOcean App
  Platform injects build-time env vars but does not support `docker build --secret`, so
  the prior approach could not authenticate during a one-click deploy.
  Part of the fleet-wide fix mirroring wyre-technology/ninjaone-mcp#35.

### Changed

- **Publishing:** the package now publishes to the GitHub Packages npm registry
  (`@semantic-release/npm` `npmPublish: true`), aligning with the rest of the
  `@wyre-technology` fleet.

## [1.3.4](https://github.com/wyre-technology/datto-rmm-mcp/compare/v1.3.3...v1.3.4) (2026-04-07)


### Bug Fixes

* **ci:** deploy :latest tag, force revision via env var bump ([dbfb639](https://github.com/wyre-technology/datto-rmm-mcp/commit/dbfb63927ae6dea8862ea828467bdc554ca7fd5c))

## [1.3.3](https://github.com/wyre-technology/datto-rmm-mcp/compare/v1.3.2...v1.3.3) (2026-04-06)


### Bug Fixes

* add defensive null checks to prevent MCP text: undefined errors ([65dfe5e](https://github.com/wyre-technology/datto-rmm-mcp/commit/65dfe5eda301036b813eb49b21e63d753c025a85)), closes [wyre-technology/msp-claude-plugins#43](https://github.com/wyre-technology/msp-claude-plugins/issues/43)

## [1.3.2](https://github.com/wyre-technology/datto-rmm-mcp/compare/v1.3.1...v1.3.2) (2026-04-06)


### Bug Fixes

* move npm prune to builder stage for GitHub Packages auth ([41cfa26](https://github.com/wyre-technology/datto-rmm-mcp/commit/41cfa26266788583559e55b12c228b717f87de3d))

## [1.3.1](https://github.com/wyre-technology/datto-rmm-mcp/compare/v1.3.0...v1.3.1) (2026-03-31)


### Bug Fixes

* **deploy:** replace node_compat with nodejs_compat for Wrangler v4 ([752a249](https://github.com/wyre-technology/datto-rmm-mcp/commit/752a24921f3517bbf9dffca00d30ac96116aef8e))

# [1.3.0](https://github.com/wyre-technology/datto-rmm-mcp/compare/v1.2.0...v1.3.0) (2026-03-10)


### Features

* **elicitation:** add MCP elicitation support with graceful fallback ([fca1479](https://github.com/wyre-technology/datto-rmm-mcp/commit/fca14798350c78a5e84a95b28481bdf0a65c84b1))

# [1.2.0](https://github.com/wyre-technology/datto-rmm-mcp/compare/v1.1.1...v1.2.0) (2026-03-02)


### Bug Fixes

* **ci:** add GitHub Packages auth for npm ci ([574198b](https://github.com/wyre-technology/datto-rmm-mcp/commit/574198b1d17ffc688c9ac502635b4689ace8c67c))
* **ci:** convert pack-mcpb.js to ESM imports ([eb2f349](https://github.com/wyre-technology/datto-rmm-mcp/commit/eb2f349fc5ae0dc640961777b52e189bf3f09dc5))
* **ci:** fix broken YAML in Discord notification step ([8670d5e](https://github.com/wyre-technology/datto-rmm-mcp/commit/8670d5ece681b99f5ab43d0e5f93ea1d19815b16))
* **ci:** move Discord notification into release workflow ([63fe7f1](https://github.com/wyre-technology/datto-rmm-mcp/commit/63fe7f1ead2412c214a3ade591f1abcc6344f21c))
* **ci:** update lock file and bump node to 22 ([f44d087](https://github.com/wyre-technology/datto-rmm-mcp/commit/f44d0874d5947c3a40370f565d89c5a7dccf4ecf))
* **docker:** drop arm64 platform to fix QEMU build failures ([260696b](https://github.com/wyre-technology/datto-rmm-mcp/commit/260696bce3fe3870a938e9e83b7b7724e62f84d4))
* escape newlines in .releaserc.json message template ([a075b20](https://github.com/wyre-technology/datto-rmm-mcp/commit/a075b20f372c57198523b379a7df7251872f4746))
* quote MCPB bundle filename to prevent shell glob expansion failure ([fb01e0b](https://github.com/wyre-technology/datto-rmm-mcp/commit/fb01e0b19cd61b8f96863a297362e1589b51770b))
* rename duplicate step id 'version' to 'release-version' in docker job ([02889f8](https://github.com/wyre-technology/datto-rmm-mcp/commit/02889f85566e957012e90f2e82ef7083e6398b97))
* use Docker build secret for GitHub Packages auth in Dockerfile ([c3f17a5](https://github.com/wyre-technology/datto-rmm-mcp/commit/c3f17a58f923d2908f6aa491f39ad501a4441be2))
* use stateless per-request server pattern for HTTP transport ([802cf57](https://github.com/wyre-technology/datto-rmm-mcp/commit/802cf576c72791ac701befe8ba822f26fe7f46f9))


### Features

* add HTTP transport + gateway auth mode support ([036320d](https://github.com/wyre-technology/datto-rmm-mcp/commit/036320d131575b0e78842b8c5b0b8992cfefc7e5))
* add MCPB manifest for desktop installation ([93393d5](https://github.com/wyre-technology/datto-rmm-mcp/commit/93393d5e2c63f8a8771ac8c3af03ba68ed115a48))
* add MCPB pack script ([69ccd84](https://github.com/wyre-technology/datto-rmm-mcp/commit/69ccd842c3315f9cd7fee72278b733de44440fbf))
* add mcpb packaging support ([578ca6d](https://github.com/wyre-technology/datto-rmm-mcp/commit/578ca6dd19a89c62cf872d67ea40afca204f01a3))
* add mcpb packaging support ([bae3423](https://github.com/wyre-technology/datto-rmm-mcp/commit/bae34233dbd70045397a083736f5b7589f5f718c))
* add mcpb packaging support ([a94b358](https://github.com/wyre-technology/datto-rmm-mcp/commit/a94b3584ec5237546b86f10cd8e1263bf5ea4c13))
* add mcpb packaging support ([fae6e8f](https://github.com/wyre-technology/datto-rmm-mcp/commit/fae6e8f0ac6ea9a74252e03eb2f689bac4d29906))
* add mcpb packaging support ([dd5a8c8](https://github.com/wyre-technology/datto-rmm-mcp/commit/dd5a8c8cbc8e2904b4533600af4ea494acf7e8c4))

# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial release of Datto RMM MCP server
- Device management tools: `datto_list_devices`, `datto_get_device`
- Alert management tools: `datto_list_alerts`, `datto_resolve_alert`
- Site management tools: `datto_list_sites`, `datto_get_site`
- Quick job execution: `datto_run_quickjob`
- Audit data retrieval: `datto_get_device_audit`
- Support for all 6 Datto RMM platforms
- Docker support
- CI/CD with GitHub Actions
- Semantic release automation
