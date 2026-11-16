# Deploy Shuttle on Railway

Railway builds `deploy/Dockerfile` via the `railway.json` at the repo root.
No Caddy needed — Railway terminates TLS and routes to `$PORT` automatically.

## 1. Create the service

1. Push this repo to GitHub.
2. Railway dashboard → **New Project → Deploy from GitHub repo** → select it.
   Railway reads `railway.json` and builds `deploy/Dockerfile`.
3. Wait for the first deploy (it will fail health checks until env vars are set — that's fine).

## 2. Add a persistent volume (required)

Service → **Settings → Volumes → New Volume**, mount path `/data`.

Without this, the SQLite database (users, sessions, projects, audit log) is
wiped on every redeploy.

## 3. Environment variables

Service → **Variables**:

```
PUBLIC_URL=https://<service>.up.railway.app   # or your custom domain
SESSION_SECRET=<openssl rand -hex 32>
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
ALLOWED_GITHUB_USERS=you          # and/or ALLOWED_GITHUB_ORG=yourorg
ADMIN_GITHUB_USERS=you
AWS_REGION=us-east-1
SHUTTLE_PREFIX=shuttle
PROTECTED_ENVS=production
TRUST_PROXY=true
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
```

Optional: `KMS_KEY_ID` if you use a customer-managed KMS key.

## 4. Domain

**Settings → Networking → Custom Domain** → e.g. `shuttle.example.com`, then
create the CNAME record Railway shows you. TLS is automatic. Update
`PUBLIC_URL` to match.

## 5. GitHub OAuth callback

GitHub OAuth App settings → callback URL:

```
https://shuttle.example.com/api/auth/github/callback
```

## 6. AWS credentials

Railway has no instance roles — create an IAM user with the policies in
`deploy/iam/`:

```bash
cd deploy/iam
./fill.sh <account-id> <region> shuttle
```

Attach `server-policy.filled.json` (SSM) and optionally
`optional-check-policy.filled.json` (read-only GitHub setup checks), create an
access key, and use it for `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`.

## Updates

Pushes to the connected branch auto-redeploy. To roll back, Railway keeps
previous deployments under **Deployments**.
