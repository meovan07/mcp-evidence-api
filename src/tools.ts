import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { waitForEmail } from "./mail.js";
import type { SessionManager } from "./sessions.js";

function text(message: string) {
  return { content: [{ type: "text" as const, text: message }] };
}

export function registerTools(server: McpServer, sessions: SessionManager): void {
  server.registerTool(
    "start_evidence_session",
    {
      title: "Start evidence session",
      description:
        "Creates an evidence directory under `.evidence/<featureName>/<timestamp>/` in the current project. " +
        "Returns a sessionId to pass to `request`. Call finish_evidence_session when done.",
      inputSchema: {
        featureName: z.string().min(1).describe("Short name for the API/backend feature being verified"),
        baseUrl: z.string().url().optional().describe("Base URL of the API under test; relative request() urls resolve against this"),
      },
    },
    async ({ featureName, baseUrl }) => {
      const { sessionId, evidenceDir } = await sessions.start(featureName, baseUrl);
      return text(`Started evidence session ${sessionId}\nEvidence directory: ${evidenceDir}`);
    },
  );

  server.registerTool(
    "request",
    {
      title: "Request",
      description:
        "Makes an HTTP request and logs the full request/response pair (headers, body, status, timing) as " +
        "evidence. Sensitive headers (authorization, cookie, api-key, etc.) are redacted before being written " +
        "to disk. `url` may be relative to the session's baseUrl.",
      inputSchema: {
        sessionId: z.string(),
        name: z.string().optional().describe("Short label for this request, for readability in the evidence file"),
        method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]),
        url: z.string().min(1),
        headers: z.record(z.string(), z.string()).optional(),
        body: z.unknown().optional().describe("JSON-serializable request body"),
      },
    },
    async ({ sessionId, name, method, url, headers, body }) => {
      const record = await sessions.request(sessionId, { name, method, url, headers, body });
      const bodyPreview =
        typeof record.responseBody === "string"
          ? record.responseBody.slice(0, 300)
          : JSON.stringify(record.responseBody)?.slice(0, 300);
      return text(
        `${record.method} ${record.url} -> ${record.responseStatus} ${record.responseStatusText} ` +
          `(${record.durationMs}ms)\n${bodyPreview ?? ""}`,
      );
    },
  );

  server.registerTool(
    "finish_evidence_session",
    {
      title: "Finish evidence session",
      description:
        "Writes requests.json (all request/response pairs) and manifest.json (summary + failure count), " +
        "and returns the evidence folder path. Always call this at the end of a verification run.",
      inputSchema: {
        sessionId: z.string(),
        summary: z.string().optional().describe("Short human-readable summary of what was verified"),
      },
    },
    async ({ sessionId, summary }) => {
      const { evidenceDir, requestCount, failureCount } = await sessions.finish(sessionId, summary);
      return text(
        `Finished evidence session. Evidence saved to: ${evidenceDir}\n` +
          `Requests: ${requestCount}, failures (non-2xx): ${failureCount}` +
          (failureCount > 0 ? " (see requests.json for details)" : ""),
      );
    },
  );

  server.registerTool(
    "wait_for_email",
    {
      title: "Wait for email",
      description:
        "Polls an IMAP inbox for a new email matching the given filters (arrived after this call started, " +
        "so it never picks up a stale message from a previous run), and returns it. If `pattern` (a regex, " +
        "e.g. an OTP code like `\\\\d{6}`) is given, returns the first match from the body as `matchedText` " +
        "instead of the full email. Requires IMAP_USER and IMAP_APP_PASSWORD to be set as environment " +
        "variables on this MCP server (IMAP_HOST optional, defaults to imap.gmail.com).",
      inputSchema: {
        from: z.string().optional().describe("Only match emails from this sender (substring match)"),
        subjectContains: z.string().optional().describe("Only match emails whose subject contains this text"),
        pattern: z.string().optional().describe("Regex to extract from the email body, e.g. a 6-digit OTP code"),
        timeoutMs: z.number().optional().describe("Max time to wait, in milliseconds (default 30000)"),
        pollIntervalMs: z.number().optional().describe("How often to re-check the inbox, in milliseconds (default 2000)"),
      },
    },
    async ({ from, subjectContains, pattern, timeoutMs, pollIntervalMs }) => {
      const match = await waitForEmail({ from, subjectContains, pattern, timeoutMs, pollIntervalMs });
      if (match.matchedText) {
        return text(`Matched: ${match.matchedText}\n(from email "${match.subject}" sent by ${match.from})`);
      }
      return text(
        `Email received.\nFrom: ${match.from}\nSubject: ${match.subject}\nDate: ${match.date}\n\n${match.bodyText ?? ""}`,
      );
    },
  );
}
