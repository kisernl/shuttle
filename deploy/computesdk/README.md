# Deploy Shuttle to a ComputeSDK sandbox

Runs Shuttle inside a persistent [ComputeSDK Platform](https://platform.computesdk.com)
sandbox. The platform router places the box on your org's providers or the
compute market — you need **one org API key**, no provider credentials.

## Setup

```bash
cd deploy/computesdk
pnpm install --ignore-workspace   # standalone package; --ignore-workspace keeps
                                  # pnpm from joining the repo's workspace
cp ../../deploy/.env.example .env # fill in (SESSION_SECRET: openssl rand -hex 32)
```

Get an org API key at <https://platform.computesdk.com> → **Settings → API keys**.

## Deploy

```bash
COMPUTE_API_KEY=cs_... node deploy.mjs --env-file .env
```

The script creates a sandbox (default `medium` = 2 vCPU / 4 GB), uploads the
repo source, installs Node 22 + pnpm if the image lacks them, builds the SPA
and server, starts `node server/dist/index.js` on port 3000, and prints the
public preview URL. Env vars go to the server process only — never baked into
the sandbox image.

## Options

| Flag               | Default                 | Purpose                                   |
| ------------------ | ----------------------- | ----------------------------------------- |
| `--size`           | `medium`                | `small`/`medium`/`large`/`xlarge`         |
| `--timeout-hours`  | `168`                   | sandbox lifetime; provider caps may apply |
| `--sandbox <id>`   | —                       | redeploy into an existing sandbox         |
| `--destroy <id>`   | —                       | tear down (stops billing)                 |
| `--disk <diskId>`  | —                       | mount an org disk at `/data` (see below)  |
| `--provider-order` | org default             | e.g. `market,blaxel,vercel`               |
| `--order-type`     | org default             | `market` or `limit`                       |
| `--max-price`      | —                       | e.g. `0.12/hour` for market limit orders  |
| `--label`          | `shuttle`               | sandbox label                             |
| `--env-file`       | `deploy/.env` or `.env` | env file (process env wins)               |

## Persistence

Two layers, pick per need:

- **Sandbox lifetime** — the box and its filesystem live until `timeout` or
  `destroy`. SQLite under `/data` survives restarts of the server process and
  redeploys into the same sandbox (`--sandbox <id>`).
- **Org disk** — pass `--disk <orgSlug>/<name>` to mount a persistent ComputeSDK
  disk at `/data`. The database then survives sandbox replacement entirely.
  Create/manage disks on the platform; `diskId` must be prefixed with your org
  slug.
- **Snapshots** — `compute sandboxes snapshot <id>` (CLI) captures the box for
  restore on providers that support it.

For anything beyond a personal/hobby deployment, prefer the Dockerfile-based
targets (`railway.json`, `render.yaml`, `fly.toml`) — sandboxes are billed per
wall-clock hour and are built for ephemeral compute.

## GitHub OAuth

Set the OAuth app's callback URL to
`https://<preview-url>/api/auth/github/callback`. Note that preview URLs can
change if the sandbox is recreated — update the callback when they do.
