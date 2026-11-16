import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCircle2, Rocket } from "lucide-react";
import { api } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface EnvField {
  key: string;
  label: string;
  required: boolean;
  secret: boolean;
  hint: string;
  source: "env" | "setup" | "unset";
  set: boolean;
}
interface ChecklistItem {
  id: string;
  ok: boolean | null;
  title: string;
  detail: string;
  hint?: string;
}
interface SetupInfo {
  setupMode: boolean;
  issues: string[];
  fields: EnvField[];
  checklist: ChecklistItem[];
}
interface ConfigResult {
  ok: boolean;
  issues: string[];
  sources: Record<string, string>;
}

/** First-run wizard: shown instead of the app whenever required env vars are
 *  missing. Values are stored server-side (SQLite settings) and the app
 *  hot-reloads into normal mode once validation passes. */
export function SetupWizard() {
  const [values, setValues] = useState<Record<string, string>>({});
  const [issues, setIssues] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [showOptional, setShowOptional] = useState(false);

  const { data: info, error } = useQuery({
    queryKey: ["setup-info"],
    queryFn: () => api.get<SetupInfo>("/api/setup/info"),
    retry: 1,
  });

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center px-4">
        <p className="text-sm text-destructive">
          Could not load setup info: {(error as Error).message}
        </p>
      </div>
    );
  }
  if (!info) {
    return (
      <div className="flex h-screen items-center justify-center text-muted-foreground">
        …
      </div>
    );
  }

  const fields = info.fields ?? [];
  // Env-provided values win over stored ones and can't be edited here.
  const envProvided = fields.filter((f) => f.source === "env");
  const editableRequired = fields.filter((f) => f.required && f.source !== "env");
  const editableOptional = fields.filter((f) => !f.required && f.source !== "env");
  const unsetRequired = editableRequired.filter((f) => !f.set);

  async function submit() {
    setBusy(true);
    setIssues([]);
    try {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(values)) {
        if (v.trim() !== "") env[k] = v.trim();
      }
      const res = await api.post<ConfigResult>("/api/setup/config", { env });
      if (res.ok) {
        toast.success("Configuration saved — reloading…");
        setTimeout(() => window.location.reload(), 800);
      } else {
        setIssues(res.issues);
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-2xl space-y-6 px-4 py-10">
      <div className="text-center">
        <img
          src="/shuttle-logo.png"
          alt="A shuttle"
          className="mx-auto w-40 select-none"
          draggable={false}
        />
        <h1 className="mt-4 text-2xl font-semibold tracking-tight">
          Finish setting up Shuttle
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Shuttle is running in setup mode — it needs a few environment values
          before it can serve the app. Everything you enter is stored in the
          local database and survives restarts.
        </p>
      </div>

      {(info.issues.length > 0 || issues.length > 0) && (
        <Card className="border-destructive/50">
          <CardHeader><CardTitle className="text-base">Still missing</CardTitle></CardHeader>
          <CardContent>
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              {[...info.issues, ...issues].map((i) => (
                <li key={i} className="font-mono text-xs">{i}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">Required</CardTitle>
          <Badge variant={unsetRequired.length === 0 ? "success" : "destructive"}>
            {unsetRequired.length === 0 ? "all set" : `${unsetRequired.length} missing`}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          {editableRequired.map((f) => (
            <div key={f.key} className="space-y-1.5">
              <Label htmlFor={f.key}>
                {f.label}{" "}
                <span className="font-mono text-xs text-muted-foreground">
                  {f.key}
                </span>
              </Label>
              <Input
                id={f.key}
                type={f.secret ? "password" : "text"}
                autoComplete="off"
                placeholder={f.set ? "(already set — leave blank to keep)" : ""}
                value={values[f.key] ?? ""}
                onChange={(e) =>
                  setValues((v) => ({ ...v, [f.key]: e.target.value }))
                }
              />
              <p className="text-xs text-muted-foreground">{f.hint}</p>
            </div>
          ))}
          {unsetRequired.length === 0 && editableRequired.length > 0 && (
            <p className="text-sm text-muted-foreground">
              Required values are already saved — submitting again re-validates.
            </p>
          )}
        </CardContent>
      </Card>

      {editableOptional.length > 0 && (
        <Card>
          <CardHeader>
            <button
              type="button"
              className="flex w-full items-center justify-between text-left"
              onClick={() => setShowOptional((s) => !s)}
            >
              <CardTitle className="text-base">
                Optional settings ({editableOptional.length})
              </CardTitle>
              <span className="text-sm text-muted-foreground">
                {showOptional ? "hide" : "show"}
              </span>
            </button>
          </CardHeader>
          {showOptional && (
            <CardContent className="space-y-4">
              {editableOptional.map((f) => (
                <div key={f.key} className="space-y-1.5">
                  <Label htmlFor={f.key}>
                    {f.label}{" "}
                    <span className="font-mono text-xs text-muted-foreground">
                      {f.key}
                    </span>
                  </Label>
                  <Input
                    id={f.key}
                    type={f.secret ? "password" : "text"}
                    autoComplete="off"
                    value={values[f.key] ?? ""}
                    onChange={(e) =>
                      setValues((v) => ({ ...v, [f.key]: e.target.value }))
                    }
                  />
                  <p className="text-xs text-muted-foreground">{f.hint}</p>
                </div>
              ))}
            </CardContent>
          )}
        </Card>
      )}

      {envProvided.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-base">Already configured</CardTitle></CardHeader>
          <CardContent className="space-y-2">
            {envProvided.map((f) => (
              <div key={f.key} className="flex items-center gap-2 text-sm">
                <CheckCircle2 className="h-4 w-4 text-green-600" />
                <span>{f.label}</span>
                <Badge variant="outline" className="ml-auto font-mono text-xs">
                  via environment
                </Badge>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Button className="w-full" onClick={submit} disabled={busy}>
        <Rocket /> {busy ? "Saving…" : "Save and finish setup"}
      </Button>
      {unsetRequired.length > 0 && (
        <p className="text-center text-xs text-muted-foreground">
          Fill in the required fields above — you can save partial progress and
          come back; nothing is lost.
        </p>
      )}
    </div>
  );
}
