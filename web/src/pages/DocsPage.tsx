import type { Me } from "@/lib/api";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-base font-semibold">{title}</h2>
      <div className="space-y-2 text-sm text-muted-foreground">{children}</div>
    </section>
  );
}

function K({ children }: { children: React.ReactNode }) {
  return <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">{children}</code>;
}

function Steps({ children }: { children: React.ReactNode }) {
  return <ol className="list-decimal space-y-2 pl-5">{children}</ol>;
}

function EnvTable() {
  const rows: [string, string, string][] = [
    ["PUBLIC_URL", "https://shuttle.example.com", "Public base URL. Must be https:// (http only for localhost). Used for OAuth redirect and links."],
    ["SESSION_SECRET", "openssl rand -hex 32", "Signs session cookies. Generate a long random value."],
    ["GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET", "from OAuth App", "Credentials for the GitHub OAuth App (see Setup step 3)."],
    ["ALLOWED_GITHUB_USERS", "alice,bob", "Comma-separated GitHub logins allowed to sign in. Required unless ALLOWED_GITHUB_ORG is set."],
    ["ALLOWED_GITHUB_ORG", "my-org", "Alternative to ALLOWED_GITHUB_USERS: allow everyone in a GitHub org."],
    ["ADMIN_GITHUB_USERS", "alice", "Comma-separated logins that become admins. Admins are fixed here — not assignable in the UI."],
    ["AWS_REGION", "us-east-1", "Region for Parameter Store calls."],
    ["SHUTTLE_PREFIX", "shuttle", "Top-level SSM path segment. Secrets live under /{prefix}/{project}/{env}/."],
    ["KMS_KEY_ID", "alias/my-key", "Optional customer-managed KMS key for SecureStrings. Defaults to the AWS-managed alias/aws/ssm."],
    ["PROTECTED_ENVS", "production", "Comma-separated env names treated as protected (typed confirmation + restricted-editor block)."],
    ["AWS credentials", "env vars or IAM role", "Standard AWS SDK chain: AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, or the role on the instance/task/pod. Not stored in Shuttle."],
    ["DATA_DIR", "/data", "Where SQLite lives. Mount a volume here in Docker."],
    ["PORT", "3000", "HTTP port the API listens on."],
    ["TRUST_PROXY", "true", "Set true when behind a reverse proxy (Caddy) so rate limits see real client IPs."],
    ["LOG_LEVEL", "info", "debug | info | warn | error."],
  ];
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b bg-muted/50 text-muted-foreground">
            <th className="px-3 py-2 font-medium">Variable</th>
            <th className="px-3 py-2 font-medium">Example</th>
            <th className="px-3 py-2 font-medium">What it does</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([name, example, desc]) => (
            <tr key={name} className="border-b last:border-0 align-top">
              <td className="px-3 py-2"><K>{name}</K></td>
              <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{example}</td>
              <td className="px-3 py-2 text-muted-foreground">{desc}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DocsPage({ me }: { me: Me }) {
  void me;
  return (
    <div className="max-w-2xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">How Shuttle works</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Shuttle is a self-hosted web app that puts a simple <K>.env</K>-style interface over AWS
          SSM Parameter Store. You manage secrets in a browser; the actual secret values live in
          your AWS account as SecureStrings, encrypted with KMS. The app's database never holds a
          secret value — only users, sessions, an audit log, and GitHub mappings.
        </p>
      </div>

      <nav className="rounded-md border bg-muted/30 p-3 text-sm">
        <p className="mb-1 font-medium text-foreground">Contents</p>
        <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
          <li><a className="underline" href="#mental-model">Mental model</a></li>
          <li><a className="underline" href="#setup">Setup, step by step</a></li>
          <li><a className="underline" href="#daily-use">Daily use</a></li>
          <li><a className="underline" href="#roles">Roles and protected environments</a></li>
          <li><a className="underline" href="#github-actions">GitHub Actions (OIDC)</a></li>
          <li><a className="underline" href="#for-agents">For agents and automation</a></li>
          <li><a className="underline" href="#security">Security notes</a></li>
          <li><a className="underline" href="#reference">Reference</a></li>
        </ul>
      </nav>

      <Section title="Mental model">
        <p id="mental-model">
          Three layers, each with a single job:
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>AWS Parameter Store</strong> is the source of truth. Every secret is a
            SecureString parameter at <K>/{"{prefix}"}/{"{project}"}/{"{env}"}/{"{KEY}"}</K> — for
            example <K>/shuttle/myapp/production/DATABASE_URL</K>.
          </li>
          <li>
            <strong>The Shuttle server</strong> (Fastify) is the only thing that talks to AWS. It
            authenticates you via GitHub OAuth, checks your role, calls SSM, and writes an audit
            log entry. Secret values pass through its memory for the duration of a request and are
            never persisted.
          </li>
          <li>
            <strong>SQLite</strong> (on a mounted volume) holds only metadata: users, sessions,
            project/environment definitions, GitHub owner mappings, and the audit log.
          </li>
        </ul>
        <p>
          Consequence: if Shuttle is down, your secrets are unaffected — they are ordinary SSM
          parameters. Anything that can call AWS (CLI, SDK, CloudTrail-audited automation) can read
          them directly. Conversely, deleting Shuttle's database loses no secrets.
        </p>
      </Section>

      <Section title="Setup, step by step (admins)">
        <p id="setup">
          Do these once when deploying Shuttle. The full variable list is in{" "}
          <a className="underline" href="#reference">Reference</a> below.
        </p>
        <Steps>
          <li>
            <strong>Deploy the app.</strong> From <K>deploy/</K>: <K>cp .env.example .env</K>, fill
            in the values, set <K>SESSION_SECRET</K> (<K>openssl rand -hex 32</K>), then{" "}
            <K>docker compose up -d</K>. Caddy terminates TLS automatically.
          </li>
          <li>
            <strong>Give the server AWS credentials.</strong> Either attach an IAM role to the
            instance/task/pod, or set <K>AWS_ACCESS_KEY_ID</K> / <K>AWS_SECRET_ACCESS_KEY</K> in the
            environment. Shuttle uses the standard AWS SDK credential chain — there is no AWS
            config inside the app.
          </li>
          <li>
            <strong>Attach the IAM policy.</strong> The policy only allows{" "}
            <K>parameter/{"{prefix}"}/*</K> (plus account-wide <K>ssm:DescribeParameters</K>, which
            AWS cannot path-scope). Grab the exact JSON from the <strong>Setup</strong> page after
            login, or use <K>deploy/iam/</K> with <K>fill.sh</K>. If you set{" "}
            <K>KMS_KEY_ID</K> to a customer-managed key, also grant{" "}
            <K>kms:GenerateDataKey</K> and <K>kms:Decrypt</K> on that key.
          </li>
          <li>
            <strong>Create a GitHub OAuth App.</strong> github.com → Settings → Developer settings →
            OAuth Apps. Homepage URL: your <K>PUBLIC_URL</K>. Callback URL:{" "}
            <K>{"{PUBLIC_URL}"}/api/auth/github/callback</K>. Put the client ID/secret in the env.
          </li>
          <li>
            <strong>Allow users.</strong> Set <K>ALLOWED_GITHUB_USERS</K> (comma-separated logins)
            or <K>ALLOWED_GITHUB_ORG</K>, and <K>ADMIN_GITHUB_USERS</K> for whoever should manage
            users, audit log, GitHub settings, and setup.
          </li>
          <li>
            <strong>Verify.</strong> Sign in as an admin, open <strong>Setup</strong>, and click{" "}
            <strong>Run checks</strong>. It probes real SSM permissions (list, write, read, delete,
            history) against a throwaway parameter — your real secrets are untouched.
          </li>
          <li>
            <strong>Create your first project.</strong> Projects → New project. Environments default
            to <K>development</K>, <K>staging</K>, <K>production</K>.
          </li>
        </Steps>
        <p>
          Running locally for development? <K>pnpm install && pnpm dev</K> starts Vite on :5173
          proxying <K>/api</K> to the server on :3000. See the README for LocalStack and test-login
          details.
        </p>
      </Section>

      <Section title="Daily use">
        <p id="daily-use">
          Secrets are organized as <strong>project → environment → key</strong>.
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>Projects page</strong> — create projects, browse environments, and{" "}
            <strong>Rescan AWS</strong> to pick up parameters created outside the app.
          </li>
          <li>
            <strong>Environment page</strong> — add, edit, reveal, and delete keys. Reveals are
            fetched and decrypted on demand, auto-hide after 30 seconds, and are audit-logged.
          </li>
          <li>
            <strong>Import</strong> — paste or drop a <K>.env</K> file; you get a preview of new /
            changed / unchanged / removed keys before anything is written.
          </li>
          <li>
            <strong>Download</strong> — exports the environment as a <K>.env</K> file that
            re-parses identically.
          </li>
          <li>
            <strong>Copy</strong> — copy keys (and optionally values) to another environment.
            Keys-only copies arrive as an unsaved draft.
          </li>
          <li>
            <strong>Diff</strong> — compare two environments; only statuses (added/changed/equal)
            are shown, never values.
          </li>
          <li>
            <strong>History</strong> — every write creates a new SSM version. Open a key's history
            to view or restore an older value; restore creates a new version, nothing is lost.
          </li>
        </ul>
      </Section>

      <Section title="Roles and protected environments">
        <p id="roles">
          Sign-in is GitHub OAuth; what you can do depends on your role:
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li><strong>Viewer</strong> — sees keys and metadata, no reveals, downloads, or writes.</li>
          <li><strong>Editor</strong> — full key management, including reveals and exports.</li>
          <li><strong>Restricted editor</strong> — like editor, but blocked from protected environments. Set per-user on the Users page.</li>
          <li><strong>Admin</strong> — everything, plus users, audit log, GitHub settings, and Setup. Admins come from <K>ADMIN_GITHUB_USERS</K>.</li>
        </ul>
        <p>
          Environments named in <K>PROTECTED_ENVS</K> (default <K>production</K>) require typing the
          environment name before any write or delete — a speed bump against mistakes, not a
          permission. Restricted editors can't write to them at all.
        </p>
      </Section>

      <Section title="GitHub Actions (OIDC)">
        <p id="github-actions">
          The GitHub page lets CI workflows read secrets directly from AWS via OIDC — no AWS keys
          stored in GitHub, and CI keeps working even if Shuttle is down.
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li><strong>All repos</strong> — one shared role per environment; every repo under the owner can use it. Simpler, less isolation.</li>
          <li><strong>Selected repos</strong> — one role per project+environment, usable only by repos you assign. More roles, tighter scoping.</li>
        </ul>
        <p>
          Copy the generated script and run it once with admin AWS credentials — it creates the
          OIDC provider and IAM roles. The <strong>Use these values</strong> tab on each environment
          produces the workflow YAML. Jobs are pinned to a GitHub Environment (
          <K>environment: production</K>), so reviewers and branch rules on that environment still
          apply.
        </p>
        <p>
          <strong>Warning:</strong> a freed GitHub owner name (renamed or deleted account) can be
          registered by someone else — remove owners you no longer control.
        </p>
      </Section>

      <Section title="For agents and automation">
        <p id="for-agents">
          Agents and scripts should talk to <strong>AWS Parameter Store directly</strong>, not to
          Shuttle's API — the API requires an interactive GitHub-OAuth session. You need AWS
          credentials with <K>ssm:GetParameter</K>/<K>ssm:GetParametersByPath</K> on the prefix.
        </p>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            Parameter names follow <K>/{"{prefix}"}/{"{project}"}/{"{env}"}/{"{KEY}"}</K>. List an
            environment with <K>aws ssm get-parameters-by-path --path /shuttle/myapp/production --with-decryption</K>.
          </li>
          <li>
            Values are SecureStrings — always pass <K>--with-decryption</K> when reading.
          </li>
          <li>
            Writes should use <K>aws ssm put-parameter --overwrite</K> and respect the{" "}
            <K>expectedVersion</K> pattern if you need optimistic concurrency; every write creates
            a new version you can roll back in the UI.
          </li>
          <li>
            After writing outside the app, an admin can hit <strong>Rescan AWS</strong> (or just
            reload) to see the new keys — metadata refreshes on demand.
          </li>
          <li>
            For CI specifically, prefer the generated OIDC roles from the GitHub page over static
            AWS keys.
          </li>
        </ul>
      </Section>

      <Section title="Security notes">
        <p id="security">
          <ul className="list-disc space-y-1 pl-5">
            <li>Secret values exist only in memory during a request — never in the database, logs, or temp files.</li>
            <li>Every reveal, export, write, and sign-in is written to the audit log (admins can export CSV).</li>
            <li>AWS CloudTrail records every Parameter Store call independently — that is your second audit trail.</li>
            <li>Sessions expire after 12 hours (2 hours idle); cookies are HttpOnly + Secure, with CSRF double-submit protection.</li>
            <li>The server's IAM policy is scoped to <K>parameter/{"{prefix}"}/*</K> and cannot write IAM.</li>
          </ul>
        </p>
      </Section>

      <Section title="Reference">
        <p id="reference">
          All configuration is environment variables, validated at startup — the server refuses to
          boot on missing or invalid values. Required: <K>PUBLIC_URL</K>, <K>SESSION_SECRET</K>,{" "}
          <K>GITHUB_CLIENT_ID</K>, <K>GITHUB_CLIENT_SECRET</K>,{" "}
          <K>ALLOWED_GITHUB_USERS</K> or <K>ALLOWED_GITHUB_ORG</K>, <K>ADMIN_GITHUB_USERS</K>,{" "}
          <K>AWS_REGION</K>. Everything else has a sensible default.
        </p>
        <EnvTable />
        <p>
          Example CLI write that Shuttle will pick up on the next scan:
        </p>
        <pre className="overflow-x-auto rounded-md border bg-muted p-3 font-mono text-xs">
{`aws ssm put-parameter \\
  --name /shuttle/myapp/staging/NEW_KEY \\
  --value 'secret' --type SecureString`}
        </pre>
      </Section>
    </div>
  );
}
