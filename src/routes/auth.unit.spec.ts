/**
 * /api/auth/* HTTP contract — setup wizard gating, email/password and
 * legacy API-key login, the dual per-IP/per-email login rate limiter
 * (including the "a banned IP must not poison the email bucket" rule),
 * logout semantics, me, profile and password change. auth.service and the
 * key middleware are mocked at their module boundaries; the route logic
 * and rate limiter run for real, so every test uses its own IP/email.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';

import {
  authMiddlewareMock,
  authServiceMock,
  mockAuthMiddleware,
  mockAuthService,
} from '../test-support/shared-mocks.ts';

const {
  needsSetup,
  register,
  createSession,
  login,
  logoutSession,
  validateSession,
  updateProfile,
  changePassword,
} = authServiceMock;
const { validateKey, keyCtl } = authMiddlewareMock;

mockAuthService();
mockAuthMiddleware();

const { registerAuthRoutes } = await import('./auth.ts');

function makeApp(): Hono {
  const app = new Hono();
  registerAuthRoutes(app);
  return app;
}

let uniq = 0;
const nextIp = () => {
  uniq += 1;
  return `198.51.100.${uniq % 250}.${Math.floor(uniq / 250)}`;
};
const nextEmail = () => {
  uniq += 1;
  return `user${uniq}@example.com`;
};

function postJson(path: string, body: unknown, headers: Record<string, string> = {}) {
  return makeApp().request(path, {
    method: 'POST',
    body: JSON.stringify(body),
    headers,
  });
}

function loginReq(email: string, password: string, ip: string) {
  return postJson('/api/auth/login', { email, password }, { 'x-forwarded-for': ip });
}

beforeEach(() => {
  for (const m of [
    needsSetup,
    register,
    createSession,
    login,
    logoutSession,
    validateSession,
    updateProfile,
    changePassword,
    validateKey,
  ])
    m.mockReset();
  keyCtl.value = null;
  needsSetup.mockResolvedValue(false);
  login.mockResolvedValue(null);
  validateKey.mockResolvedValue(null);
  validateSession.mockResolvedValue(null);
  changePassword.mockResolvedValue({ ok: true });
});

describe('setup', () => {
  test('reports setup status', async () => {
    needsSetup.mockResolvedValue(true);
    const res = await makeApp().request('/api/auth/setup-status');
    expect(await res.json()).toEqual({ needsSetup: true });
  });

  test('refuses setup once a user exists', async () => {
    const res = await postJson('/api/auth/setup', {
      email: 'a@b.co',
      password: 'longenough',
    });
    expect(res.status).toBe(409);
    expect(register).not.toHaveBeenCalled();
  });

  test.each([
    [{ password: 'longenough' }, 'email and password required'],
    [{ email: 'a@b.co' }, 'email and password required'],
    [{ email: 'a@b.co', password: 'short' }, 'password must be at least 8 characters'],
  ])('rejects %j', async (body, error) => {
    needsSetup.mockResolvedValue(true);
    const res = await postJson('/api/auth/setup', body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error });
  });

  test('creates the first admin and opens a session', async () => {
    needsSetup.mockResolvedValue(true);
    register.mockResolvedValue({ name: 'Admin', email: 'a@b.co', role: 'admin' });
    createSession.mockResolvedValue('sess-token');

    const res = await postJson('/api/auth/setup', {
      email: ' a@b.co ',
      password: 'longenough',
      name: ' Admin ',
    });

    expect(register).toHaveBeenCalledWith('a@b.co', 'longenough', 'Admin');
    expect(res.headers.get('set-cookie')).toBe(
      'oo_session=sess-token; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000',
    );
    expect(await res.json()).toEqual({ name: 'Admin', email: 'a@b.co', role: 'admin' });
  });
});

describe('login with an API key (backwards compat)', () => {
  test('rejects a blank key', async () => {
    const res = await postJson('/api/auth/login', { key: '   ' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'key required' });
  });

  test('rejects an invalid key with 401', async () => {
    const res = await postJson('/api/auth/login', { key: 'oo_bad' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid or revoked key' });
  });

  test('sets the key as the session cookie on success', async () => {
    validateKey.mockResolvedValue({
      name: 'ci key',
      keyPrefix: 'oo_abc',
      scopes: ['read'],
    });

    const res = await postJson('/api/auth/login', { key: ' oo_valid ' });
    expect(res.headers.get('set-cookie')).toContain('oo_session=oo_valid;');
    expect(await res.json()).toEqual({
      name: 'ci key',
      prefix: 'oo_abc',
      scopes: ['read'],
    });
  });
});

describe('login with email/password', () => {
  test('requires both fields', async () => {
    const res = await loginReq('', 'pw', nextIp());
    expect(res.status).toBe(400);
  });

  test('rejects bad credentials with 401', async () => {
    const res = await loginReq(nextEmail(), 'wrong', nextIp());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'invalid email or password' });
  });

  test('logs in and sets the session cookie', async () => {
    login.mockResolvedValue({
      token: 'sess-42',
      user: { name: 'Sam', email: 's@o.com', role: 'admin' },
    });

    const res = await loginReq('s@o.com', 'correct', nextIp());
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('oo_session=sess-42;');
    expect(await res.json()).toEqual({ name: 'Sam', email: 's@o.com', role: 'admin' });
  });

  test('rate limits an IP after 10 attempts regardless of email', async () => {
    const ip = nextIp();
    for (let i = 0; i < 10; i++) {
      expect((await loginReq(nextEmail(), 'pw', ip)).status).toBe(401);
    }

    const res = await loginReq(nextEmail(), 'pw', ip);
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({
      error: 'too many login attempts; try again in a minute',
    });
  });

  test('rate limits an email across many IPs', async () => {
    const email = nextEmail();
    for (let i = 0; i < 10; i++) {
      expect((await loginReq(email, 'pw', nextIp())).status).toBe(401);
    }

    const res = await loginReq(email, 'pw', nextIp());
    expect(res.status).toBe(429);
  });

  test('a banned IP does not poison an untouched email bucket', async () => {
    const bannedIp = nextIp();
    for (let i = 0; i < 10; i++) await loginReq(nextEmail(), 'pw', bannedIp);

    // Banned IP keeps hammering one fresh email — all IP-rejected.
    const victim = nextEmail();
    for (let i = 0; i < 5; i++) {
      expect((await loginReq(victim, 'pw', bannedIp)).status).toBe(429);
    }

    // The legitimate user still gets through from their own IP.
    login.mockResolvedValue({
      token: 't',
      user: { name: 'V', email: victim, role: 'admin' },
    });
    expect((await loginReq(victim, 'correct', nextIp())).status).toBe(200);
  });
});

describe('logout', () => {
  test('clears the cookie even without a session', async () => {
    const res = await makeApp().request('/api/auth/logout', { method: 'POST' });
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toBe(
      'oo_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0',
    );
  });

  test('destroys a session token but not an API key', async () => {
    keyCtl.value = 'sess-token';
    await makeApp().request('/api/auth/logout', { method: 'POST' });
    expect(logoutSession).toHaveBeenCalledWith('sess-token');

    logoutSession.mockClear();
    keyCtl.value = 'oo_apikey';
    validateKey.mockResolvedValue({ name: 'key' });
    await makeApp().request('/api/auth/logout', { method: 'POST' });
    expect(logoutSession).not.toHaveBeenCalled();
  });
});

describe('me', () => {
  test('401 without credentials', async () => {
    expect((await makeApp().request('/api/auth/me')).status).toBe(401);
  });

  test('returns API key identity first', async () => {
    keyCtl.value = 'oo_key';
    validateKey.mockResolvedValue({ name: 'ci', keyPrefix: 'oo_k', scopes: ['read'] });

    const res = await makeApp().request('/api/auth/me');
    expect(await res.json()).toEqual({ name: 'ci', prefix: 'oo_k', scopes: ['read'] });
  });

  test('falls back to the dashboard session, then 401', async () => {
    keyCtl.value = 'sess';
    validateSession.mockResolvedValue({ name: 'Sam', email: 's@o.com', role: 'admin' });
    const res = await makeApp().request('/api/auth/me');
    expect(await res.json()).toEqual({ name: 'Sam', email: 's@o.com', role: 'admin' });

    validateSession.mockResolvedValue(null);
    const expired = await makeApp().request('/api/auth/me');
    expect(expired.status).toBe(401);
    expect(await expired.json()).toEqual({ error: 'invalid or expired session' });
  });
});

function patchProfile(body: unknown) {
  return makeApp().request('/api/auth/profile', {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

describe('profile + password', () => {
  test('profile requires a valid session', async () => {
    expect((await patchProfile({ name: 'x' })).status).toBe(401);

    keyCtl.value = 'sess';
    validateSession.mockResolvedValue(null);
    expect((await patchProfile({ name: 'x' })).status).toBe(401);
  });

  test('profile rejects an empty patch and updates trimmed fields', async () => {
    keyCtl.value = 'sess';
    validateSession.mockResolvedValue({ id: 1 });

    expect((await patchProfile({})).status).toBe(400);

    updateProfile.mockResolvedValue({ name: 'New', email: 'n@o.com', role: 'admin' });
    const res = await patchProfile({ name: ' New ' });
    expect(updateProfile).toHaveBeenCalledWith(1, { name: 'New', email: undefined });
    expect(await res.json()).toEqual({ name: 'New', email: 'n@o.com', role: 'admin' });
  });

  test('password change validates inputs and maps service errors', async () => {
    keyCtl.value = 'sess';
    validateSession.mockResolvedValue({ id: 1 });

    expect((await postJson('/api/auth/password', { currentPassword: 'x' })).status).toBe(400);
    expect(
      (
        await postJson('/api/auth/password', {
          currentPassword: 'x',
          newPassword: 'short',
        })
      ).status,
    ).toBe(400);

    changePassword.mockResolvedValue({ ok: false, error: 'current password is wrong' });
    const wrong = await postJson('/api/auth/password', {
      currentPassword: 'bad',
      newPassword: 'longenough',
    });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual({ error: 'current password is wrong' });

    changePassword.mockResolvedValue({ ok: true });
    const ok = await postJson('/api/auth/password', {
      currentPassword: 'good',
      newPassword: 'longenough',
    });
    expect(await ok.json()).toEqual({ ok: true });
    expect(changePassword).toHaveBeenCalledWith(1, 'good', 'longenough');
  });
});
