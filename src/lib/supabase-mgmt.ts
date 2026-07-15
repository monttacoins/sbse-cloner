// Helpers for the Supabase Management API.
// Docs: https://api.supabase.com/api/v1

const BASE = "https://api.supabase.com/v1";

export type Creds = { ref: string; token: string };
type FunctionBundleFile = { name: string; content: string | Blob; type?: string };
type FunctionBundle = {
  metadata: {
    entrypoint_path?: string;
    import_map_path?: string;
    static_patterns?: string[];
  };
  files: FunctionBundleFile[];
};

const normalizeFunctionPath = (path: string) =>
  path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/^\.\//, "");

async function api<T = unknown>(
  creds: Creds,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${creds.token}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `Supabase API ${init.method ?? "GET"} ${path} failed [${res.status}]: ${text.slice(0, 500)}`,
    );
  }
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

export async function runSql<T = Record<string, unknown>>(
  creds: Creds,
  query: string,
): Promise<T[]> {
  const r = await api<T[]>(creds, `/projects/${creds.ref}/database/query`, {
    method: "POST",
    body: JSON.stringify({ query }),
  });
  return r ?? [];
}

export const mgmt = {
  // Project / sanity
  getProject: (c: Creds) => api(c, `/projects/${c.ref}`),

  // Edge functions
  listFunctions: (c: Creds) =>
    api<Array<{ id: string; slug: string; name: string; status: string; verify_jwt: boolean; entrypoint_path?: string; import_map_path?: string }>>(
      c,
      `/projects/${c.ref}/functions`,
    ),
  getFunction: (c: Creds, slug: string) =>
    api<{ slug: string; name: string; verify_jwt: boolean; entrypoint_path?: string; import_map_path?: string }>(
      c,
      `/projects/${c.ref}/functions/${slug}`,
    ),
  getFunctionBody: (c: Creds, slug: string) =>
    api<string>(c, `/projects/${c.ref}/functions/${slug}/body`),
  getFunctionBundle: async (c: Creds, slug: string): Promise<FunctionBundle> => {
    const res = await fetch(`${BASE}/projects/${c.ref}/functions/${slug}/body`, {
      headers: {
        Authorization: `Bearer ${c.token}`,
        Accept: "multipart/form-data",
      },
    });
    const contentType = res.headers.get("content-type") ?? "";
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Function body ${slug} failed [${res.status}]: ${text.slice(0, 500)}`);
    }

    if (contentType.includes("multipart/form-data")) {
      const form = await res.formData();
      const metadataPart = form.get("metadata");
      let metadata: FunctionBundle["metadata"] = {};
      if (typeof metadataPart === "string" && metadataPart.trim()) {
        metadata = JSON.parse(metadataPart) as FunctionBundle["metadata"];
      } else if (metadataPart instanceof Blob) {
        const text = await metadataPart.text();
        if (text.trim()) metadata = JSON.parse(text) as FunctionBundle["metadata"];
      }

      const files = await Promise.all(
        form.getAll("file").map(async (part, index): Promise<FunctionBundleFile> => {
          if (typeof part === "string") {
            return { name: index === 0 ? (metadata.entrypoint_path ?? "index.ts") : `file-${index}.ts`, content: part };
          }
          const named = part as Blob & { name?: string };
          return {
            name: normalizeFunctionPath(named.name || (index === 0 ? (metadata.entrypoint_path ?? "index.ts") : `file-${index}.ts`)),
            content: part,
            type: part.type || "text/plain",
          };
        }),
      );
      if (files.length > 0) return { metadata, files };
      throw new Error(`Function body ${slug} returned no source files`);
    }

    const body = await res.text();
    return { metadata: {}, files: [{ name: "index.ts", content: body, type: "application/typescript" }] };
  },
  createFunction: (
    c: Creds,
    payload: { slug: string; name: string; body: string; verify_jwt?: boolean },
  ) =>
    api(c, `/projects/${c.ref}/functions`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  updateFunction: (
    c: Creds,
    slug: string,
    payload: { name?: string; body?: string; verify_jwt?: boolean },
  ) =>
    api(c, `/projects/${c.ref}/functions/${slug}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
  // Deploy via multipart — required for the dashboard "Code" view to load.
  deployFunction: async (
    c: Creds,
    opts: {
      slug: string;
      name: string;
      body?: string;
      files?: FunctionBundleFile[];
      verify_jwt?: boolean;
      entrypoint_path?: string;
      import_map_path?: string;
      static_patterns?: string[];
    },
  ) => {
    const files = opts.files?.length
      ? opts.files
      : [{ name: opts.entrypoint_path || "index.ts", content: opts.body ?? "", type: "application/typescript" }];
    const normalizedFiles = files.map((file) => ({ ...file, name: normalizeFunctionPath(file.name) }));
    const fileNames = new Set(normalizedFiles.map((file) => file.name));
    let entrypoint = normalizeFunctionPath(opts.entrypoint_path || normalizedFiles[0]?.name || "index.ts");
    if (!fileNames.has(entrypoint) && normalizedFiles.length === 1) entrypoint = normalizedFiles[0].name;
    const metadata: Record<string, unknown> = {
      entrypoint_path: entrypoint,
      name: opts.name,
      verify_jwt: opts.verify_jwt ?? true,
    };
    if (opts.import_map_path) metadata.import_map_path = opts.import_map_path;
    if (opts.static_patterns) metadata.static_patterns = opts.static_patterns;
    const fd = new FormData();
    fd.append("metadata", JSON.stringify(metadata));
    for (const file of normalizedFiles) {
      const blob = file.content instanceof Blob ? file.content : new Blob([file.content], { type: file.type || "text/plain" });
      fd.append("file", blob, file.name);
    }
    const res = await fetch(
      `${BASE}/projects/${c.ref}/functions/deploy?slug=${encodeURIComponent(opts.slug)}`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${c.token}` },
        body: fd,
      },
    );
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Deploy ${opts.slug} failed [${res.status}]: ${text.slice(0, 500)}`);
    }
    return text ? JSON.parse(text) : null;
  },


  // Storage
  listBuckets: (c: Creds) =>
    api<Array<{ id: string; name: string; public: boolean; file_size_limit?: number | null; allowed_mime_types?: string[] | null }>>(
      c,
      `/projects/${c.ref}/storage/buckets`,
    ),
  createBucket: async (
    c: Creds,
    payload: { id: string; name: string; public: boolean; file_size_limit?: number | null; allowed_mime_types?: string[] | null },
  ) => {
    // The Management API endpoint POST /v1/projects/{ref}/storage/buckets returns 404
    // on many projects. Use SQL insert against storage.buckets as a reliable fallback.
    const id = payload.id.replace(/'/g, "''");
    const name = (payload.name ?? payload.id).replace(/'/g, "''");
    const pub = payload.public ? "true" : "false";
    const sizeLimit =
      payload.file_size_limit === null || payload.file_size_limit === undefined
        ? "null"
        : String(payload.file_size_limit);
    const mimeTypes =
      payload.allowed_mime_types && payload.allowed_mime_types.length > 0
        ? `ARRAY[${payload.allowed_mime_types.map((m) => `'${m.replace(/'/g, "''")}'`).join(",")}]::text[]`
        : "null";
    const sql = `insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('${id}', '${name}', ${pub}, ${sizeLimit}, ${mimeTypes})
on conflict (id) do update set
  name = excluded.name,
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;`;
    return runSql(c, sql);
  },

  // Auth config
  getAuthConfig: (c: Creds) => api<Record<string, unknown>>(c, `/projects/${c.ref}/config/auth`),
  updateAuthConfig: (c: Creds, payload: Record<string, unknown>) =>
    api(c, `/projects/${c.ref}/config/auth`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),

  // PostgREST / Data API config (which schemas are exposed)
  getPostgrestConfig: (c: Creds) =>
    api<{ db_schema?: string; db_extra_search_path?: string; max_rows?: number }>(
      c,
      `/projects/${c.ref}/postgrest`,
    ),
  updatePostgrestConfig: (
    c: Creds,
    payload: { db_schema?: string; db_extra_search_path?: string; max_rows?: number },
  ) =>
    api(c, `/projects/${c.ref}/postgrest`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),
};
