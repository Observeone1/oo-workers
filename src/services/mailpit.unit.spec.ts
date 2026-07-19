/**
 * Mailpit read-back contract — the dev-only "did the test email actually
 * land" probe. Runs against a real local HTTP server standing in for the
 * Mailpit API; asserts the guard rails (opt-in env, local SMTP hosts only)
 * and the never-throws / { delivered: false } failure posture.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { findRecentTestMessage, isLocalMailpit } from './mailpit.ts';

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let messages: Array<{ Subject?: string; To?: Array<{ Address?: string }> }>;
let respondWith500 = false;

beforeAll(() => {
  messages = [];
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== '/api/v1/messages') return new Response('nope', { status: 404 });
      if (respondWith500) return new Response('boom', { status: 500 });
      return Response.json({ messages });
    },
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = ['OO_MAILPIT_API', 'OO_SMTP_HOST'];

beforeAll(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  respondWith500 = false;
  messages = [];
});

describe('isLocalMailpit', () => {
  test('is off by default (production posture)', () => {
    delete process.env.OO_MAILPIT_API;
    expect(isLocalMailpit()).toBe(false);
  });

  test('requires SMTP to point at a local Mailpit host', () => {
    process.env.OO_MAILPIT_API = 'http://localhost:8025';
    process.env.OO_SMTP_HOST = 'smtp.sendgrid.net';
    expect(isLocalMailpit()).toBe(false);

    for (const host of ['localhost', 'MAILPIT', '127.0.0.1']) {
      process.env.OO_SMTP_HOST = host;
      expect(isLocalMailpit()).toBe(true);
    }
  });
});

describe('findRecentTestMessage', () => {
  test('reports delivered:false immediately when read-back is disabled', async () => {
    delete process.env.OO_MAILPIT_API;
    const probe = await findRecentTestMessage({ subjectIncludes: 'anything' });
    expect(probe).toEqual({ delivered: false });
  });

  test('finds the matching message by subject substring and recipient', async () => {
    process.env.OO_MAILPIT_API = `${baseUrl}/`; // trailing slash is normalized
    messages = [
      { Subject: 'unrelated', To: [{ Address: 'ops@example.com' }] },
      {
        Subject: '[ObserveOne test] channel 7',
        To: [{ Address: '  Ops@Example.com ' }],
      },
    ];

    const probe = await findRecentTestMessage({
      to: 'ops@example.com',
      subjectIncludes: 'ObserveOne test',
    });

    expect(probe).toEqual({
      delivered: true,
      subject: '[ObserveOne test] channel 7',
      to: 'ops@example.com',
    });
  });

  test('matches by subject alone when no recipient filter is given', async () => {
    process.env.OO_MAILPIT_API = baseUrl;
    messages = [{ Subject: 'hello world', To: [] }];

    const probe = await findRecentTestMessage({ subjectIncludes: 'hello' });
    expect(probe.delivered).toBe(true);
    expect(probe.to).toBeUndefined();
  });

  test('reports delivered:false when the recipient never matches', async () => {
    process.env.OO_MAILPIT_API = baseUrl;
    messages = [{ Subject: 'the test mail', To: [{ Address: 'other@example.com' }] }];

    const probe = await findRecentTestMessage({
      to: 'ops@example.com',
      subjectIncludes: 'test mail',
      timeoutMs: 300,
    });
    expect(probe).toEqual({ delivered: false });
  });

  test('swallows server errors into delivered:false', async () => {
    process.env.OO_MAILPIT_API = baseUrl;
    respondWith500 = true;

    const probe = await findRecentTestMessage({
      subjectIncludes: 'x',
      timeoutMs: 300,
    });
    expect(probe).toEqual({ delivered: false });
  });

  test('swallows connection failures into delivered:false', async () => {
    // Nothing listens on this port.
    process.env.OO_MAILPIT_API = 'http://127.0.0.1:1';

    const probe = await findRecentTestMessage({
      subjectIncludes: 'x',
      timeoutMs: 300,
    });
    expect(probe).toEqual({ delivered: false });
  });
});
