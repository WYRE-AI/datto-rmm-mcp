# Datto RMM MCP Server

MCP server for Datto RMM, enabling Claude to interact with your Datto RMM account.

## One-Click Deployment

> [!IMPORTANT]
> **Before you click:** this server depends on `@wyre-ai/node-datto-rmm`,
> which is hosted on the **GitHub Packages** npm registry. GitHub Packages has no
> anonymous access — even though the package is public, every `npm install` needs a
> token. The cloud builder runs `npm install` for you, so you must give it one, or
> the build fails with `npm error 401 Unauthorized ... npm.pkg.github.com`.
>
> 1. Create a GitHub **Personal Access Token** with the `read:packages` scope
>    ([classic token](https://github.com/settings/tokens/new?scopes=read:packages&description=datto-rmm-mcp%20deploy)).
>    Any GitHub account works — you do **not** need to be a member of the
>    `wyre-technology` org to read its public packages.
> 2. Add it as a build variable when prompted by the deploy flow:
>    - **Cloudflare Workers** → set a build variable named **`NODE_AUTH_TOKEN`** to your PAT
>      (Workers → Settings → Build → Variables and Secrets).
>    - **DigitalOcean App Platform** → set an encrypted env var named **`GITHUB_TOKEN`**
>      with scope **Build Time** to your PAT (the `.do/deploy.template.yaml` already declares it).
>      Also set a runtime secret **`CONDUIT_S2S_SECRET`** (`openssl rand -hex 32`).
>      HTTP exits if that value is missing or a known placeholder.

[![Deploy to DO](https://www.deploytodo.com/do-btn-blue.svg)](https://cloud.digitalocean.com/apps/new?repo=https://github.com/WYRE-AI/datto-rmm-mcp/tree/main)

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/WYRE-AI/datto-rmm-mcp)

> [!NOTE]
> The DigitalOcean target builds the full Docker image and runs the complete MCP
> server over HTTP — this is the recommended path for operators. This repo has no
> Cloudflare Workers entrypoint (`src/worker.ts`), so the Workers button is not a
> supported target yet; prefer DigitalOcean or the prebuilt container image
> (`ghcr.io/wyre-ai/datto-rmm-mcp`).

## Features

- **Device Management**: List, search, and get details for devices
- **Alert Management**: View and resolve alerts
- **Interactive Alert Card (MCP Apps)**: `datto_get_alert` renders as an interactive card in MCP Apps hosts (Claude Desktop/web) with an in-card "Resolve alert" round-trip; neutral by default, brandable via `window.__BRAND__` injection or `MCP_BRAND_*` env vars; plain-JSON behavior is unchanged in other hosts
- **Site Management**: List and view site details
- **Quick Jobs**: Run quick jobs on devices
- **Audit Data**: Retrieve full device audit or software inventory

## Installation

### Via MCP Gateway (Recommended)

This server is designed to work with the [MCP Gateway](https://github.com/wyre-technology/mcp-gateway) which handles authentication and credential management.

On HTTP, the gateway proves it is the caller with `X-Gateway-S2S`. The value is `t=<unix seconds>,v1=<hex hmac-sha256>`. The MAC is HMAC-SHA256 over the ASCII string `t=<unix seconds>` (the same prefix that appears in the header), keyed with `CONDUIT_S2S_SECRET`. The timestamp must be within 300 seconds of the server clock. A missing or invalid header is `401`. The secret is never written to logs.

#### Attributing jobs to the end user

Datto RMM records the API account that created a job and offers no way to
override it, so on a shared service account every quick job in the console
reads as the integration rather than the person who asked for it.

If the gateway sends an `X-Mcp-User-Upn` header, that identity is appended to
the job name, which is the only field that reaches the console's activity
list:

```
Restart Service [someone@example.com]
```

**Only honoured when `AUTH_MODE=gateway`.** Without a gateway in front, the
header is whatever the caller chose to send, so attributing a job to it would
look authoritative while being self-declared. It is advisory labelling in
either case and never affects authorization. Brackets and control characters
are stripped from the value, and it is length-capped, so the suffix cannot be
forged or made to corrupt the name.

### Local Development

This server's `@wyre-technology/*` dependencies live on the **GitHub Packages** npm
registry, which requires a token even for public packages. Authenticate once, then install:

```bash
# Authenticate npm to GitHub Packages (token needs the read:packages scope)
export NODE_AUTH_TOKEN=$(gh auth token)   # or a PAT with read:packages

npm install
npm run build
npm start
```

The repo's `.npmrc` already points the `@wyre-technology` scope at GitHub Packages and
reads the token from `NODE_AUTH_TOKEN`, so no further config is needed.

## Configuration

Copy [`.env.example`](.env.example). Stdio and `AUTH_MODE=env` read vendor credentials from the environment. Gateway mode does not.

| Variable | Required | Description |
|----------|----------|-------------|
| `DATTO_API_KEY` | For stdio and `AUTH_MODE=env` | Datto RMM API key |
| `DATTO_API_SECRET` | For stdio and `AUTH_MODE=env` | Datto RMM API secret |
| `DATTO_PLATFORM` | No | API platform: `pinotage`, `merlot`, `concord` (default), `vidal`, `zinfandel`, or `syrah` |
| `MCP_TRANSPORT` | No | `stdio` (default) or `http` |
| `AUTH_MODE` | No | `env` (image default) or `gateway` (Compose default). Gateway mode requires `X-Datto-API-Key` and `X-Datto-API-Secret` on each `/mcp` request and never falls back to `DATTO_*`. `env` uses those variables only after S2S auth succeeds. |
| `CONDUIT_S2S_SECRET` | Yes for HTTP | Service-to-service secret. The HTTP server logs an error and exits non-zero when this is empty or a known placeholder (`changeme`, `placeholder`, `your-s2s-secret`, `replace-with-a-real-secret`, and the other example values in code). Compose will not start without it. Never commit a real value. Generate one with `openssl rand -hex 32`. |
| `MCP_ALLOW_INSECURE_DEV` | No | Set to exactly `1` only for local development to start HTTP without `CONDUIT_S2S_SECRET`. The process logs a warning and does not enforce `X-Gateway-S2S`. The listener is forced to `127.0.0.1`. A non-loopback `MCP_HTTP_HOST` (including `0.0.0.0`) refuses to start. A known placeholder still refuses to start; unset the secret to use this bypass. |
| `MCP_HTTP_HOST` | No | Bind address when `MCP_TRANSPORT=http`. With a real `CONDUIT_S2S_SECRET`, this is honored and defaults to `0.0.0.0` when unset, so container deploys stay unchanged. The container image sets `0.0.0.0`. |
| `MCP_HTTP_PORT` | No | HTTP port. Defaults to `8080`. |

`/health` stays unauthenticated and does not read credentials. The stdio transport does not use `CONDUIT_S2S_SECRET`.

When used with the MCP Gateway in single-tenant `AUTH_MODE=env`, credentials may also be injected via `X_API_KEY` and `X_API_SECRET` environment variables. That path still requires a valid `X-Gateway-S2S` header on HTTP.

### HTTP authentication

With `MCP_TRANSPORT=http` and `CONDUIT_S2S_SECRET` set, every `/mcp` request must include `X-Gateway-S2S: t=<unix seconds>,v1=<hex hmac-sha256 of the string t=...>`. A missing or invalid header returns 401 before any vendor credential is read.

In `AUTH_MODE=gateway`, `/mcp` also requires `X-Datto-API-Key` and `X-Datto-API-Secret` (`X-Datto-Platform` is optional). Those headers are the only credential source for that request. A request missing them returns 401 and does not fall back to `DATTO_API_KEY` / `DATTO_API_SECRET`.

### Platform Selection

Datto RMM uses regional API endpoints. Select the platform that matches your account:

| Platform | Region/Description |
|----------|-------------------|
| `pinotage` | South Africa |
| `merlot` | Europe |
| `concord` | US East (default) |
| `vidal` | Canada |
| `zinfandel` | US West |
| `syrah` | Australia |

## Available Tools

Tools that only read data from Datto RMM carry `annotations: { readOnlyHint: true }`
in their `tools/list` definition. Clients that support this MCP hint (e.g.
Microsoft 365 Copilot / Copilot Studio) can use it to skip the per-call
confirmation prompt for those tools. Tools that create, update, resolve, or
run anything are never annotated as read-only.

| Tool | Description | Read-only |
|------|-------------|-----------|
| `datto_list_devices` | List devices with optional site filter | Yes |
| `datto_find_device` | Find a device by hostname (exact or partial match) and resolve its UID | Yes |
| `datto_get_device` | Get device details by UID | Yes |
| `datto_list_alerts` | List open alerts with optional site filter | Yes |
| `datto_get_alert` | Get alert details by UID (renders as an interactive card in MCP Apps hosts) | Yes |
| `datto_resolve_alert` | Resolve an alert | No |
| `datto_list_sites` | List all sites | Yes |
| `datto_get_site` | Get site details | Yes |
| `datto_list_components` | List components (find a componentUid and its expected `variables` for datto_run_quickjob), optionally by name substring | Yes |
| `datto_run_quickjob` | Run a quick job on a device (returns a job UID for use with the job tools below) | No |
| `datto_get_job` | Get status/details for a quick job by UID | Yes |
| `datto_get_job_components` | Get the components that make up a quick job | Yes |
| `datto_get_job_results` | Get a quick job's result for a specific device | Yes |
| `datto_get_job_stdout` | Get a quick job's captured stdout for a specific device | Yes |
| `datto_get_job_stderr` | Get a quick job's captured stderr for a specific device | Yes |
| `datto_get_device_audit` | Get device audit data (full or software only) | Yes |
| `datto_get_device_patches` | Get Windows patch installation status for a device | Yes |
| `datto_get_site_patches` | Get Windows patch installation status across all devices in a site | Yes |

## Docker

### Use the prebuilt image (no build, no token)

The image listens on `0.0.0.0` inside the container (`MCP_HTTP_HOST`) and defaults to `AUTH_MODE=env`. Publish the port on loopback and pass the S2S secret. HTTP refuses to start when `CONDUIT_S2S_SECRET` is empty or a known placeholder.

```bash
docker pull ghcr.io/wyre-ai/datto-rmm-mcp:latest

docker run \
  -e CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" \
  -e DATTO_API_KEY=xxx \
  -e DATTO_API_SECRET=xxx \
  -e DATTO_PLATFORM=concord \
  -p 127.0.0.1:8080:8080 \
  ghcr.io/wyre-ai/datto-rmm-mcp:latest
```

The image is public and pulls anonymously, so this path needs no GitHub token at all.

Gateway mode does not read those vendor variables. Credentials arrive on each request, and the request must also carry `X-Gateway-S2S` signed with `CONDUIT_S2S_SECRET`:

```bash
docker run \
  -e CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" \
  -e AUTH_MODE=gateway \
  -p 127.0.0.1:8080:8080 \
  ghcr.io/wyre-ai/datto-rmm-mcp:latest
```

Compose refuses to start when `CONDUIT_S2S_SECRET` is unset, sets `AUTH_MODE=gateway`, does not inject `DATTO_API_KEY` or `DATTO_API_SECRET`, and publishes `127.0.0.1:8080:8080`:

```bash
CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" docker compose up
```

### Build from source

The build installs `@wyre-ai/node-datto-rmm` from GitHub Packages, which
requires a token even though the package is public (see
[One-Click Deployment](#one-click-deployment)). The `Dockerfile` takes it as the
`GITHUB_TOKEN` build arg — omit it and the build fails at `npm ci` with
`npm error 401 Unauthorized ... npm.pkg.github.com`:

```bash
docker build --build-arg GITHUB_TOKEN=$(gh auth token) -t datto-rmm-mcp .

docker run \
  -e CONDUIT_S2S_SECRET="$CONDUIT_S2S_SECRET" \
  -e DATTO_API_KEY=xxx \
  -e DATTO_API_SECRET=xxx \
  -e DATTO_PLATFORM=concord \
  -p 127.0.0.1:8080:8080 \
  datto-rmm-mcp
```

The token is written to a temporary `.npmrc` that is deleted in the same layer, so
it is never baked into the image.

> [!NOTE]
> The image defaults to `MCP_TRANSPORT=http` on port 8080. Publish it on loopback
> (`-p 127.0.0.1:8080:8080`) unless a proxy sits in front. Health check:
> `curl http://127.0.0.1:8080/health` (no credentials). HTTP will not start until
> `CONDUIT_S2S_SECRET` is a real secret.

Local HTTP without a secret is development-only. It binds `127.0.0.1` and logs a warning. A non-loopback `MCP_HTTP_HOST` makes startup exit:

```bash
MCP_TRANSPORT=http MCP_ALLOW_INSECURE_DEV=1 npm start
```

## License

Apache-2.0
