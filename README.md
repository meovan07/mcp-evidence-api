# mcp-evidence-api

An MCP server that makes backend/API requests and packages request+response
pairs as **evidence** — proving an endpoint works. Sibling project to
[mcp-evidence](https://github.com/meovan07/mcp-evidence), which does the same
thing for browser/UI flows; this one is for testing backend behavior with no
browser involved (video/trace don't mean anything without a page, so this is
a separate, much simpler tool rather than an extension of that one).

Generic and reusable: no assumptions about any particular API. You pass a
`baseUrl` per session, and evidence is written into the *consuming* project's
working directory at `.evidence/<featureName>/<timestamp>/`.

## Install

### Register with Claude Code

Per-user (available in every project):

```bash
claude mcp add --scope user evidence-api -- npx -y github:meovan07/mcp-evidence-api
```

Or per-project, add to `.mcp.json`:

```json
{
  "mcpServers": {
    "evidence-api": {
      "command": "npx",
      "args": ["-y", "github:meovan07/mcp-evidence-api"]
    }
  }
}
```

This repo is public, so no GitHub credentials are needed on the machine
running `npx`.

Consuming projects should add `.evidence/` to their own `.gitignore`.

## Tools

| Tool | Purpose |
|---|---|
| `start_evidence_session({ featureName, baseUrl? })` | Creates the evidence dir. Returns `sessionId`. |
| `request({ sessionId, name?, method, url, headers?, body? })` | Makes an HTTP request, logs the full request/response pair. `url` resolves against `baseUrl` if relative. |
| `finish_evidence_session({ sessionId, summary? })` | Writes `requests.json` and `manifest.json`, returns request/failure counts. |

A session left open for 10 minutes with no tool calls is auto-finished. The
server also flushes any open sessions on `SIGINT`/`SIGTERM` so evidence isn't
lost if the process is killed mid-run.

Sensitive request/response **headers** (`authorization`, `cookie`,
`set-cookie`, `x-api-key`, `api-key`, `x-auth-token`, `proxy-authorization`)
are redacted before being written to disk. This only covers header names —
if an endpoint echoes a secret back inside a JSON response *body*, that isn't
redacted, since there's no reliable way to tell a secret-looking field from a
normal one. Don't point this at endpoints that echo credentials in response
bodies without being aware evidence files will contain them in plaintext.

### Example

```
start_evidence_session({ featureName: "users api", baseUrl: "http://localhost:4000" })
  -> sessionId, evidenceDir

request({ sessionId, name: "create user", method: "POST", url: "/users", body: { name: "Ada" } })
request({ sessionId, name: "get user", method: "GET", url: "/users/1" })
finish_evidence_session({ sessionId, summary: "Users API create+fetch works" })
```

Resulting evidence directory:

```
.evidence/users-api/2026-07-08T08-41-21-754Z/
  requests.json
  manifest.json
```

`requests.json` is an array of full request/response records (method, url,
headers, body, status, timing). `manifest.json` is a summary: request count
and how many came back non-2xx.

## Development

```bash
npm install
npm run build   # tsc -> dist/
npm run dev     # tsc --watch
npm start        # node dist/index.js
```
