# Datto RMM MCP Server

MCP server for Datto RMM, enabling Claude to interact with your Datto RMM account.

## One-Click Deployment

> [!IMPORTANT]
> **Before you click:** this server depends on `@wyre-technology/node-datto-rmm`,
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

[![Deploy to DO](https://www.deploytodo.com/do-btn-blue.svg)](https://cloud.digitalocean.com/apps/new?repo=https://github.com/wyre-technology/datto-rmm-mcp/tree/main)

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/wyre-technology/datto-rmm-mcp)

> [!NOTE]
> The DigitalOcean target builds the full Docker image and runs the complete MCP
> server over HTTP — this is the recommended path for operators. This repo has no
> Cloudflare Workers entrypoint (`src/worker.ts`), so the Workers button is not a
> supported target yet; prefer DigitalOcean or the prebuilt container image
> (`ghcr.io/wyre-technology/datto-rmm-mcp`).

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

The server accepts credentials via environment variables:

| Variable | Description |
|----------|-------------|
| `DATTO_API_KEY` | Your Datto RMM API key |
| `DATTO_API_SECRET` | Your Datto RMM API secret |
| `DATTO_PLATFORM` | API platform: `pinotage`, `merlot`, `concord`, `vidal`, `zinfandel`, or `syrah` (default: `concord`) |

When used with the MCP Gateway, credentials are injected via `X_API_KEY` and `X_API_SECRET` environment variables.

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

| Tool | Description |
|------|-------------|
| `datto_list_devices` | List devices with optional site filter |
| `datto_find_device` | Find a device by hostname (exact or partial match) and resolve its UID |
| `datto_get_device` | Get device details by UID |
| `datto_list_alerts` | List open alerts with optional site filter |
| `datto_get_alert` | Get alert details by UID (renders as an interactive card in MCP Apps hosts) |
| `datto_resolve_alert` | Resolve an alert |
| `datto_list_sites` | List all sites |
| `datto_get_site` | Get site details |
| `datto_run_quickjob` | Run a quick job on a device |
| `datto_get_device_audit` | Get device audit data (full or software only) |

## Docker

### Use the prebuilt image (no build, no token)

```bash
docker pull ghcr.io/wyre-technology/datto-rmm-mcp:latest

docker run -p 8080:8080 \
  -e DATTO_API_KEY=xxx \
  -e DATTO_API_SECRET=xxx \
  -e DATTO_PLATFORM=concord \
  ghcr.io/wyre-technology/datto-rmm-mcp:latest
```

The image is public and pulls anonymously, so this path needs no GitHub token at all.

### Build from source

The build installs `@wyre-technology/node-datto-rmm` from GitHub Packages, which
requires a token even though the package is public (see
[One-Click Deployment](#one-click-deployment)). The `Dockerfile` takes it as the
`GITHUB_TOKEN` build arg — omit it and the build fails at `npm ci` with
`npm error 401 Unauthorized ... npm.pkg.github.com`:

```bash
docker build --build-arg GITHUB_TOKEN=$(gh auth token) -t datto-rmm-mcp .

docker run -p 8080:8080 \
  -e DATTO_API_KEY=xxx \
  -e DATTO_API_SECRET=xxx \
  -e DATTO_PLATFORM=concord \
  datto-rmm-mcp
```

The token is written to a temporary `.npmrc` that is deleted in the same layer, so
it is never baked into the image.

> [!NOTE]
> The image defaults to `MCP_TRANSPORT=http` on port 8080, so `-p 8080:8080` is
> required to reach it. Health check: `curl http://localhost:8080/health`.

## License

Apache-2.0
