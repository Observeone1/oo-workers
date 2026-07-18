/**
 * Recipient-address validation for email alert channels.
 *
 * The shape check is deliberately paired with a hard length cap. The pattern
 * has two unbounded `[^@\s]+` runs either side of a literal `.`, and `.` is
 * itself a member of `[^@\s]`, so a long address that fails the trailing
 * anchor backtracks over every possible split: measured 2.2 ms at 2 KB rising
 * to 514 ms at 32 KB (quadratic), i.e. ~50 s at 320 KB. Checking the length
 * first keeps the worst case flat no matter what a write-scoped caller posts.
 */

// RFC 5321 §4.5.3.1 — 64-octet local part + "@" + 255-octet domain, with the
// forward path capped at 256 including the angle brackets; 254 is the largest
// address that can actually be delivered.
export const MAX_EMAIL_LENGTH = 254;

const EMAIL_SHAPE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function isValidEmailAddress(value: string): boolean {
  // Length first: `&&` short-circuits, so the regex never sees a long string.
  return value.length <= MAX_EMAIL_LENGTH && EMAIL_SHAPE.test(value);
}
