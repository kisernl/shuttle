# Deploy Shuttle on AWS Lightsail Container Service

Lightsail's container service runs your Docker image with optional persistent
storage. Since Shuttle already lives in AWS (SSM/IAM), this keeps everything
in one bill and one console — at the cost of more manual setup than
Railway/Render/Fly.

## 1. Build and push the image

Lightsail requires images in its own registry. From the repo root (Docker
required):

```bash
# create the container service first (step 2), then:
aws lightsail push-container-image \
  --service-name shuttle \
  --label shuttle \
  --image deploy/Dockerfile   # builds locally and pushes to the Lightsail registry
```

Or build + push manually to the registry endpoint shown in the Lightsail
console (**Containers → shuttle → Registry**).

## 2. Create the container service

Lightsail console → **Containers → Create container service**:

- Power: pick the smallest that fits (the app is light; 1 GB+ recommended
  for pnpm builds at deploy time — runtime is small).
- **Public endpoint**: enable HTTPS on port 80 → maps to container port 3000
  (set the container port when creating the deployment).
- **Private registry**: none needed once the image is pushed.

## 3. Enable persistent storage

In the service's **Storage** tab, attach a persistent disk and mount it at
`/data`. Without it SQLite is wiped on every redeploy. Note: disk-backed
services can't scale horizontally — fine for Shuttle (single instance anyway).

## 4. Environment variables

Service → **Environment variables** (or the deployment's env section):

```
PUBLIC_URL=https://<public-endpoint>.on.aws   # or custom domain
SESSION_SECRET=<openssl rand -hex 32>
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
ALLOWED_GITHUB_USERS=you
ADMIN_GITHUB_ORG=yourorg        # optional alternative
ADMIN_GITHUB_USERS=you
AWS_REGION=us-east-1
SHUTTLE_PREFIX=shuttle
PROTECTED_ENVS=production
TRUST_PROXY=true
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
```

`PORT` is already `3000` in the image config — no action needed.

## 5. Custom domain (optional)

Service → **Networking → Custom domains** → add `shuttle.example.com`, create
the CNAME/A record Lightsail shows. Update `PUBLIC_URL`.

## 6. GitHub OAuth callback

```
https://<your-domain>/api/auth/github/callback
```

## 7. AWS credentials

Lightsail containers have **no instance role** — the app needs explicit
credentials. Create an IAM user with the policies in `deploy/iam/`:

```bash
cd deploy/iam
./fill.sh <account-id> <region> shuttle
```

Attach `server-policy.filled.json` and optionally
`optional-check-policy.filled.json`, create an access key, and set
`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` above.

> Tip: you can scope this tighter than usual — the container only ever needs
> SSM on `parameter/shuttle/*` plus the optional IAM read checks.

## Updates

Re-run `aws lightsail push-container-image` after pulling new code, then create
a new deployment from the latest image in the console (or
`aws lightsail create-container-service-deployment`). Rollback = redeploy the
previous image tag.
