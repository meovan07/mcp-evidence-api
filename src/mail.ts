import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

export interface EmailMatch {
  from?: string;
  subject?: string;
  date?: string;
  bodyText?: string;
  matchedText?: string;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name} environment variable. Set IMAP_USER and IMAP_APP_PASSWORD (and optionally ` +
        `IMAP_HOST, defaults to imap.gmail.com) when registering this MCP server.`,
    );
  }
  return value;
}

async function searchOnce(
  since: Date,
  filters: { from?: string; subjectContains?: string },
): Promise<EmailMatch | undefined> {
  const client = new ImapFlow({
    host: process.env.IMAP_HOST || "imap.gmail.com",
    port: 993,
    secure: true,
    auth: { user: requireEnv("IMAP_USER"), pass: requireEnv("IMAP_APP_PASSWORD") },
    logger: false,
  });

  await client.connect();
  try {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const uids = await client.search(
        {
          since,
          ...(filters.from ? { from: filters.from } : {}),
          ...(filters.subjectContains ? { subject: filters.subjectContains } : {}),
        },
        { uid: true },
      );
      if (!uids || uids.length === 0) return undefined;

      const latestUid = Math.max(...uids);
      const message = await client.fetchOne(String(latestUid), { source: true }, { uid: true });
      if (!message || !message.source) return undefined;

      const parsed = await simpleParser(message.source);
      return {
        from: parsed.from?.text,
        subject: parsed.subject,
        date: parsed.date?.toISOString(),
        bodyText: parsed.text,
      };
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }
}

export async function waitForEmail(args: {
  from?: string;
  subjectContains?: string;
  pattern?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<EmailMatch> {
  const timeoutMs = args.timeoutMs ?? 30_000;
  const pollIntervalMs = args.pollIntervalMs ?? 2_000;
  // Small buffer back from "now" to tolerate clock skew between this machine and the mail server,
  // without reaching so far back that a stale email from a previous run matches instead.
  const since = new Date(Date.now() - 10_000);
  const pattern = args.pattern ? new RegExp(args.pattern) : undefined;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const match = await searchOnce(since, { from: args.from, subjectContains: args.subjectContains });
    if (match) {
      if (pattern) {
        const found = match.bodyText?.match(pattern);
        if (found) return { ...match, matchedText: found[0] };
        // Matched an email but not the pattern yet — keep waiting in case this was an unrelated
        // email and the real one hasn't arrived, unless we're out of time.
      } else {
        return match;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for a matching email` +
          (pattern ? ` containing pattern ${pattern}` : "") +
          ".",
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}
