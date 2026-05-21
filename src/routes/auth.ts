/**
 * /api/auth/* — setup wizard, login (email/password OR API key), logout,
 * me, profile, password change. All but setup-status check or mutate
 * session state.
 */
import type { Context, Hono } from 'hono';
import { extractKey, validateKey } from '../middleware/auth.ts';
import { authService, SESSION_COOKIE } from '../services/auth.service.ts';

const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function cookieHeader(token: string): string {
  return `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MAX_AGE}`;
}

// In-memory login rate limiter. Per-IP and per-email buckets,
// counter-and-reset so brute-force attempts above LOGIN_LIMIT_MAX in
// LOGIN_LIMIT_WINDOW_MS get 429 until the window expires. argon2id
// is already slow (~100ms) so this isn't the only line of defense,
// but it caps a parallel multi-IP attack against one account, and
// catches single-IP enumeration trying lots of addresses.
const LOGIN_LIMIT_MAX = 10;
const LOGIN_LIMIT_WINDOW_MS = 60_000;
const LOGIN_LIMIT_CACHE_MAX = 2048;

interface RateBucket {
  count: number;
  resetAt: number;
}

const ipBuckets = new Map<string, RateBucket>();
const emailBuckets = new Map<string, RateBucket>();

function clientIp(c: Context): string {
  // Trust X-Forwarded-For if the operator is behind a proxy (Caddy /
  // Traefik / Tailscale). Otherwise fall back to the connecting peer.
  const xff = c.req.header('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return c.req.header('x-real-ip') ?? 'unknown';
}

function rateAllow(bucket: Map<string, RateBucket>, key: string): boolean {
  const now = Date.now();
  const b = bucket.get(key);
  if (!b || b.resetAt < now) {
    if (bucket.size >= LOGIN_LIMIT_CACHE_MAX) {
      const oldest = bucket.keys().next().value;
      if (oldest) bucket.delete(oldest);
    }
    bucket.set(key, { count: 1, resetAt: now + LOGIN_LIMIT_WINDOW_MS });
    return true;
  }
  if (b.count >= LOGIN_LIMIT_MAX) return false;
  b.count++;
  return true;
}

export function registerAuthRoutes(app: Hono): void {
  // GET /api/auth/setup-status — returns { needsSetup: boolean }
  app.get('/api/auth/setup-status', async (c) => {
    const needsSetup = await authService.needsSetup();
    return c.json({ needsSetup });
  });

  // POST /api/auth/setup — create first admin (only when no users exist)
  app.post('/api/auth/setup', async (c) => {
    const needsSetup = await authService.needsSetup();
    if (!needsSetup) return c.json({ error: 'already set up' }, 409);

    const body = await c.req.json().catch(() => ({}));
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (!email || !password) return c.json({ error: 'email and password required' }, 400);
    if (password.length < 8) {
      return c.json({ error: 'password must be at least 8 characters' }, 400);
    }

    const user = await authService.register(email, password, name);
    const token = await authService.createSession(user);
    c.header('set-cookie', cookieHeader(token));
    return c.json({ name: user.name, email: user.email, role: user.role });
  });

  // POST /api/auth/login — body { email, password } or { key } (backwards compat)
  app.post('/api/auth/login', async (c) => {
    const body = await c.req.json().catch(() => ({}));

    // Backwards compat: API key login
    if (body.key) {
      const key = typeof body.key === 'string' ? body.key.trim() : '';
      if (!key) return c.json({ error: 'key required' }, 400);
      const row = await validateKey(key);
      if (!row) return c.json({ error: 'invalid or revoked key' }, 401);
      c.header('set-cookie', cookieHeader(key));
      return c.json({ name: row.name, prefix: row.keyPrefix, scopes: row.scopes });
    }

    // Email/password login
    const email = typeof body.email === 'string' ? body.email.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    if (!email || !password) return c.json({ error: 'email and password required' }, 400);

    // Rate limit: per-IP first, then per-email. Both buckets must accept
    // or the request gets 429. Don't increment the email bucket on an
    // IP-rejected request (that would let a banned IP poison the email
    // counter and lock out the legitimate user).
    const ip = clientIp(c);
    if (!rateAllow(ipBuckets, ip)) {
      return c.json({ error: 'too many login attempts; try again in a minute' }, 429);
    }
    if (!rateAllow(emailBuckets, email.toLowerCase())) {
      return c.json({ error: 'too many login attempts; try again in a minute' }, 429);
    }

    const result = await authService.login(email, password);
    if (!result) return c.json({ error: 'invalid email or password' }, 401);

    c.header('set-cookie', cookieHeader(result.token));
    return c.json({ name: result.user.name, email: result.user.email, role: result.user.role });
  });

  // POST /api/auth/logout — clears the cookie and destroys the session
  app.post('/api/auth/logout', async (c) => {
    const cleartext = extractKey(c);
    if (cleartext) {
      // API-key cookie: nothing to destroy server-side, just clear it.
      // Otherwise treat the value as a session token and delete that one
      // session (only — never all of the user's sessions).
      const row = await validateKey(cleartext);
      if (!row) {
        await authService.logoutSession(cleartext).catch(() => {});
      }
    }
    c.header('set-cookie', `${SESSION_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
    return c.body(null, 204);
  });

  // GET /api/auth/me — returns user or API key info
  app.get('/api/auth/me', async (c) => {
    const cleartext = extractKey(c);
    if (!cleartext) return c.json({ error: 'not authenticated' }, 401);

    // API key first (backwards compat), then a dashboard session cookie.
    const row = await validateKey(cleartext);
    if (row) return c.json({ name: row.name, prefix: row.keyPrefix, scopes: row.scopes });

    const user = await authService.validateSession(cleartext);
    if (user) return c.json({ name: user.name, email: user.email, role: user.role });

    return c.json({ error: 'invalid or expired session' }, 401);
  });

  // PATCH /api/auth/profile — update name/email for the logged-in user
  app.patch('/api/auth/profile', async (c) => {
    const cleartext = extractKey(c);
    if (!cleartext) return c.json({ error: 'not authenticated' }, 401);
    const user = await authService.validateSession(cleartext);
    if (!user) return c.json({ error: 'not authenticated' }, 401);
    const body = await c.req.json().catch(() => ({}));
    const name = typeof body.name === 'string' ? body.name.trim() : undefined;
    const email = typeof body.email === 'string' ? body.email.trim() : undefined;
    if (!name && !email) return c.json({ error: 'nothing to update' }, 400);
    const updated = await authService.updateProfile(user.id, { name, email });
    return c.json({ name: updated.name, email: updated.email, role: updated.role });
  });

  // POST /api/auth/password — change password for the logged-in user
  app.post('/api/auth/password', async (c) => {
    const cleartext = extractKey(c);
    if (!cleartext) return c.json({ error: 'not authenticated' }, 401);
    const user = await authService.validateSession(cleartext);
    if (!user) return c.json({ error: 'not authenticated' }, 401);
    const body = await c.req.json().catch(() => ({}));
    const currentPassword = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
    if (!currentPassword || !newPassword)
      return c.json({ error: 'currentPassword and newPassword required' }, 400);
    if (newPassword.length < 8)
      return c.json({ error: 'new password must be at least 8 characters' }, 400);
    const result = await authService.changePassword(user.id, currentPassword, newPassword);
    if (!result.ok) return c.json({ error: result.error }, 400);
    return c.json({ ok: true });
  });
}
