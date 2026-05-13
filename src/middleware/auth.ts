/**
 * HTTP auth middleware — bearer-token or cookie-session.
 *
 * Cleartext API key format: `oo_<43 base64url chars>` (32 random bytes).
 * The first 11 chars (including `oo_`) are the prefix used for table
 * lookup; the full string is hashed with Bun.password (argon2id by
 * default) and stored as `key_hash`.
 *
 * Authentication sources, in priority order:
 *   1. `Authorization: Bearer oo_…` header (for CLI / tests / API
 *      consumers)
 *   2. `oo_session` HttpOnly cookie (for the dashboard — set by
 *      POST /api/auth/login)
 */

import type { Context, MiddlewareHandler } from 'hono';
import { apiKeyRepo, type ApiKeyRow } from '../db/repositories/api-key.repo.ts';
import { logger } from '../utils/logger.ts';

export const KEY_PREFIX_LEN = 11; // "oo_" + first 8 random chars
export const SESSION_COOKIE = 'oo_session';

export function extractKey(c: Context): string | null {
  const header = c.req.header('authorization');
  if (header) {
    const match = header.match(/^Bearer\s+(\S+)$/i);
    if (match) return match[1];
  }
  const cookie = c.req.header('cookie');
  if (cookie) {
    for (const part of cookie.split(';')) {
      const [k, ...rest] = part.trim().split('=');
      if (k === SESSION_COOKIE) return rest.join('=');
    }
  }
  return null;
}

/**
 * Validate a cleartext key against the DB. Returns the matching active
 * row or null. Used by both the auth middleware and the login endpoint.
 */
export async function validateKey(cleartext: string): Promise<ApiKeyRow | null> {
  if (!cleartext.startsWith('oo_') || cleartext.length < KEY_PREFIX_LEN + 1) return null;
  const prefix = cleartext.slice(0, KEY_PREFIX_LEN);
  const row = await apiKeyRepo.findActiveByPrefix(prefix);
  if (!row) return null;
  const ok = await Bun.password.verify(cleartext, row.keyHash);
  if (!ok) return null;
  return row;
}

/**
 * Hono middleware factory. Pass the required scope; the middleware
 * rejects (401) unauthenticated callers and (403) authenticated keys
 * lacking the scope.
 */
export function requireAuth(scope: 'read' | 'write'): MiddlewareHandler {
  return async (c, next) => {
    const cleartext = extractKey(c);
    if (!cleartext) return c.json({ error: 'authentication required' }, 401);

    const row = await validateKey(cleartext);
    if (!row) return c.json({ error: 'invalid or revoked key' }, 401);

    if (!row.scopes.includes(scope)) {
      return c.json({ error: `key lacks '${scope}' scope` }, 403);
    }

    // Fire-and-forget — don't block the request on the write.
    apiKeyRepo.touchLastUsed(row.id).catch((err) => {
      logger.error(`touchLastUsed(${row.id}) failed: ${err instanceof Error ? err.message : err}`);
    });

    c.set('apiKey', { id: row.id, name: row.name, prefix: row.keyPrefix, scopes: row.scopes });
    return next();
  };
}
