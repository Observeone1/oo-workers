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

import { createHash } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { apiKeyRepo, type ApiKeyRow } from '../db/repositories/api-key.repo.ts';
import { regionRepo } from '../db/repositories/region.repo.ts';
import { logger } from '../utils/logger.ts';
import { authService, SESSION_COOKIE } from '../services/auth.service.ts';

export type Scope = 'read' | 'write' | 'agent';

export const KEY_PREFIX_LEN = 11; // "oo_" + first 8 random chars

// Validated-key cache. argon2id verify is intentionally slow (~100ms);
// without a cache an agent doing long-poll fetches paid that cost on
// every request. Key is sha256(cleartext) so we never keep the
// cleartext itself in memory; value is the validated row + expiry.
// 30 seconds is short enough that key revocation propagates within a
// reasonable window (the dashboard's "Revoke" UI says nothing about
// instant kill — operators expect a brief delay) and long enough that
// a typical long-poll cadence (30s) hits cache.
const VALIDATE_KEY_CACHE_TTL_MS = 30_000;
const VALIDATE_KEY_CACHE = new Map<string, { row: ApiKeyRow; expiresAt: number }>();

function hashCleartextForCache(cleartext: string): string {
  return createHash('sha256').update(cleartext).digest('hex');
}

/** Cap cache size so a flood of distinct invalid keys can't exhaust memory. */
const VALIDATE_KEY_CACHE_MAX = 1024;

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
 * Remove a specific key from the validated-key cache by its DB id.
 * Call this immediately after revoking a key so the next request with
 * that key hits the DB and gets a 401 instead of sailing through on the
 * stale cache entry.
 */
export function evictFromKeyCache(keyId: number): void {
  for (const [hash, entry] of VALIDATE_KEY_CACHE.entries()) {
    if (entry.row.id === keyId) {
      VALIDATE_KEY_CACHE.delete(hash);
      break;
    }
  }
}

/**
 * Validate a cleartext key against the DB. Returns the matching active
 * row or null. Used by both the auth middleware and the login endpoint.
 *
 * Caches successful verifications for `VALIDATE_KEY_CACHE_TTL_MS` (30s)
 * so high-throughput agents long-polling don't pay the argon2 cost
 * per request. Cache key is sha256(cleartext) — the cleartext is never
 * stored. Cache misses still do a real DB lookup + argon2 verify.
 *
 * Revocation takes effect within `VALIDATE_KEY_CACHE_TTL_MS` (not
 * instantly) — acceptable for an open-source dashboard where the
 * "Revoke" affordance is a single-operator decision, not a panic
 * button. If a hard-kill is ever needed, restart the process.
 */
export async function validateKey(cleartext: string): Promise<ApiKeyRow | null> {
  if (!cleartext.startsWith('oo_') || cleartext.length < KEY_PREFIX_LEN + 1) return null;

  const cacheKey = hashCleartextForCache(cleartext);
  const cached = VALIDATE_KEY_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.row;
  }

  const prefix = cleartext.slice(0, KEY_PREFIX_LEN);
  const row = await apiKeyRepo.findActiveByPrefix(prefix);
  if (!row) return null;
  const ok = await Bun.password.verify(cleartext, row.keyHash);
  if (!ok) return null;

  // LRU-ish eviction: when full, dump the oldest entry. Map iteration
  // order is insertion order in JS, so .keys().next().value is the
  // oldest. Good enough — we only cap to bound memory under attack.
  if (VALIDATE_KEY_CACHE.size >= VALIDATE_KEY_CACHE_MAX) {
    const oldest = VALIDATE_KEY_CACHE.keys().next().value;
    if (oldest) VALIDATE_KEY_CACHE.delete(oldest);
  }
  VALIDATE_KEY_CACHE.set(cacheKey, { row, expiresAt: Date.now() + VALIDATE_KEY_CACHE_TTL_MS });
  return row;
}

/**
 * Hono middleware factory. Pass the required scope; the middleware
 * rejects (401) unauthenticated callers and (403) authenticated keys
 * lacking the scope.
 */
export function requireAuth(scope: Scope): MiddlewareHandler {
  return async (c, next) => {
    const cleartext = extractKey(c);
    if (!cleartext) return c.json({ error: 'authentication required' }, 401);

    const row = await validateKey(cleartext);
    if (row) {
      // Write implies read — a key authorised to mutate state is also
      // authorised to read it. Keeps the create-api-key default (write)
      // useful for the artifact proxy and any future read-only endpoints
      // without forcing operators to mint a separate read key.
      const allowed =
        row.scopes.includes(scope) || (scope === 'read' && row.scopes.includes('write'));
      if (!allowed) {
        return c.json({ error: `key lacks '${scope}' scope` }, 403);
      }

      // Fire-and-forget — don't block the request on the write.
      apiKeyRepo.touchLastUsed(row.id).catch((err) => {
        logger.error(
          `touchLastUsed(${row.id}) failed: ${err instanceof Error ? err.message : err}`,
        );
      });

      c.set('apiKey', { id: row.id, name: row.name, prefix: row.keyPrefix, scopes: row.scopes });
      return next();
    }

    // Not an API key — fall back to a dashboard session cookie. A logged-in
    // user is a full operator (single-tier authz): read + write, but never
    // the agent scope — agents must authenticate with a region-bound key.
    const user = await authService.validateSession(cleartext);
    if (user) {
      if (scope === 'agent') {
        return c.json({ error: `key lacks '${scope}' scope` }, 403);
      }
      c.set('user', { id: user.id, email: user.email, name: user.name, role: user.role });
      return next();
    }

    return c.json({ error: 'invalid or revoked key' }, 401);
  };
}

/**
 * Agent middleware — validates a key with the `agent` scope and resolves
 * the region it's bound to. Sets `c.var.region` for downstream handlers
 * to use without re-querying.
 *
 * Free heartbeat: every authenticated agent request touches the region's
 * last_seen_at, so the UI can show online/offline without a dedicated
 * heartbeat endpoint.
 */
export function requireAgent(): MiddlewareHandler {
  return async (c, next) => {
    const cleartext = extractKey(c);
    if (!cleartext) return c.json({ error: 'agent authentication required' }, 401);

    const row = await validateKey(cleartext);
    if (!row) return c.json({ error: 'invalid or revoked agent key' }, 401);

    if (!row.scopes.includes('agent')) {
      return c.json({ error: "key lacks 'agent' scope" }, 403);
    }

    const region = await regionRepo.findByApiKeyId(row.id);
    if (!region) {
      return c.json({ error: 'agent key is not bound to any region' }, 403);
    }

    apiKeyRepo.touchLastUsed(row.id).catch((err) => {
      logger.error(`touchLastUsed(${row.id}) failed: ${err instanceof Error ? err.message : err}`);
    });
    // Read the agent's reported version (Roadmap follow-up: version-skew).
    // Optional — older agents won't send it; the repo treats undefined
    // as "leave column unchanged" so we don't blow away a known value.
    const agentVersion = c.req.header('X-Agent-Version') ?? null;
    regionRepo.touchLastSeen(region.id, agentVersion).catch((err) => {
      logger.error(
        `touchLastSeen(region#${region.id}) failed: ${err instanceof Error ? err.message : err}`,
      );
    });

    c.set('apiKey', { id: row.id, name: row.name, prefix: row.keyPrefix, scopes: row.scopes });
    c.set('region', { id: region.id, slug: region.slug, label: region.label });
    return next();
  };
}

// Hono context variable types — opt in via module augmentation so
// c.get('apiKey') / c.get('region') return typed values without casts.
declare module 'hono' {
  interface ContextVariableMap {
    apiKey: { id: number; name: string; prefix: string; scopes: string[] };
    region: { id: number; slug: string; label: string };
    user: { id: number; email: string; name: string; role: string };
  }
}
