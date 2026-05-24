/**
 * /api/keys — list (read-scoped), create + revoke (write-scoped).
 * Cleartext returned once on create, mirrors `scripts/create-api-key.ts`.
 */
import type { Hono } from 'hono';
import { randomBytes } from 'node:crypto';
import { KEY_PREFIX_LEN, requireAuth, evictFromKeyCache } from '../middleware/auth.ts';
import { apiKeyRepo } from '../db/repositories/api-key.repo.ts';
import type { RouteDeps } from './types.ts';

const VALID_SCOPES = ['read', 'write'] as const;

export function registerApiKeyRoutes(app: Hono, { writeAuth }: RouteDeps): void {
  app.get('/api/keys', requireAuth('read'), async (c) => {
    return c.json(await apiKeyRepo.list());
  });

  app.post('/api/keys', writeAuth, async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!name) return c.json({ error: 'name is required' }, 400);

    const rawScopes: unknown = body.scopes;
    const scopes = Array.isArray(rawScopes) && rawScopes.length ? rawScopes : ['write'];
    if (!scopes.every((s) => (VALID_SCOPES as readonly string[]).includes(s))) {
      return c.json({ error: "scopes must be a non-empty subset of ['read','write']" }, 400);
    }

    // 32 bytes → 43 base64url chars; prefix is `oo_` + first 8.
    const cleartext = `oo_${randomBytes(32).toString('base64url')}`;
    const keyPrefix = cleartext.slice(0, KEY_PREFIX_LEN);
    const keyHash = await Bun.password.hash(cleartext, { algorithm: 'argon2id' });
    const [row] = await apiKeyRepo.create({ name, keyPrefix, keyHash, scopes });

    return c.json({
      id: row.id,
      name: row.name,
      keyPrefix: row.keyPrefix,
      scopes: row.scopes,
      cleartextKey: cleartext,
    });
  });

  app.post('/api/keys/:id/revoke', writeAuth, async (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'bad key id' }, 400);
    await apiKeyRepo.revoke(id);
    evictFromKeyCache(id);
    return c.body(null, 204);
  });
}
