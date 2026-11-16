# Deploy Shuttle on Render

`render.yaml` is a Render Blueprint: it declares a Docker web service, a 1 GB
persistent disk at `/data`, and prompts for every secret at apply time.

## 1. Create the service

Render dashboard → **New → Blueprint** → connect this repo. Render reads
`render.yaml`, builds `deploy/Dockerfile`, creates the `shuttle-data` disk,
and prompts for each `sync: false` variable.

> Persistent disks require a paid instance (`starter` and up, ~$7/mo). The
> free tier has no disk and spins down — SQLite would not survive.

## 2. Fill in the prompted variables

Render asks for every `sync: false` key:

```
PUBLIC_URL=https://<service>.onrender.com   # or custom domain
SESSION_SECRET=<openssl rand -hex 32>
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
ALLOWED_GITHUB_USERS=you          # and/or ALLOWED_GITHUB_ORG=yourorg
ADMIN_GITHUB_USERS=you
AWS_REGION=us-east-1
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
KMS_KEY_ID=                        # optional, can stay empty
```

`PORT` is injected by Render; the app reads it automatically.
`TRUST_PROXY`, `SHUTTLE_PREFIX`, `PROTECTED_ENVS`, `NODE_ENV` are preset in
the blueprint.

## 3. Domain

Service → **Settings → Custom Domains** → add `shuttle.example.com` and create
the DNS record Render shows. Update `PUBLIC_URL` to match.

## 4. GitHub OAuth callback

```
https://shuttle.example.com/api/auth/github/callback
```

## 5. AWS credentials

Render has no instance roles — create an IAM user with the policies in
`deploy/iam/`:

```bash
cd deploy/iam
./fill.sh <account-id> <region> shuttle
```

Attach `server-policy.filled.json` and optionally
`optional-check-policy.filled.json`, create an access key.

## Updates

Pushes to the connected branch auto-deploy. Render keeps previous deploys for
rollback under the service's **Events/Deploys** history.
