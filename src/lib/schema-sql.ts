// SQL snippets that introspect a Postgres schema and return reconstructable DDL.
// All queries scope to a target schema (default: public) and exclude Supabase-internal schemas.

export const SCHEMA = "public";

// List enums (name + values). Use string_agg with a unit-separator delimiter
// to avoid array-encoding ambiguity over the Management API /database/query endpoint.
export const SQL_LIST_ENUMS = `
select n.nspname as schema, t.typname as name,
  string_agg(e.enumlabel, E'\\x1f' order by e.enumsortorder) as values
from pg_type t
join pg_enum e on e.enumtypid = t.oid
join pg_namespace n on n.oid = t.typnamespace
where n.nspname = '${SCHEMA}'
group by n.nspname, t.typname
order by t.typname;
`;

// List tables in order safe enough for FK creation later (we drop FKs and re-add).
export const SQL_LIST_TABLES = `
select c.relname as name
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = '${SCHEMA}' and c.relkind = 'r'
order by c.relname;
`;

// Build CREATE TABLE statements (columns + defaults + NOT NULL + IDENTITY).
// Returns one row per table with full DDL.
export const SQL_TABLE_DDL = `
with cols as (
  select c.table_schema, c.table_name, c.ordinal_position,
    format('%I %s%s%s%s',
      c.column_name,
      case
        when c.data_type = 'USER-DEFINED' then format('%I.%I', c.udt_schema, c.udt_name)
        when c.data_type = 'ARRAY' then format('%I.%I[]', c.udt_schema, regexp_replace(c.udt_name, '^_', ''))
        else c.data_type ||
          case when c.character_maximum_length is not null then '(' || c.character_maximum_length || ')' else '' end
      end,
      case
        when c.is_identity = 'YES'
          then ' generated ' || c.identity_generation || ' as identity'
        else ''
      end,
      case
        when c.column_default is not null and c.is_identity <> 'YES'
          then ' default ' || c.column_default
        else ''
      end,
      case when c.is_nullable = 'NO' then ' not null' else '' end
    ) as col_def
  from information_schema.columns c
  where c.table_schema = '${SCHEMA}'
)
select t.table_name as name,
  format('create table if not exists %I.%I (%s);',
    '${SCHEMA}', t.table_name,
    string_agg(c.col_def, ', ' order by c.ordinal_position)
  ) as ddl
from information_schema.tables t
join cols c on c.table_schema = t.table_schema and c.table_name = t.table_name
where t.table_schema = '${SCHEMA}' and t.table_type = 'BASE TABLE'
group by t.table_name
order by t.table_name;
`;

// Primary keys + unique constraints + check constraints via pg_get_constraintdef
export const SQL_CONSTRAINTS = `
select n.nspname as schema, cl.relname as table_name, con.conname as name,
  con.contype as type,
  format('alter table %I.%I add constraint %I %s;',
    n.nspname, cl.relname, con.conname, pg_get_constraintdef(con.oid)
  ) as ddl
from pg_constraint con
join pg_class cl on cl.oid = con.conrelid
join pg_namespace n on n.oid = cl.relnamespace
where n.nspname = '${SCHEMA}'
order by case con.contype when 'p' then 1 when 'u' then 2 when 'c' then 3 when 'f' then 4 else 5 end,
  cl.relname, con.conname;
`;

// Indexes (skip those auto-created by PK/unique constraints)
export const SQL_INDEXES = `
select schemaname as schema, tablename as table_name, indexname as name,
  indexdef || ';' as ddl
from pg_indexes
where schemaname = '${SCHEMA}'
  and indexname not in (
    select con.conname from pg_constraint con
    join pg_class cl on cl.oid = con.conrelid
    join pg_namespace n on n.oid = cl.relnamespace
    where n.nspname = '${SCHEMA}' and con.contype in ('p','u')
  )
order by tablename, indexname;
`;

// Functions
export const SQL_FUNCTIONS = `
select n.nspname as schema, p.proname as name,
  pg_get_functiondef(p.oid) || ';' as ddl
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = '${SCHEMA}'
  and p.prokind in ('f','p')
order by p.proname;
`;

// Triggers (exclude internal trigger names like RI_*)
export const SQL_TRIGGERS = `
select n.nspname as schema, c.relname as table_name, t.tgname as name,
  pg_get_triggerdef(t.oid, true) || ';' as ddl
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = '${SCHEMA}'
  and not t.tgisinternal
order by c.relname, t.tgname;
`;

// Triggers defined on the auth schema (typically on auth.users) that call user-defined functions.
// These are how Supabase apps wire "create profile on signup", etc.
export const SQL_AUTH_TRIGGERS = `
select n.nspname as schema, c.relname as table_name, t.tgname as name,
  pg_get_triggerdef(t.oid, true) || ';' as ddl
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
join pg_namespace n on n.oid = c.relnamespace
join pg_proc p on p.oid = t.tgfoid
join pg_namespace pn on pn.oid = p.pronamespace
where n.nspname = 'auth'
  and not t.tgisinternal
  and pn.nspname not in ('pg_catalog','information_schema')
order by c.relname, t.tgname;
`;

// Views
export const SQL_VIEWS = `
select n.nspname as schema, c.relname as name,
  format('create or replace view %I.%I as %s', n.nspname, c.relname, pg_get_viewdef(c.oid, true)) as ddl
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = '${SCHEMA}' and c.relkind = 'v'
order by c.relname;
`;

// RLS state per table
export const SQL_RLS = `
select n.nspname as schema, c.relname as table_name, c.relrowsecurity as enabled,
  c.relforcerowsecurity as forced
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = '${SCHEMA}' and c.relkind = 'r'
order by c.relname;
`;

// Policies
export const SQL_POLICIES = `
select schemaname as schema, tablename as table_name, policyname as name,
  format(
    'create policy %I on %I.%I as %s for %s to %s%s%s;',
    policyname, schemaname, tablename,
    permissive,
    cmd,
    array_to_string(roles, ', '),
    case when qual is not null then ' using (' || qual || ')' else '' end,
    case when with_check is not null then ' with check (' || with_check || ')' else '' end
  ) as ddl
from pg_policies
where schemaname = '${SCHEMA}'
order by tablename, policyname;
`;

// Row counts for UI
export const SQL_TABLE_ROWCOUNTS = `
select c.relname as name, c.reltuples::bigint as approx_rows
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = '${SCHEMA}' and c.relkind = 'r'
order by c.relname;
`;

// Build SQL to dump rows of a single table as JSON
export function sqlDumpTable(table: string): string {
  return `select to_jsonb(t.*) as row from ${SCHEMA}.${quoteIdent(table)} t;`;
}

export function quoteIdent(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

export function quoteLiteral(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "object") {
    return "'" + JSON.stringify(v).replace(/'/g, "''") + "'::jsonb";
  }
  return "'" + String(v).replace(/'/g, "''") + "'";
}
