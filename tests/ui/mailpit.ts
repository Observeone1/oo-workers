/**
 * Spec-side Mailpit REST client — used by qa-alerting.e2e.spec.ts to
 * assert alert emails actually landed. Manual e2e only; deliberately
 * separate from src/services/mailpit.ts (no src↔tests cross-import).
 *
 * Mailpit API: GET /api/v1/messages (newest first), GET
 * /api/v1/message/{id} (full), DELETE /api/v1/messages (clear). No auth.
 */

const BASE = (process.env.OO_MAILPIT_API ?? 'http://localhost:8025').replace(/\/$/, '');

export interface MailpitMessage {
  ID: string;
  Subject: string;
  To: Array<{ Address: string }>;
  Text?: string;
  HTML?: string;
}

type ListItem = { ID: string; Subject: string; To: Array<{ Address: string }> };

export async function mailpitReachable(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/api/v1/messages?limit=1`, { signal: AbortSignal.timeout(2000) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function clearMailpit(): Promise<void> {
  await fetch(`${BASE}/api/v1/messages`, { method: 'DELETE' }).catch(() => {});
}

async function listMessages(): Promise<ListItem[]> {
  const r = await fetch(`${BASE}/api/v1/messages?limit=50`);
  if (!r.ok) return [];
  const j = (await r.json()) as { messages?: ListItem[] };
  return j.messages ?? [];
}

function matches(m: ListItem, subjectIncludes: string, to?: string): boolean {
  if (!m.Subject?.includes(subjectIncludes)) return false;
  if (to && !(m.To ?? []).some((t) => t.Address?.toLowerCase() === to.toLowerCase())) return false;
  return true;
}

/** Poll until a message matches; throw a debuggable error on timeout. */
export async function waitForMessage(opts: {
  subjectIncludes: string;
  to?: string;
  timeoutMs?: number;
}): Promise<MailpitMessage> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  let seen: string[] = [];
  while (Date.now() < deadline) {
    const msgs = await listMessages();
    seen = msgs.map((m) => m.Subject);
    const hit = msgs.find((m) => matches(m, opts.subjectIncludes, opts.to));
    if (hit) {
      const full = await fetch(`${BASE}/api/v1/message/${hit.ID}`);
      return (await full.json()) as MailpitMessage;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(
    `Mailpit: no message with subject containing "${opts.subjectIncludes}"` +
      `${opts.to ? ` to ${opts.to}` : ''} within ${timeoutMs / 1000}s. ` +
      `Subjects seen: ${seen.length ? seen.join(' | ') : '(none)'}`,
  );
}

/** Wait a grace window, then assert no matching message exists. */
export async function assertNoMessage(opts: {
  subjectIncludes?: string;
  to?: string;
  windowMs?: number;
}): Promise<void> {
  await new Promise((r) => setTimeout(r, opts.windowMs ?? 6000));
  const offending = (await listMessages()).filter(
    (m) =>
      (opts.subjectIncludes ? m.Subject?.includes(opts.subjectIncludes) : true) &&
      (opts.to
        ? (m.To ?? []).some((t) => t.Address?.toLowerCase() === opts.to!.toLowerCase())
        : true),
  );
  if (offending.length > 0) {
    throw new Error(
      `Mailpit: expected NO message but found ${offending.length}: ` +
        offending.map((m) => m.Subject).join(' | '),
    );
  }
}
