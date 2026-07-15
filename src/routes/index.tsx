import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";
import {
  Database,
  Loader2,
  ArrowRight,
  CheckCircle2,
  AlertCircle,
  Info,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Toaster } from "@/components/ui/sonner";

import { runPhase, discoverSource, type LogEntry, type Phase } from "@/lib/clone-actions";

export const Route = createFileRoute("/")({
  component: Index,
});

type Creds = { ref: string; token: string };

type Discovered = Awaited<ReturnType<typeof discoverSource>>;

function ProjectInput({
  label,
  creds,
  setCreds,
}: {
  label: string;
  creds: Creds;
  setCreds: (c: Creds) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Database className="h-4 w-4" /> {label}
        </CardTitle>
        <CardDescription>Project ref + personal access token</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1">
          <Label>Project Ref</Label>
          <Input
            placeholder="abcxyzabcxyzabcxyz"
            value={creds.ref}
            onChange={(e) => setCreds({ ...creds, ref: e.target.value.trim() })}
          />
        </div>
        <div className="space-y-1">
          <Label>Access Token</Label>
          <Input
            type="password"
            placeholder="sbp_..."
            value={creds.token}
            onChange={(e) => setCreds({ ...creds, token: e.target.value.trim() })}
          />
          <p className="text-xs text-muted-foreground">
            Generate at supabase.com/dashboard/account/tokens
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

function Index() {
  const [source, setSource] = useState<Creds>({ ref: "", token: "" });
  const [dest, setDest] = useState<Creds>({ ref: "", token: "" });
  const [discovered, setDiscovered] = useState<Discovered | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  const [scope, setScope] = useState({
    schema: true,
    edgeFunctions: true,
    storage: true,
    authConfig: false,
  });
  const [dataTables, setDataTables] = useState<Set<string>>(new Set());

  const onDiscover = async () => {
    if (!source.ref || !source.token) {
      toast.error("Fill source ref + token");
      return;
    }
    setDiscovering(true);
    try {
      const r = await discoverSource({ data: source });
      setDiscovered(r);
      toast.success(`Connected to ${r.projectName}`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setDiscovering(false);
    }
  };

  const appendLogs = (entries: LogEntry[]) => setLogs((l) => [...l, ...entries]);

  const onClone = async () => {
    if (!source.token || !dest.token) {
      toast.error("Both projects need credentials");
      return;
    }
    setRunning(true);
    setLogs([]);

    const phases: Array<{ phase: Phase; label: string; arg?: string }> = [];
    if (scope.schema) {
      phases.push(
        { phase: "enums", label: "enums" },
        { phase: "tables", label: "tables" },
        { phase: "constraints", label: "constraints" },
        { phase: "indexes", label: "indexes" },
        { phase: "functions", label: "functions" },
        { phase: "views", label: "views" },
        { phase: "triggers", label: "triggers" },
        { phase: "authTriggers", label: "auth triggers" },
        { phase: "rls", label: "RLS" },
        { phase: "policies", label: "policies" },
        { phase: "dataApiConfig", label: "data API config (exposed schemas)" },
      );
    }
    for (const t of dataTables) {
      phases.push({ phase: "data", label: `data: ${t}`, arg: t });
    }
    if (scope.edgeFunctions) phases.push({ phase: "edgeFunctions", label: "edge functions" });
    if (scope.storage) phases.push({ phase: "storage", label: "storage buckets" });
    if (scope.authConfig) phases.push({ phase: "authConfig", label: "auth config" });

    let hadError = false;
    try {
      for (const p of phases) {
        appendLogs([{ level: "info", msg: `=== ${p.label} ===` }]);
        try {
          const r = await runPhase({
            data: { phase: p.phase, source, dest, arg: p.arg },
          });
          appendLogs(r.logs);
          if (r.logs.some((l) => l.level === "error")) hadError = true;
        } catch (e) {
          hadError = true;
          appendLogs([{ level: "error", msg: `${p.label}: ${(e as Error).message}` }]);
        }
      }
      if (hadError) toast.error("Clone finished with errors");
      else toast.success("Clone completed");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="min-h-screen bg-background py-10">
      <Toaster />
      <div className="mx-auto max-w-6xl px-4 space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-bold tracking-tight">Supabase Project Cloner</h1>
          <p className="text-muted-foreground">
            Clona estrutura (schema, DB functions, triggers, indexes, enums, edge functions,
            storage, auth config) de um projeto Supabase para outro via Management API.
          </p>
        </header>

        <div className="grid gap-4 md:grid-cols-[1fr_auto_1fr] items-start">
          <ProjectInput label="Source" creds={source} setCreds={setSource} />
          <div className="flex md:flex-col items-center justify-center py-6">
            <ArrowRight className="h-6 w-6 text-muted-foreground" />
          </div>
          <ProjectInput label="Destination" creds={dest} setCreds={setDest} />
        </div>

        <Card>
          <CardHeader>
            <CardTitle>1. Discover source</CardTitle>
            <CardDescription>List tables, edge functions, and buckets to clone.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button onClick={onDiscover} disabled={discovering}>
              {discovering && <Loader2 className="h-4 w-4 animate-spin" />}
              Discover
            </Button>
            {discovered && (
              <div className="grid gap-3 md:grid-cols-3 text-sm">
                <div>
                  <div className="font-medium mb-1">Tables ({discovered.tables.length})</div>
                  <ScrollArea className="h-40 rounded border p-2">
                    {discovered.tables.map((t) => (
                      <div key={t.name} className="flex items-center justify-between py-0.5">
                        <span className="truncate">{t.name}</span>
                        <Badge variant="secondary" className="ml-2">
                          ~{t.approx_rows}
                        </Badge>
                      </div>
                    ))}
                  </ScrollArea>
                </div>
                <div>
                  <div className="font-medium mb-1">
                    Edge Functions ({discovered.functions.length})
                  </div>
                  <ScrollArea className="h-40 rounded border p-2">
                    {discovered.functions.map((f) => (
                      <div key={f.slug} className="py-0.5 truncate">
                        {f.slug}
                      </div>
                    ))}
                  </ScrollArea>
                </div>
                <div>
                  <div className="font-medium mb-1">Buckets ({discovered.buckets.length})</div>
                  <ScrollArea className="h-40 rounded border p-2">
                    {discovered.buckets.map((b) => (
                      <div key={b.id} className="py-0.5 truncate">
                        {b.id} {b.public ? <Badge variant="outline">public</Badge> : null}
                      </div>
                    ))}
                  </ScrollArea>
                </div>
                <div>
                  <div className="font-medium mb-1">Enums ({discovered.enums.length})</div>
                  <ScrollArea className="h-40 rounded border p-2">
                    {discovered.enums.map((e) => (
                      <div key={e.name} className="flex items-center justify-between py-0.5">
                        <span className="truncate">{e.name}</span>
                        <Badge variant="secondary" className="ml-2">
                          {e.values}
                        </Badge>
                      </div>
                    ))}
                  </ScrollArea>
                </div>
                <div>
                  <div className="font-medium mb-1">Indexes ({discovered.indexes.length})</div>
                  <ScrollArea className="h-40 rounded border p-2">
                    {discovered.indexes.map((i) => (
                      <div key={`${i.table_name}.${i.name}`} className="py-0.5 truncate">
                        <span className="text-muted-foreground">{i.table_name}.</span>
                        {i.name}
                      </div>
                    ))}
                  </ScrollArea>
                </div>
                <div>
                  <div className="font-medium mb-1">
                    DB Functions ({discovered.dbFunctions.length})
                  </div>
                  <ScrollArea className="h-40 rounded border p-2">
                    {discovered.dbFunctions.map((f) => (
                      <div key={f.name} className="py-0.5 truncate">
                        {f.name}
                      </div>
                    ))}
                  </ScrollArea>
                </div>
                <div>
                  <div className="font-medium mb-1">Triggers ({discovered.triggers.length})</div>
                  <ScrollArea className="h-40 rounded border p-2">
                    {discovered.triggers.map((t) => (
                      <div key={`${t.table_name}.${t.name}`} className="py-0.5 truncate">
                        <span className="text-muted-foreground">{t.table_name}.</span>
                        {t.name}
                      </div>
                    ))}
                  </ScrollArea>
                </div>
                <div>
                  <div className="font-medium mb-1">
                    Auth Triggers ({discovered.authTriggers.length})
                  </div>
                  <ScrollArea className="h-40 rounded border p-2">
                    {discovered.authTriggers.map((t) => (
                      <div key={`${t.table_name}.${t.name}`} className="py-0.5 truncate">
                        <span className="text-muted-foreground">auth.{t.table_name}.</span>
                        {t.name}
                      </div>
                    ))}
                  </ScrollArea>
                </div>
                <div>
                  <div className="font-medium mb-1">
                    RLS enabled ({discovered.rls.length}) · Policies ({discovered.policies.length})
                  </div>
                  <ScrollArea className="h-40 rounded border p-2">
                    {discovered.rls.map((r) => (
                      <div key={`rls.${r.table_name}`} className="py-0.5 truncate">
                        <Badge variant="outline" className="mr-1">RLS</Badge>
                        {r.table_name}
                      </div>
                    ))}
                    {discovered.policies.map((p) => (
                      <div key={`pol.${p.table_name}.${p.name}`} className="py-0.5 truncate">
                        <span className="text-muted-foreground">{p.table_name}.</span>
                        {p.name}
                      </div>
                    ))}
                  </ScrollArea>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>2. Choose what to clone</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {(
                [
                  ["schema", "DB schema (tables, enums, indexes, functions, triggers, RLS)"],
                  ["edgeFunctions", "Edge Functions"],
                  ["storage", "Storage buckets"],
                  ["authConfig", "Auth config"],
                ] as const
              ).map(([key, label]) => (
                <label
                  key={key}
                  className="flex items-start gap-2 rounded border p-3 cursor-pointer hover:bg-muted/40"
                >
                  <Checkbox
                    checked={scope[key]}
                    onCheckedChange={(v) =>
                      setScope((s) => ({ ...s, [key]: v === true }))
                    }
                  />
                  <span className="text-sm">{label}</span>
                </label>
              ))}
            </div>

            {discovered && discovered.tables.length > 0 && (
              <>
                <Separator />
                <div>
                  <div className="font-medium mb-2 text-sm">
                    Data to copy ({dataTables.size}/{discovered.tables.length} selected)
                  </div>
                  <div className="flex gap-2 mb-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setDataTables(new Set(discovered.tables.map((t) => t.name)))
                      }
                    >
                      Select all
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setDataTables(new Set())}
                    >
                      Clear
                    </Button>
                  </div>
                  <ScrollArea className="h-48 rounded border p-2">
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-1">
                      {discovered.tables.map((t) => (
                        <label
                          key={t.name}
                          className="flex items-center gap-2 text-sm cursor-pointer p-1 rounded hover:bg-muted/40"
                        >
                          <Checkbox
                            checked={dataTables.has(t.name)}
                            onCheckedChange={(v) => {
                              setDataTables((prev) => {
                                const next = new Set(prev);
                                if (v === true) next.add(t.name);
                                else next.delete(t.name);
                                return next;
                              });
                            }}
                          />
                          <span className="truncate">{t.name}</span>
                          <span className="text-xs text-muted-foreground">
                            ~{t.approx_rows}
                          </span>
                        </label>
                      ))}
                    </div>
                  </ScrollArea>
                </div>
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>3. Run clone</CardTitle>
            <CardDescription>
              Destination should ideally be an empty project. Existing objects with the same name
              will be skipped or overwritten depending on the type.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <Button onClick={onClone} disabled={running} size="lg">
              {running && <Loader2 className="h-4 w-4 animate-spin" />}
              Start clone
            </Button>
            {logs.length > 0 && (
              <ScrollArea className="h-80 rounded border bg-muted/30 p-3 font-mono text-xs">
                {logs.map((l, i) => (
                  <div
                    key={i}
                    className={
                      l.level === "error"
                        ? "text-destructive"
                        : l.level === "warn"
                          ? "text-yellow-600"
                          : l.level === "ok"
                            ? "text-green-600"
                            : "text-muted-foreground"
                    }
                  >
                    <span className="inline-block w-4">
                      {l.level === "ok" ? (
                        <CheckCircle2 className="inline h-3 w-3" />
                      ) : l.level === "error" || l.level === "warn" ? (
                        <AlertCircle className="inline h-3 w-3" />
                      ) : (
                        <Info className="inline h-3 w-3" />
                      )}
                    </span>{" "}
                    {l.msg}
                  </div>
                ))}
              </ScrollArea>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
