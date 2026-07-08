import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const IDLE_CHECK_INTERVAL_MS = 60 * 1000;
const MAX_BODY_CHARS = 10_000;
const REDACTED = "[REDACTED]";
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "x-auth-token",
]);

export interface RequestRecord {
  name?: string;
  method: string;
  url: string;
  requestHeaders?: Record<string, string>;
  requestBody?: unknown;
  responseStatus: number;
  responseStatusText: string;
  responseHeaders: Record<string, string>;
  responseBody: unknown;
  ok: boolean;
  durationMs: number;
  timestamp: string;
}

interface EvidenceSession {
  id: string;
  featureName: string;
  baseUrl?: string;
  evidenceDir: string;
  startedAt: string;
  lastActivity: number;
  requests: RequestRecord[];
}

function sanitize(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9-_]/g, "-").replace(/-+/g, "-").slice(0, 80);
  return cleaned || "unnamed";
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? REDACTED : value;
  }
  return result;
}

function truncate(text: string): string {
  return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}... [truncated]` : text;
}

async function parseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return truncate(text);
  }
}

export class SessionManager {
  private sessions = new Map<string, EvidenceSession>();
  private idleTimer: NodeJS.Timeout;

  constructor() {
    this.idleTimer = setInterval(() => {
      void this.reapIdleSessions();
    }, IDLE_CHECK_INTERVAL_MS);
    this.idleTimer.unref();
  }

  private get(sessionId: string): EvidenceSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(
        `Unknown sessionId: ${sessionId}. It may have already finished, or timed out after ${IDLE_TIMEOUT_MS / 60000} minutes of inactivity.`,
      );
    }
    session.lastActivity = Date.now();
    return session;
  }

  async start(featureName: string, baseUrl?: string): Promise<{ sessionId: string; evidenceDir: string }> {
    const id = randomUUID();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const evidenceDir = path.join(process.cwd(), ".evidence", sanitize(featureName), timestamp);
    await mkdir(evidenceDir, { recursive: true });

    this.sessions.set(id, {
      id,
      featureName,
      baseUrl,
      evidenceDir,
      startedAt: new Date().toISOString(),
      lastActivity: Date.now(),
      requests: [],
    });
    return { sessionId: id, evidenceDir };
  }

  async request(
    sessionId: string,
    args: { name?: string; method: string; url: string; headers?: Record<string, string>; body?: unknown },
  ): Promise<RequestRecord> {
    const session = this.get(sessionId);
    const target = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(args.url)
      ? args.url
      : session.baseUrl
        ? new URL(args.url, session.baseUrl).toString()
        : args.url;

    const hasBody = args.body !== undefined;
    const requestHeaders: Record<string, string> = { ...(args.headers ?? {}) };
    if (hasBody && !Object.keys(requestHeaders).some((h) => h.toLowerCase() === "content-type")) {
      requestHeaders["content-type"] = "application/json";
    }

    const startedAt = Date.now();
    const response = await fetch(target, {
      method: args.method,
      headers: requestHeaders,
      body: hasBody ? JSON.stringify(args.body) : undefined,
    });
    const durationMs = Date.now() - startedAt;

    const responseHeaders: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });

    const record: RequestRecord = {
      name: args.name,
      method: args.method.toUpperCase(),
      url: target,
      requestHeaders: redactHeaders(requestHeaders),
      requestBody: args.body,
      responseStatus: response.status,
      responseStatusText: response.statusText,
      responseHeaders: redactHeaders(responseHeaders),
      responseBody: await parseBody(response),
      ok: response.ok,
      durationMs,
      timestamp: new Date().toISOString(),
    };
    session.requests.push(record);
    return record;
  }

  async finish(
    sessionId: string,
    summary?: string,
  ): Promise<{ evidenceDir: string; requestCount: number; failureCount: number }> {
    const session = this.get(sessionId);
    return this.finalize(session, summary, "finished");
  }

  private async finalize(
    session: EvidenceSession,
    summary: string | undefined,
    reason: "finished" | "idle-timeout" | "shutdown",
  ): Promise<{ evidenceDir: string; requestCount: number; failureCount: number }> {
    this.sessions.delete(session.id);

    const failureCount = session.requests.filter((r) => !r.ok).length;

    await writeFile(
      path.join(session.evidenceDir, "requests.json"),
      JSON.stringify(session.requests, null, 2),
    );

    const manifest = {
      featureName: session.featureName,
      baseUrl: session.baseUrl,
      startedAt: session.startedAt,
      finishedAt: new Date().toISOString(),
      endReason: reason,
      summary,
      requestCount: session.requests.length,
      failureCount,
      requestsFile: "requests.json",
    };
    await writeFile(path.join(session.evidenceDir, "manifest.json"), JSON.stringify(manifest, null, 2));

    return { evidenceDir: session.evidenceDir, requestCount: session.requests.length, failureCount };
  }

  private async reapIdleSessions(): Promise<void> {
    const now = Date.now();
    for (const session of this.sessions.values()) {
      if (now - session.lastActivity > IDLE_TIMEOUT_MS) {
        console.error(`Session ${session.id} idle for over ${IDLE_TIMEOUT_MS / 60000} minutes, auto-finishing.`);
        await this.finalize(session, "auto-finished: idle timeout", "idle-timeout");
      }
    }
  }

  /** Best-effort flush of any still-open sessions so evidence isn't lost on shutdown/crash. */
  async shutdown(): Promise<void> {
    clearInterval(this.idleTimer);
    const sessions = [...this.sessions.values()];
    await Promise.all(
      sessions.map((session) => this.finalize(session, "auto-finished: server shutdown", "shutdown")),
    );
  }
}
