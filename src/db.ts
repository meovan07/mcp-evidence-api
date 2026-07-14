import { Client } from "pg";

const MAX_ROWS = 50;
const MAX_CELL_CHARS = 2000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} environment variable. Set DATABASE_URL when registering this MCP server.`);
  }
  return value;
}

// First line of defense before the DB-level read-only enforcement below (which is the real guard —
// this just rejects obviously-wrong input early with a clearer error message).
function assertReadOnlyQuery(sql: string): void {
  const stripped = sql
    .replace(/--.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .trim();
  const statements = stripped
    .split(";")
    .map((statement) => statement.trim())
    .filter(Boolean);
  if (statements.length > 1) {
    throw new Error("Only a single SELECT statement is allowed (multiple statements detected).");
  }
  const first = (statements[0] ?? "").toLowerCase();
  if (!/^(select|with)\b/.test(first)) {
    throw new Error("Only SELECT queries are allowed. This tool is read-only by design.");
  }
}

function truncateValue(value: unknown): unknown {
  if (typeof value === "string" && value.length > MAX_CELL_CHARS) {
    return `${value.slice(0, MAX_CELL_CHARS)}... [truncated]`;
  }
  return value;
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
  durationMs: number;
}

export async function runQuery(sql: string, params: unknown[] = []): Promise<QueryResult> {
  assertReadOnlyQuery(sql);

  const client = new Client({ connectionString: requireEnv("DATABASE_URL") });
  await client.connect();
  try {
    // Belt-and-suspenders: enforce read-only at the database level too, so even a write hidden
    // in a way that slips past assertReadOnlyQuery's string parsing gets rejected by Postgres
    // itself (throws "cannot execute ... in a read-only transaction"), not just by our regex.
    await client.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");

    const startedAt = Date.now();
    const result = await client.query(sql, params);
    const durationMs = Date.now() - startedAt;

    const truncated = result.rows.length > MAX_ROWS;
    const rows = result.rows.slice(0, MAX_ROWS).map((row) => {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) out[key] = truncateValue(value);
      return out;
    });

    return { rows, rowCount: result.rowCount ?? result.rows.length, truncated, durationMs };
  } finally {
    await client.end();
  }
}
