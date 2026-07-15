import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { mgmt, runSql, type Creds } from "./supabase-mgmt";
import {
  SCHEMA,
  SQL_LIST_ENUMS,
  SQL_TABLE_DDL,
  SQL_CONSTRAINTS,
  SQL_INDEXES,
  SQL_FUNCTIONS,
  SQL_TRIGGERS,
  SQL_AUTH_TRIGGERS,
  SQL_VIEWS,
  SQL_RLS,
  SQL_POLICIES,
  SQL_TABLE_ROWCOUNTS,
  sqlDumpTable,
  quoteIdent,
  quoteLiteral,
} from "./schema-sql";

const CredsSchema = z.object({
  ref: z.string().min(10).max(40),
  token: z.string().min(20),
});

export type LogEntry = { level: "info" | "ok" | "warn" | "error"; msg: string };

// -------- Discovery --------

export const discoverSource = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => CredsSchema.parse(d))
  .handler(async ({ data }) => {
    const c: Creds = data;
    const projectName = await mgmt
      .getProject(c)
      .then((p) => (p as { name?: string }).name ?? c.ref)
      .catch((e) => `ERROR: ${(e as Error).message}`);
    const tables = await runSql<{ name: string; approx_rows: number }>(c, SQL_TABLE_ROWCOUNTS);
    const fns = await mgmt.listFunctions(c).catch(() => []);
    const buckets = await mgmt.listBuckets(c).catch(() => []);
    const enums = await runSql<{ name: string; values: unknown }>(c, SQL_LIST_ENUMS).catch(() => []);
    const indexes = await runSql<{ name: string; table_name: string }>(c, SQL_INDEXES).catch(() => []);
    const dbFunctions = await runSql<{ name: string }>(c, SQL_FUNCTIONS).catch(() => []);
    const triggers = await runSql<{ name: string; table_name: string }>(c, SQL_TRIGGERS).catch(() => []);
    const authTriggers = await runSql<{ name: string; table_name: string }>(c, SQL_AUTH_TRIGGERS).catch(() => []);
    const rls = await runSql<{ table_name: string; enabled: boolean }>(c, SQL_RLS).catch(() => []);
    const policies = await runSql<{ name: string; table_name: string }>(c, SQL_POLICIES).catch(() => []);
    return {
      projectName,
      tables: (tables ?? []).map((t) => ({
        name: String(t.name),
        approx_rows: Number(t.approx_rows ?? 0),
      })),
      functions: (fns ?? []).map((f) => ({ slug: f.slug, name: f.name })),
      buckets: (buckets ?? []).map((b) => ({ id: b.id, public: !!b.public })),
      enums: (enums ?? []).map((e) => {
        let count = 0;
        if (Array.isArray(e.values)) count = e.values.length;
        else if (typeof e.values === "string") {
          if (e.values.includes("\x1f")) count = e.values.split("\x1f").length;
          else if (e.values.startsWith("{") && e.values.endsWith("}"))
            count = e.values.slice(1, -1).split(",").length;
          else count = 1;
        }
        return { name: String(e.name), values: count };
      }),
      indexes: (indexes ?? []).map((i) => ({ name: String(i.name), table_name: String(i.table_name) })),
      dbFunctions: (dbFunctions ?? []).map((f) => ({ name: String(f.name) })),
      triggers: (triggers ?? []).map((t) => ({ name: String(t.name), table_name: String(t.table_name) })),
      authTriggers: (authTriggers ?? []).map((t) => ({ name: String(t.name), table_name: String(t.table_name) })),
      rls: (rls ?? []).filter((r) => r.enabled).map((r) => ({ table_name: String(r.table_name) })),
      policies: (policies ?? []).map((p) => ({ name: String(p.name), table_name: String(p.table_name) })),
    };
  });

// -------- Phased clone (one server call per phase to avoid gateway timeout) --------

export type Phase =
  | "enums"
  | "tables"
  | "constraints"
  | "indexes"
  | "functions"
  | "views"
  | "triggers"
  | "authTriggers"
  | "rls"
  | "policies"
  | "data"
  | "edgeFunctions"
  | "storage"
  | "authConfig"
  | "dataApiConfig";

const PhaseInput = z.object({
  phase: z.string(),
  source: CredsSchema,
  dest: CredsSchema,
  arg: z.string().optional(), // e.g. table name for "data"
});

export const runPhase = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => PhaseInput.parse(d))
  .handler(async ({ data }) => {
    const logs: LogEntry[] = [];
    const log = (level: LogEntry["level"], msg: string) => logs.push({ level, msg });
    const src = data.source as Creds;
    const dst = data.dest as Creds;
    const phase = data.phase as Phase;

    try {
      switch (phase) {
        case "enums": {
          const enums = await runSql<{ name: string; values: unknown }>(src, SQL_LIST_ENUMS);
          log("info", `found ${enums.length} enum(s) on source`);
          const existing = await runSql<{ name: string }>(
            dst,
            `select t.typname as name from pg_type t join pg_namespace n on n.oid = t.typnamespace where n.nspname = '${SCHEMA}' and t.typtype = 'e';`,
          ).catch(() => [] as { name: string }[]);
          const existingSet = new Set(existing.map((r) => r.name));
          for (const e of enums) {
            if (existingSet.has(e.name)) {
              log("info", `enum ${e.name} already exists, skipping`);
              continue;
            }
            // values may arrive as JS array, postgres array literal "{a,b}", or unit-separated string
            let values: string[] = [];
            if (Array.isArray(e.values)) values = e.values.map(String);
            else if (typeof e.values === "string") {
              const s = e.values;
              if (s.includes("\x1f")) values = s.split("\x1f");
              else if (s.startsWith("{") && s.endsWith("}")) {
                values = s.slice(1, -1).split(",").map((v) => v.replace(/^"|"$/g, "").replace(/\\"/g, '"'));
              } else values = [s];
            }
            if (values.length === 0) {
              log("error", `enum ${e.name}: no values parsed (raw: ${JSON.stringify(e.values).slice(0, 100)})`);
              continue;
            }
            const vals = values.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ");
            const ddl = `create type ${SCHEMA}.${quoteIdent(e.name)} as enum (${vals});`;
            try {
              await runSql(dst, ddl);
              log("ok", `enum ${e.name} (${values.length} values)`);
            } catch (err) {
              log("error", `enum ${e.name}: ${(err as Error).message.split("\n")[0]}`);
            }
          }
          break;
        }
        case "tables": {
          const tableDdls = await runSql<{ name: string; ddl: string }>(src, SQL_TABLE_DDL);
          for (const t of tableDdls) {
            try {
              await runSql(dst, t.ddl);
              log("ok", `table ${t.name}`);
            } catch (err) {
              log("warn", `table ${t.name}: ${(err as Error).message.split("\n")[0]}`);
            }
          }
          break;
        }
        case "constraints": {
          const cons = await runSql<{ table_name: string; name: string; type: string; ddl: string }>(
            src,
            SQL_CONSTRAINTS,
          );
          for (const con of cons) {
            try {
              await runSql(dst, con.ddl);
              log("ok", `constraint ${con.name} on ${con.table_name}`);
            } catch (err) {
              log("warn", `constraint ${con.name}: ${(err as Error).message.split("\n")[0]}`);
            }
          }
          break;
        }
        case "indexes": {
          const idxs = await runSql<{ name: string; ddl: string }>(src, SQL_INDEXES);
          for (const i of idxs) {
            try {
              await runSql(dst, i.ddl);
              log("ok", `index ${i.name}`);
            } catch (err) {
              log("warn", `index ${i.name}: ${(err as Error).message.split("\n")[0]}`);
            }
          }
          break;
        }
        case "functions": {
          const fns = await runSql<{ name: string; ddl: string }>(src, SQL_FUNCTIONS);
          for (const f of fns) {
            try {
              await runSql(dst, f.ddl);
              log("ok", `function ${f.name}`);
            } catch (err) {
              log("warn", `function ${f.name}: ${(err as Error).message.split("\n")[0]}`);
            }
          }
          break;
        }
        case "views": {
          const views = await runSql<{ name: string; ddl: string }>(src, SQL_VIEWS);
          for (const v of views) {
            try {
              await runSql(dst, v.ddl);
              log("ok", `view ${v.name}`);
            } catch (err) {
              log("warn", `view ${v.name}: ${(err as Error).message.split("\n")[0]}`);
            }
          }
          break;
        }
        case "triggers": {
          const trigs = await runSql<{ name: string; ddl: string; table_name: string }>(
            src,
            SQL_TRIGGERS,
          );
          for (const t of trigs) {
            try {
              await runSql(dst, t.ddl);
              log("ok", `trigger ${t.name} on ${t.table_name}`);
            } catch (err) {
              log("warn", `trigger ${t.name}: ${(err as Error).message.split("\n")[0]}`);
            }
          }
          break;
        }
        case "authTriggers": {
          const trigs = await runSql<{ name: string; ddl: string; table_name: string }>(
            src,
            SQL_AUTH_TRIGGERS,
          );
          for (const t of trigs) {
            try {
              // drop if exists, then recreate (DDL is "CREATE TRIGGER ...")
              await runSql(
                dst,
                `drop trigger if exists ${quoteIdent(t.name)} on auth.${quoteIdent(t.table_name)};`,
              );
              await runSql(dst, t.ddl);
              log("ok", `auth trigger ${t.name} on auth.${t.table_name}`);
            } catch (err) {
              log("error", `auth trigger ${t.name}: ${(err as Error).message.split("\n")[0]}`);
            }
          }
          break;
        }
        case "rls": {
          const rls = await runSql<{ table_name: string; enabled: boolean }>(src, SQL_RLS);
          for (const r of rls) {
            if (r.enabled) {
              try {
                await runSql(
                  dst,
                  `alter table ${SCHEMA}.${quoteIdent(r.table_name)} enable row level security;`,
                );
                log("ok", `RLS enabled on ${r.table_name}`);
              } catch (err) {
                log("warn", `RLS ${r.table_name}: ${(err as Error).message.split("\n")[0]}`);
              }
            }
          }
          break;
        }
        case "policies": {
          const pols = await runSql<{ name: string; table_name: string; ddl: string }>(
            src,
            SQL_POLICIES,
          );
          for (const p of pols) {
            try {
              await runSql(
                dst,
                `drop policy if exists ${quoteIdent(p.name)} on ${SCHEMA}.${quoteIdent(p.table_name)};`,
              );
              await runSql(dst, p.ddl);
              log("ok", `policy ${p.name} on ${p.table_name}`);
            } catch (err) {
              log("warn", `policy ${p.name}: ${(err as Error).message.split("\n")[0]}`);
            }
          }
          break;
        }
        case "data": {
          const tname = data.arg;
          if (!tname) {
            log("error", "data phase requires arg (table name)");
            break;
          }
          const rows = await runSql<{ row: Record<string, unknown> }>(src, sqlDumpTable(tname));
          if (rows.length === 0) {
            log("info", `${tname}: 0 rows`);
            break;
          }
          const cols = Object.keys(rows[0].row);
          const colList = cols.map((c) => quoteIdent(c)).join(", ");
          const CHUNK = 200;
          let inserted = 0;
          for (let i = 0; i < rows.length; i += CHUNK) {
            const slice = rows.slice(i, i + CHUNK);
            const values = slice
              .map((r) => "(" + cols.map((c) => quoteLiteral(r.row[c])).join(", ") + ")")
              .join(", ");
            const sql = `insert into ${SCHEMA}.${quoteIdent(tname)} (${colList}) values ${values} on conflict do nothing;`;
            try {
              await runSql(dst, sql);
              inserted += slice.length;
            } catch (err) {
              log("warn", `${tname} chunk @${i}: ${(err as Error).message.split("\n")[0]}`);
            }
          }
          log("ok", `${tname}: ${inserted}/${rows.length} row(s) copied`);
          break;
        }
        case "edgeFunctions": {
          const fns = await mgmt.listFunctions(src);
          for (const fn of fns ?? []) {
            try {
              // Fetch full metadata (entrypoint_path/import_map_path) from source
              let entrypoint_path = fn.entrypoint_path;
              let import_map_path = fn.import_map_path;
              if (!entrypoint_path) {
                try {
                  const meta = await mgmt.getFunction(src, fn.slug);
                  entrypoint_path = meta.entrypoint_path;
                  import_map_path = meta.import_map_path;
                } catch {
                  /* ignore */
                }
              }
              const bundle = await mgmt.getFunctionBundle(src, fn.slug);
              entrypoint_path = bundle.metadata.entrypoint_path || entrypoint_path;
              import_map_path = bundle.metadata.import_map_path || import_map_path;
              const static_patterns = bundle.metadata.static_patterns;
              await mgmt.deployFunction(dst, {
                slug: fn.slug,
                name: fn.name,
                files: bundle.files,
                verify_jwt: fn.verify_jwt,
                entrypoint_path,
                import_map_path,
                static_patterns,
              });
              log("ok", `deployed edge function ${fn.slug} (${bundle.files.length} file(s))`);
            } catch (err) {
              log("warn", `edge function ${fn.slug}: ${(err as Error).message.split("\n")[0]}`);
            }
          }
          break;
        }

        case "storage": {
          const buckets = await mgmt.listBuckets(src);
          const existing = await mgmt.listBuckets(dst).catch(() => []);
          const existingIds = new Set((existing ?? []).map((b) => b.id));
          for (const b of buckets ?? []) {
            if (existingIds.has(b.id)) {
              log("info", `bucket ${b.id} already exists, skipping`);
              continue;
            }
            try {
              await mgmt.createBucket(dst, {
                id: b.id,
                name: b.name,
                public: b.public,
                file_size_limit: b.file_size_limit ?? null,
                allowed_mime_types: b.allowed_mime_types ?? null,
              });
              log("ok", `bucket ${b.id}`);
            } catch (err) {
              log("warn", `bucket ${b.id}: ${(err as Error).message.split("\n")[0]}`);
            }
          }
          break;
        }
        case "authConfig": {
          const cfg = await mgmt.getAuthConfig(src);
          const blocked = new Set([
            "smtp_pass",
            "external_apple_secret",
            "hook_custom_access_token_secrets",
            "hook_send_email_secrets",
            "hook_send_sms_secrets",
            "hook_mfa_verification_attempt_secrets",
            "hook_password_verification_attempt_secrets",
          ]);
          const payload: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(cfg)) {
            if (blocked.has(k)) continue;
            if (v === null || v === undefined) continue;
            payload[k] = v;
          }
          await mgmt.updateAuthConfig(dst, payload);
          log("ok", `auth config copied (secrets like smtp_pass not transferred)`);
          break;
        }
        case "dataApiConfig": {
          const cfg = await mgmt.getPostgrestConfig(src);
          const payload: { db_schema?: string; db_extra_search_path?: string; max_rows?: number } = {};
          if (cfg.db_schema) payload.db_schema = cfg.db_schema;
          if (cfg.db_extra_search_path) payload.db_extra_search_path = cfg.db_extra_search_path;
          if (typeof cfg.max_rows === "number") payload.max_rows = cfg.max_rows;
          await mgmt.updatePostgrestConfig(dst, payload);
          log("ok", `data API exposed schemas: ${payload.db_schema ?? "(unchanged)"}`);

          // Grant Data API roles access to tables/sequences/functions so they
          // show up as "exposed" in the dashboard. RLS still controls row access.
          const schemas = (payload.db_schema ?? "public")
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s && s !== "extensions");
          for (const sch of schemas) {
            const q = quoteIdent(sch);
            const stmts = [
              `grant usage on schema ${q} to anon, authenticated, service_role;`,
              `grant all on all tables in schema ${q} to anon, authenticated, service_role;`,
              `grant all on all sequences in schema ${q} to anon, authenticated, service_role;`,
              `grant all on all routines in schema ${q} to anon, authenticated, service_role;`,
              `alter default privileges in schema ${q} grant all on tables to anon, authenticated, service_role;`,
              `alter default privileges in schema ${q} grant all on sequences to anon, authenticated, service_role;`,
              `alter default privileges in schema ${q} grant all on routines to anon, authenticated, service_role;`,
            ];
            for (const s of stmts) {
              try {
                await runSql(dst, s);
              } catch (err) {
                log("warn", `grant (${sch}): ${(err as Error).message.split("\n")[0]}`);
              }
            }
            log("ok", `granted Data API roles on schema ${sch}`);
          }
          break;
        }
        default:
          log("error", `unknown phase: ${phase}`);
      }
    } catch (err) {
      log("error", `${phase}: ${(err as Error).message.split("\n")[0]}`);
    }

    return { logs };
  });
