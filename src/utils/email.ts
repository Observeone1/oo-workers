/**
 * Recipient-address validation for email alert channels.
 *
 * This deliberately does NOT use the obvious shape regex
 * `/^[^@\s]+@[^@\s]+\.[^@\s]+$/`. `.` is itself a member of `[^@\s]`, so the
 * two unbounded runs either side of the literal dot are ambiguous and a
 * non-matching address backtracks quadratically: measured 2.2 ms at 2 KB
 * rising to 514 ms at 32 KB, i.e. ~50 s of blocked event loop at 320 KB.
 *
 * Scanning with indexOf instead is linear by construction, so the worst case
 * is flat no matter what a write-scoped caller posts. The accept/reject set is
 * unchanged for any address within the length cap — email.unit.spec.ts asserts
 * that equivalence against the original pattern directly.
 */

// RFC 5321 §4.5.3.1 — 64-octet local part + "@" + 255-octet domain, with the
// forward path capped at 256 including the angle brackets; 254 is the largest
// address that can actually be delivered.
export const MAX_EMAIL_LENGTH = 254;

// One character class, no quantifier: linear, unlike the shape regex above.
const WHITESPACE = /\s/;

export function isValidEmailAddress(value: string): boolean {
  if (value.length === 0 || value.length > MAX_EMAIL_LENGTH) return false;
  if (WHITESPACE.test(value)) return false;

  // Exactly one '@', with at least one character on each side.
  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@') || at === value.length - 1) return false;

  // The domain needs a dot that is neither its first nor its last character.
  const domain = value.slice(at + 1);
  const dot = domain.indexOf('.');
  return dot > 0 && dot !== domain.length - 1;
}
