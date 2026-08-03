/**
 * Mailpit read-back — dev convenience only.
 *
 * In dev, start-oo-workers.sh runs a Mailpit container and the dev .env
 * points OO_SMTP_* at it. When OO_MAILPIT_API is also set, the channel
 * "Send test" endpoint uses this to confirm the test email actually
 * landed (not just "SMTP accepted it"), so the operator gets a green
 * "delivered" tick instead of having to alt-tab to :8025.
 *
 * Strictly opt-in and isolated: with OO_MAILPIT_API unset (the default,
 * and always in production) isLocalMailpit() is false and none of this
 * runs — the test endpoint behaves byte-identically to before. Every
 * failure is swallowed into { delivered: false }; this never throws and
 * never affects whether the alert itself was sent.
 */

const LOCAL_SMTP_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'mailpit']);

/** Mailpit base URL, or null when read-back is not enabled. */
function mailpitApiBase(): string | null {
  const base = process.env.OO_MAILPIT_API?.trim();
  return base ? base.replace(/\/$/, '') : null;
}

/**
 * True only when OO_MAILPIT_API is set AND SMTP points at a local
 * Mailpit. Guards every read-back so production (no OO_MAILPIT_API) is
 * never touched.
 */
export function isLocalMailpit(): boolean {
  if (!mailpitApiBase()) return false;
  const host = process.env.OO_SMTP_HOST?.trim().toLowerCase();
  return !!host && LOCAL_SMTP_HOSTS.has(host);
}

interface MailpitListItem {
  Subject?: string;
  To?: Array<{ Address?: string }>;
}

export interface MailpitProbe {
  delivered: boolean;
  subject?: string;
  to?: string;
}

function matchingMessage(
  messages: MailpitListItem[],
  subjectIncludes: string,
  want: string | undefined,
  to: string | null | undefined,
): MailpitProbe | null {
  for (const message of messages) {
    const subject = message.Subject ?? '';
    if (!subject.includes(subjectIncludes)) continue;
    const addresses = (message.To ?? [])
      .map((recipient) => recipient.Address?.trim().toLowerCase())
      .filter((address): address is string => !!address);
    if (want && !addresses.includes(want)) continue;
    return { delivered: true, subject, to: to ?? undefined };
  }
  return null;
}

/**
 * Poll Mailpit for the most recent message matching `subjectIncludes`
 * (substring) and addressed to `to`. Best-effort: any error / timeout →
 * { delivered: false }. Never throws.
 */
export async function findRecentTestMessage(opts: {
  to?: string | null;
  subjectIncludes: string;
  timeoutMs?: number;
}): Promise<MailpitProbe> {
  const base = mailpitApiBase();
  if (!base) return { delivered: false };
  const deadline = Date.now() + (opts.timeoutMs ?? 4000);
  const want = opts.to?.trim().toLowerCase();

  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/v1/messages?limit=20`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const body = (await res.json()) as { messages?: MailpitListItem[] };
        const match = matchingMessage(body.messages ?? [], opts.subjectIncludes, want, opts.to);
        if (match) return match;
      }
    } catch {
      /* unreachable / aborted — fall through to retry or timeout */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return { delivered: false };
}
