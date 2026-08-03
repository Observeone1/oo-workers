import { parseHexPayload } from '../services/udp-probe.ts';

const VALID_ASSERTION_TYPES = new Set([
  'status_code',
  'response_time',
  'json_path',
  'text_contains',
  'header',
]);
const VALID_ASSERTION_OPERATORS = new Set([
  'equals',
  'not_equals',
  'less_than',
  'greater_than',
  'contains',
  'not_contains',
  'exists',
]);

export function badPort(port: number): boolean {
  return !Number.isInteger(port) || port < 1 || port > 65535;
}

export function validatePayloadHex(hex: unknown): string | null {
  if (!hex) return null;
  try {
    parseHexPayload(hex as string);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'invalid payloadHex';
  }
}

export function validateApiAssertions(
  rawAssertions: unknown,
  opts?: { shortErrors?: boolean },
): string | null {
  if (!Array.isArray(rawAssertions)) return 'assertions must be an array';
  const short = opts?.shortErrors === true;
  for (let i = 0; i < rawAssertions.length; i++) {
    const a = rawAssertions[i] as { type?: unknown; operator?: unknown };
    if (!a || typeof a !== 'object') return `assertions[${i}] must be an object`;
    if (typeof a.type !== 'string' || !VALID_ASSERTION_TYPES.has(a.type)) {
      return short
        ? `assertions[${i}].type invalid`
        : `assertions[${i}].type must be one of: ${[...VALID_ASSERTION_TYPES].join(', ')}`;
    }
    if (typeof a.operator !== 'string' || !VALID_ASSERTION_OPERATORS.has(a.operator)) {
      return short
        ? `assertions[${i}].operator invalid`
        : `assertions[${i}].operator must be one of: ${[...VALID_ASSERTION_OPERATORS].join(', ')}`;
    }
  }
  return null;
}

function expectCnRegexText(raw: unknown): string {
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  return '';
}

export function parseExpectCnRegex(raw: unknown): { value: string | null } | { error: string } {
  const s = expectCnRegexText(raw);
  if (s.length === 0) return { value: null };
  if (s.length > 200) return { error: 'expectCnRegex too long (max 200 chars)' };
  if (/\([^()]*[+*][^()]*\)[+*]/.test(s)) {
    return { error: 'expectCnRegex has a trivially-nested quantifier' };
  }
  try {
    new RegExp(s);
  } catch (e) {
    return { error: `expectCnRegex invalid: ${e instanceof Error ? e.message : e}` };
  }
  return { value: s };
}
