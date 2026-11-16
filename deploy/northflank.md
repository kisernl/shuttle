# Deploy Shuttle on Northflank

Northflank has no repo config file — everything is declared in the dashboard
(or their API/Terraform provider). It builds `deploy/Dockerfile` from your Git
repo and supports persistent volumes and custom domains.

## 1. Create the service

1. Northflank dashboard → **Add new → Service** → connect your Git repo.
2. Build settings: **Dockerfile** build pack, path `deploy/Dockerfile`,
   context = repo root.
3. Deploy once — it will fail health checks until env vars are set.

## 2. Add a persistent volume (required)

Service → **Volumes → Add volume**, mount path `/data`. Without it the SQLite
database is wiped on every redeploy.

## 3. Environment variables

Service → **Variables**:

```
PUBLIC_URL=https://<service>.code.run         # or your custom domain
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

Optional: `KMS_KEY_ID`.

## 4. Domain

Service → **Ports/Domain** → add a custom domain, create the DNS record
Northflank shows. Update `PUBLIC_URL` to match.

## 5. GitHub OAuth callback

```
https://<your-domain>/api/auth/github/callback
```

## 6. AWS credentials

Northflank has no instance roles — create an IAM user with the policies in
`deploy/iam/`:

```bash
cd deploy/iam
./fill.sh <account-id> <region> shuttle
```

Attach `server-policy.filled.json` and optionally
`optional-check-policy.filled.json`, create an access key.

## Notes

- Deploys can be triggered from Git pushes (configure the repo link) or the
  **Deploy** button.
- Northflank also offers a Terraform provider and API if you want the service
  defined as code instead of clicks.
