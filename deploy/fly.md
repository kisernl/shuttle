# Deploy Shuttle on Fly.io

`fly.toml` at the repo root declares the Dockerfile build, the `/data` volume
mount, and non-secret env vars. Secrets go through `fly secrets`.

## 1. First-time setup

```bash
# install flyctl: https://fly.io/docs/hands-on/install-flyctl/
fly auth signup || fly auth login

fly apps create shuttle-<something-unique>   # app names are global; pick your own
```

Edit `fly.toml` and set `app = "shuttle-<something-unique>"` to match.

```bash
fly volumes create shuttle_data --size 1 --region <region>
```

## 2. Secrets and env vars

```bash
fly secrets set \
  PUBLIC_URL=https://shuttle-<you>.fly.dev \
  SESSION_SECRET=$(openssl rand -hex 32) \
  GITHUB_CLIENT_ID=... \
  GITHUB_CLIENT_SECRET=... \
  ALLOWED_GITHUB_USERS=you \
  ADMIN_GITHUB_USERS=you \
  AWS_REGION=us-east-1 \
  AWS_ACCESS_KEY_ID=... \
  AWS_SECRET_ACCESS_KEY=...
```

`TRUST_PROXY`, `PORT`, `SHUTTLE_PREFIX`, `PROTECTED_ENVS` are already in
`fly.toml`'s `[env]`.

Optional: `KMS_KEY_ID`, `ALLOWED_GITHUB_ORG` instead of/in addition to
`ALLOWED_GITHUB_USERS`.

## 3. Deploy

```bash
fly deploy
```

## 4. Custom domain (optional)

```bash
fly certs add shuttle.example.com
```

Then create the DNS records `fly certs show shuttle.example.com` prints, and
update `PUBLIC_URL` + redeploy (`fly secrets set PUBLIC_URL=...`).

## 5. GitHub OAuth callback

```
https://shuttle.example.com/api/auth/github/callback
# or https://<app>.fly.dev/api/auth/github/callback for the default domain
```

## 6. AWS credentials

Fly Machines have no instance roles — create an IAM user with the policies in
`deploy/iam/`:

```bash
cd deploy/iam
./fill.sh <account-id> <region> shuttle
```

## Notes

- Machines auto-stop when idle (`auto_stop_machines = "stop"` in `fly.toml`)
  and cold-start on the next request; SQLite persists on the volume. Set
  `auto_stop_machines = "off"` for always-on.
- `fly logs` for logs, `fly ssh console` to inspect the machine,
  `fly volumes list` for storage.
