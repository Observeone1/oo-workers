/**
 * sendToChannel contract — the payload each channel type actually POSTs,
 * and the best-effort failure semantics (false, never throw). Runs against
 * a real local HTTP server so the wire format is asserted end to end;
 * nothing inside alert-dispatch is mocked.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { AlertChannelRow } from '../db/repositories/alert-channel.repo.ts';
import { sendToChannel, type AlertContext } from './alert-dispatch.ts';

let server: ReturnType<typeof Bun.serve>;
let baseUrl: string;
let received: Array<{ path: string; contentType: string | null; body: any }>;

beforeAll(() => {
  received = [];
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      received.push({
        path: url.pathname,
        contentType: req.headers.get('content-type'),
        body: await req.json(),
      });
      if (url.pathname === '/fail-500') return new Response('boom', { status: 500 });
      return new Response('ok');
    },
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server.stop(true);
});

const channel = (type: string, config: Record<string, unknown>): AlertChannelRow =>
  ({ id: 7, name: 'test channel', type, config, enabled: true }) as AlertChannelRow;

const outageCtx: AlertContext = {
  monitor: { type: 'url', id: 42, name: 'checkout', target: 'https://shop.example/health' },
  event: 'outage',
  status: 'FAILED',
  statusCode: 503,
  errorMessage: 'HTTP 503',
  durationMs: 812,
  startTime: '2026-07-13T09:30:00.000Z',
  regionSlug: 'eu-central',
};

const recoveryCtx: AlertContext = {
  monitor: { type: 'tcp', id: 5, name: 'db port', target: 'db.internal:5432' },
  event: 'recovery',
  status: 'SUCCESS',
  startTime: '2026-07-13T10:00:00.000Z',
};

function lastBody(): any {
  return received.at(-1)!.body;
}

describe('sendToChannel — webhook', () => {
  test('POSTs the full machine-readable payload as JSON', async () => {
    const ok = await sendToChannel(channel('webhook', { url: `${baseUrl}/hook` }), outageCtx);
    expect(ok).toBe(true);
    const { contentType, body } = received.at(-1)!;
    expect(contentType).toBe('application/json');
    expect(body).toEqual({
      event: 'outage',
      monitor: { type: 'url', id: 42, name: 'checkout', target: 'https://shop.example/health' },
      status: 'FAILED',
      statusCode: 503,
      errorMessage: 'HTTP 503',
      durationMs: 812,
      startTime: '2026-07-13T09:30:00.000Z',
      regionSlug: 'eu-central',
    });
  });

  test('normalizes absent optional fields to explicit nulls', async () => {
    await sendToChannel(channel('webhook', { url: `${baseUrl}/hook` }), recoveryCtx);
    const body = lastBody();
    expect(body.statusCode).toBeNull();
    expect(body.errorMessage).toBeNull();
    expect(body.durationMs).toBeNull();
    expect(body.regionSlug).toBeNull();
  });
});

describe('sendToChannel — discord', () => {
  test('outage embed carries headline, red color, and all context lines', async () => {
    await sendToChannel(channel('discord', { url: `${baseUrl}/discord` }), outageCtx);
    const [embed] = lastBody().embeds;
    expect(embed.title).toBe('🔥 checkout is down');
    expect(embed.color).toBe(0xdc2626);
    expect(embed.timestamp).toBe('2026-07-13T09:30:00.000Z');
    expect(embed.description).toContain('**Target:** https://shop.example/health');
    expect(embed.description).toContain('**Type:** URL');
    expect(embed.description).toContain('**Status code:** 503');
    expect(embed.description).toContain('**Latency:** 812ms');
    expect(embed.description).toContain('**Region:** eu-central');
    expect(embed.description).toContain('**Error:** HTTP 503');
  });

  test('recovery embed flips headline and color, omits absent fields', async () => {
    await sendToChannel(channel('discord', { url: `${baseUrl}/discord` }), recoveryCtx);
    const [embed] = lastBody().embeds;
    expect(embed.title).toBe('✅ db port recovered');
    expect(embed.color).toBe(0x16a34a);
    expect(embed.description).not.toContain('Status code');
    expect(embed.description).not.toContain('Error');
  });
});

describe('sendToChannel — slack', () => {
  test('builds header + section blocks with only the fields present', async () => {
    await sendToChannel(channel('slack', { url: `${baseUrl}/slack` }), recoveryCtx);
    const body = lastBody();
    expect(body.text).toBe('✅ db port recovered');
    expect(body.blocks[0]).toEqual({
      type: 'header',
      text: { type: 'plain_text', text: '✅ db port recovered', emoji: true },
    });
    const fields = body.blocks[1].fields.map((f: { text: string }) => f.text);
    expect(fields).toEqual(['*Target*\ndb.internal:5432', '*Type*\nTCP']);
    // No error → no trailing error section.
    expect(body.blocks).toHaveLength(2);
  });

  test('truncates the error section to 500 chars', async () => {
    const longError = 'x'.repeat(600);
    await sendToChannel(channel('slack', { url: `${baseUrl}/slack` }), {
      ...outageCtx,
      errorMessage: longError,
    });
    const errBlock = lastBody().blocks.at(-1);
    expect(errBlock.text.text).toBe(`*Error*\n\`\`\`${'x'.repeat(500)}\`\`\``);
  });
});

describe('sendToChannel — failure semantics (best-effort, never throws)', () => {
  test('returns false when the channel has no url configured', async () => {
    const before = received.length;
    expect(await sendToChannel(channel('webhook', {}), outageCtx)).toBe(false);
    expect(received.length).toBe(before); // nothing was sent
  });

  test('returns false on a non-2xx response', async () => {
    expect(await sendToChannel(channel('webhook', { url: `${baseUrl}/fail-500` }), outageCtx)).toBe(
      false,
    );
  });

  test('returns false when the endpoint is unreachable', async () => {
    // Port 1 is never listening locally; connection is refused immediately.
    expect(await sendToChannel(channel('webhook', { url: 'http://127.0.0.1:1/' }), outageCtx)).toBe(
      false,
    );
  });

  test('email channel returns false when config.to is missing', async () => {
    expect(await sendToChannel(channel('email', {}), outageCtx)).toBe(false);
  });

  test('email channel returns false when SMTP is not configured', async () => {
    delete process.env.OO_SMTP_HOST; // email.ts fails loudly without it
    expect(await sendToChannel(channel('email', { to: 'ops@example.com' }), outageCtx)).toBe(false);
  });
});
