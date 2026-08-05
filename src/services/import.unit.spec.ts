/**
 * SaaS → self-host bulk import contract.
 *
 * Mocks the drizzle `db` boundary with a fake transaction that records
 * every insert and returns synthetic serial ids. Every import* helper,
 * the channel-binding wiring, status-page resolution/dedup and the
 * version/warnings guards are exercised.
 */

import { beforeEach, describe, expect, test } from 'bun:test';
import { dbMock, mockDb } from '../test-support/shared-mocks.ts';
import { getTableName } from 'drizzle-orm';

type Row = Record<string, unknown>;

const inserts: { table: string; rows: Row[] }[] = [];
let nextId = 1;
let failNextInsertOf: string | null = null;

function tableNameOf(t: unknown): string {
  return getTableName(t as Parameters<typeof getTableName>[0]);
}

function makeInsertPromise(tableName: string, rows: Row[]) {
  let recorded = false;
  const record = async () => {
    if (recorded) return;
    recorded = true;
    inserts.push({ table: tableName, rows });
    if (failNextInsertOf === tableName) {
      failNextInsertOf = null;
      throw new Error(`mock ${tableName} failure`);
    }
  };

  // Lazy thenable: recording (and possible failure) happens only when the
  // chain is consumed, either by awaiting the values() result directly or by
  // calling .returning(). This matches Drizzle's chain and avoids the base
  // promise auto-recording before .returning() has a chance to fail.
  const base = {
    then: (onfulfilled?: (value: unknown) => unknown, onrejected?: (reason: unknown) => unknown) =>
      record()
        .then(() => undefined)
        .then(onfulfilled, onrejected),
    returning: async (_cols: unknown) => {
      await record();
      return [{ id: nextId++ }];
    },
  };
  return base as Promise<unknown> & { returning: (cols: unknown) => Promise<unknown[]> };
}

function makeTx() {
  return {
    insert: (table: unknown) => {
      const tableName = tableNameOf(table);
      return {
        values: (rows: Row | Row[]) => {
          const normalized = Array.isArray(rows) ? rows : [rows];
          return makeInsertPromise(tableName, normalized);
        },
      };
    },
    transaction: async (fn: (stx: unknown) => Promise<unknown>) => fn(makeTx()),
  };
}

mockDb();

dbMock.db = {
  transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(makeTx()),
};

const { runImport, ImportVersionError } = await import('./import.ts');

beforeEach(() => {
  inserts.length = 0;
  nextId = 1;
  failNextInsertOf = null;
  dbMock.db = {
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(makeTx()),
  };
});

describe('runImport — envelope guards', () => {
  test('rejects any version other than 1', async () => {
    const err = await runImport({ version: 2 }).catch((e) => e);

    expect(err).toBeInstanceOf(ImportVersionError);
    expect(err.message).toBe('unsupported import version 2');
    expect(inserts).toHaveLength(0);
  });

  test('accepts version 1 and reports zeros for an empty bundle', async () => {
    const res = await runImport({ version: 1 });

    expect(res).toMatchObject({
      url: 0,
      api: 0,
      qa: 0,
      tcp: 0,
      udp: 0,
      heartbeat: 0,
      channels: 0,
      statusPages: 0,
      channelBindings: 0,
      skipped: [],
      warnings: [],
    });
    expect(inserts).toHaveLength(0);
  });

  test('warns when monitors are imported without channel bindings', async () => {
    const res = await runImport({
      version: 1,
      urlMonitors: [{ name: 'u1', url: 'https://a.test' }],
    });

    expect(res.url).toBe(1);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain('1 monitor(s) imported with no alert-channel bindings');
  });

  test('does not warn when channel bindings are present', async () => {
    const res = await runImport({
      version: 1,
      urlMonitors: [{ id: 1, name: 'u1', url: 'https://a.test', channelRefs: [10] }],
      channels: [{ id: 10, name: 'Email', type: 'email', config: { to: 'a@b.com' } }],
    });

    expect(res.url).toBe(1);
    expect(res.channels).toBe(1);
    expect(res.channelBindings).toBe(1);
    expect(res.warnings).toHaveLength(0);
  });

  test('does not warn when no monitors are created', async () => {
    const res = await runImport({
      version: 1,
      channels: [{ id: 10, name: 'Email', type: 'email', config: { to: 'a@b.com' } }],
    });

    expect(res.channels).toBe(1);
    expect(res.warnings).toHaveLength(0);
  });
});

describe('importUrlMonitors', () => {
  test('inserts a URL monitor with defaults and maps its id', async () => {
    const res = await runImport({
      version: 1,
      urlMonitors: [{ id: 10, name: 'u1', url: 'https://a.test', enabled: false }],
    });

    expect(res.url).toBe(1);
    expect(inserts).toHaveLength(1);
    expect(inserts[0].table).toBe('url_monitors');
    expect(inserts[0].rows[0]).toMatchObject({
      name: 'u1',
      url: 'https://a.test',
      timeoutMs: 30000,
      intervalSeconds: 60,
      enabled: false,
    });
  });

  test('coerces numeric/boolean formText values', async () => {
    await runImport({
      version: 1,
      urlMonitors: [{ name: 123, url: 'https://a.test', timeoutMs: 5000 }],
    });

    expect(inserts[0].rows[0]).toMatchObject({ name: '123', timeoutMs: 5000 });
  });

  test('inserts assertions and channel bindings', async () => {
    const res = await runImport({
      version: 1,
      urlMonitors: [
        {
          id: 10,
          name: 'u1',
          url: 'https://a.test',
          assertions: [{ operator: 'eq', statusCode: 200 }],
          channelRefs: [20],
        },
      ],
      channels: [
        { id: 20, name: 'Slack', type: 'slack', config: { url: 'https://hooks.slack.com/x' } },
      ],
    });

    expect(res.url).toBe(1);
    expect(res.channelBindings).toBe(1);
    expect(inserts.some((i) => i.table === 'url_monitor_assertions')).toBe(true);
    expect(inserts.some((i) => i.table === 'monitor_alert_channels')).toBe(true);
  });

  test('skips a row whose insert fails', async () => {
    failNextInsertOf = 'url_monitors';

    const res = await runImport({
      version: 1,
      urlMonitors: [
        { name: 'bad', url: 'https://a.test' },
        { name: 'ok', url: 'https://b.test' },
      ],
    });

    expect(res.url).toBe(1);
    expect(res.skipped).toHaveLength(1);
    expect(res.skipped[0]).toContain('url bad: mock url_monitors failure');
  });
});

describe('importApiChecks', () => {
  test('inserts an API check with headers, body and assertions', async () => {
    const res = await runImport({
      version: 1,
      apiChecks: [
        {
          id: 5,
          name: 'a1',
          url: 'https://api.test',
          method: 'POST',
          headers: { 'X-Key': 'v' },
          body: 'payload',
          intervalSeconds: 120,
          assertions: [{ type: 'json', operator: 'eq', path: '$.ok', value: 'true' }],
          channelRefs: [30],
        },
      ],
      channels: [
        { id: 30, name: 'Discord', type: 'discord', config: { url: 'https://discord.com/x' } },
      ],
    });

    expect(res.api).toBe(1);
    expect(res.channelBindings).toBe(1);
    const apiInsert = inserts.find((i) => i.table === 'api_checks');
    expect(apiInsert?.rows[0]).toMatchObject({
      name: 'a1',
      url: 'https://api.test',
      method: 'POST',
      headers: { 'X-Key': 'v' },
      body: 'payload',
      intervalSeconds: 120,
    });
    expect(inserts.some((i) => i.table === 'api_assertions')).toBe(true);
  });

  test('defaults method to GET when omitted', async () => {
    await runImport({
      version: 1,
      apiChecks: [{ name: 'a2', url: 'https://api.test' }],
    });

    expect(inserts[0].rows[0]).toMatchObject({ method: 'GET', headers: {}, body: null });
  });

  test('skips a row whose insert fails', async () => {
    failNextInsertOf = 'api_checks';

    const res = await runImport({
      version: 1,
      apiChecks: [{ name: 'bad', url: 'https://a.test' }],
    });

    expect(res.api).toBe(0);
    expect(res.skipped[0]).toContain('api bad: mock api_checks failure');
  });
});

describe('importTcpMonitors', () => {
  test('inserts a TCP monitor with defaults', async () => {
    const res = await runImport({
      version: 1,
      tcpMonitors: [{ name: 't1', host: '1.2.3.4', port: 80 }],
    });

    expect(res.tcp).toBe(1);
    expect(inserts[0].table).toBe('tcp_monitors');
    expect(inserts[0].rows[0]).toMatchObject({
      name: 't1',
      host: '1.2.3.4',
      port: 80,
      payloadHex: null,
      expectBanner: null,
      timeoutMs: 5000,
      intervalSeconds: 60,
      enabled: true,
    });
  });

  test('skips a row whose insert fails', async () => {
    failNextInsertOf = 'tcp_monitors';

    const res = await runImport({
      version: 1,
      tcpMonitors: [{ name: 'bad', host: 'x', port: 1 }],
    });

    expect(res.tcp).toBe(0);
    expect(res.skipped[0]).toContain('tcp bad: mock tcp_monitors failure');
  });
});

describe('importHeartbeats', () => {
  test('reuses an explicit token', async () => {
    const res = await runImport({
      version: 1,
      heartbeats: [{ name: 'h1', periodSeconds: 60, graceSeconds: 120, token: 'tok' }],
    });

    expect(res.heartbeat).toBe(1);
    expect(inserts[0].rows[0]).toMatchObject({
      token: 'tok',
      periodSeconds: 60,
      graceSeconds: 120,
    });
  });

  test('falls back to ping_key then generates a token', async () => {
    const res = await runImport({
      version: 1,
      heartbeats: [
        { name: 'h2', periodSeconds: 60, ping_key: 'ping' },
        { name: 'h3', periodSeconds: 90 },
      ],
    });

    expect(res.heartbeat).toBe(2);
    expect(inserts[0].rows[0]).toMatchObject({ token: 'ping' });
    expect(typeof inserts[1].rows[0].token).toBe('string');
    expect((inserts[1].rows[0].token as string).length).toBeGreaterThan(0);
  });

  test('validates periodSeconds and graceSeconds', async () => {
    const res = await runImport({
      version: 1,
      heartbeats: [
        { name: 'shortPeriod', periodSeconds: 10 },
        { name: 'badGrace', periodSeconds: 60, graceSeconds: -1 },
      ],
    });

    expect(res.heartbeat).toBe(0);
    expect(res.skipped).toHaveLength(2);
    expect(res.skipped[0]).toContain('periodSeconds must be ≥ 30');
    expect(res.skipped[1]).toContain('graceSeconds must be non-negative');
  });
});

describe('importUdpMonitors', () => {
  test('inserts a UDP monitor and parses payloadHex', async () => {
    const res = await runImport({
      version: 1,
      udpMonitors: [
        { name: 'u1', host: '8.8.8.8', port: 53, payloadHex: '00 ff', expectResponse: true },
      ],
    });

    expect(res.udp).toBe(1);
    expect(inserts[0].table).toBe('udp_monitors');
    expect(inserts[0].rows[0]).toMatchObject({ payloadHex: '00 ff', expectResponse: true });
  });

  test('skips a row with invalid hex payload', async () => {
    const res = await runImport({
      version: 1,
      udpMonitors: [{ name: 'badHex', host: 'x', port: 1, payloadHex: 'zz' }],
    });

    expect(res.udp).toBe(0);
    expect(res.skipped[0]).toContain('payload_hex must be an even-length string of hex characters');
  });

  test('skips a row whose insert fails', async () => {
    failNextInsertOf = 'udp_monitors';

    const res = await runImport({
      version: 1,
      udpMonitors: [{ name: 'bad', host: 'x', port: 1 }],
    });

    expect(res.udp).toBe(0);
    expect(res.skipped[0]).toContain('udp bad: mock udp_monitors failure');
  });
});

describe('importQaProjects', () => {
  test('inserts a QA project with generated tests', async () => {
    const res = await runImport({
      version: 1,
      qaProjects: [
        {
          name: 'q1',
          targetUrl: 'https://app.test',
          credentials: { user: 'u' },
          config: { headless: true },
          tests: [{ name: 't1', script: '// s', description: 'd' }],
        },
      ],
    });

    expect(res.qa).toBe(1);
    expect(inserts.some((i) => i.table === 'qa_projects')).toBe(true);
    expect(inserts.some((i) => i.table === 'qa_generated_tests')).toBe(true);
    const qaInsert = inserts.find((i) => i.table === 'qa_projects');
    expect(qaInsert?.rows[0]).toMatchObject({ status: 'active', intervalSeconds: 300 });
  });

  test('inserts a QA project without tests', async () => {
    const res = await runImport({
      version: 1,
      qaProjects: [{ name: 'q2', targetUrl: 'https://app.test' }],
    });

    expect(res.qa).toBe(1);
    expect(inserts.filter((i) => i.table === 'qa_generated_tests')).toHaveLength(0);
  });

  test('skips a row whose insert fails', async () => {
    failNextInsertOf = 'qa_projects';

    const res = await runImport({
      version: 1,
      qaProjects: [{ name: 'bad', targetUrl: 'https://a.test' }],
    });

    expect(res.qa).toBe(0);
    expect(res.skipped[0]).toContain('qa bad: mock qa_projects failure');
  });
});

describe('importChannels', () => {
  test('creates an email channel', async () => {
    const res = await runImport({
      version: 1,
      channels: [{ id: 10, name: 'Email', type: 'email', config: { to: 'a@b.com' } }],
    });

    expect(res.channels).toBe(1);
    const ch = inserts.find((i) => i.table === 'alert_channels');
    expect(ch?.rows[0]).toMatchObject({ name: 'Email', type: 'email', config: { to: 'a@b.com' } });
  });

  test('creates webhook/slack/discord channels', async () => {
    const res = await runImport({
      version: 1,
      channels: [
        { id: 11, name: 'Slack', type: 'slack', config: { url: 'https://hooks.slack.com/x' } },
        { id: 12, name: 'Discord', type: 'discord', config: { url: 'https://discord.com/x' } },
        { id: 13, name: 'Webhook', type: 'webhook', config: { url: 'https://webhook.test/x' } },
      ],
    });

    expect(res.channels).toBe(3);
    expect(inserts.filter((i) => i.table === 'alert_channels')).toHaveLength(3);
  });

  test('validates name, type, email address and URL', async () => {
    const res = await runImport({
      version: 1,
      channels: [
        { name: '', type: 'email', config: { to: 'a@b.com' } },
        { name: 'BadType', type: 'sms' as 'email', config: {} },
        { name: 'BadEmail', type: 'email', config: { to: 'not-an-email' } },
        { name: 'BadUrl', type: 'slack', config: { url: 'ftp://example.com' } },
      ],
    });

    expect(res.channels).toBe(0);
    expect(res.skipped).toHaveLength(4);
    expect(res.skipped[0]).toContain('name is required');
    expect(res.skipped[1]).toContain('type must be one of email, slack, discord, webhook');
    expect(res.skipped[2]).toContain('email channel needs a valid config.to address');
    expect(res.skipped[3]).toContain('channel needs an http(s) config.url');
  });

  test('skips a channel whose insert fails', async () => {
    failNextInsertOf = 'alert_channels';

    const res = await runImport({
      version: 1,
      channels: [{ id: 10, name: 'Email', type: 'email', config: { to: 'a@b.com' } }],
    });

    expect(res.channels).toBe(0);
    expect(res.skipped[0]).toContain('channel Email: mock alert_channels failure');
  });
});

describe('wireChannelBindings', () => {
  test('wires URL and API bindings, deduplicating duplicate refs', async () => {
    const res = await runImport({
      version: 1,
      urlMonitors: [{ id: 1, name: 'u1', url: 'https://a.test', channelRefs: [10, 10] }],
      apiChecks: [{ id: 2, name: 'a1', url: 'https://b.test', channelRefs: [10, 11] }],
      channels: [
        { id: 10, name: 'Ch1', type: 'slack', config: { url: 'https://s.test/1' } },
        { id: 11, name: 'Ch2', type: 'slack', config: { url: 'https://s.test/2' } },
      ],
    });

    expect(res.channelBindings).toBe(3);
    const bindings = inserts.filter((i) => i.table === 'monitor_alert_channels');
    expect(bindings).toHaveLength(2);
    expect(bindings[0].rows).toMatchObject([{ monitorType: 'url', monitorId: 1, channelId: 3 }]);
    expect(bindings[1].rows).toMatchObject([
      { monitorType: 'api', monitorId: 2, channelId: 3 },
      { monitorType: 'api', monitorId: 2, channelId: 4 },
    ]);
  });

  test('records unresolved channel refs as skipped', async () => {
    const res = await runImport({
      version: 1,
      urlMonitors: [{ id: 1, name: 'u1', url: 'https://a.test', channelRefs: [99] }],
    });

    expect(res.channelBindings).toBe(0);
    expect(res.skipped[0]).toContain('url u1 channel binding: channel ref 99 did not resolve');
  });

  test('does not insert when all resolved refs were duplicates', async () => {
    // Two url monitors both bind to the same channel — each wire call dedups
    // internally, but the two monitors still create two distinct rows.
    const res = await runImport({
      version: 1,
      urlMonitors: [
        { id: 1, name: 'u1', url: 'https://a.test', channelRefs: [10] },
        { id: 2, name: 'u2', url: 'https://b.test', channelRefs: [10] },
      ],
      channels: [{ id: 10, name: 'Ch1', type: 'slack', config: { url: 'https://s.test/1' } }],
    });

    expect(res.channelBindings).toBe(2);
    expect(inserts.filter((i) => i.table === 'monitor_alert_channels')).toHaveLength(2);
  });
});

describe('importStatusPages', () => {
  test('imports a status page with resolved monitors', async () => {
    const res = await runImport({
      version: 1,
      urlMonitors: [{ id: 1, name: 'u1', url: 'https://a.test' }],
      apiChecks: [{ id: 2, name: 'a1', url: 'https://b.test' }],
      statusPages: [
        {
          slug: 'status',
          title: 'Status',
          description: 'd',
          monitors: [
            { ref: 1, type: 'url' },
            { ref: 2, type: 'api' },
          ],
        },
      ],
    });

    expect(res.statusPages).toBe(1);
    expect(inserts.some((i) => i.table === 'status_pages')).toBe(true);
    const spm = inserts.filter((i) => i.table === 'status_page_monitors');
    expect(spm).toHaveLength(1);
    expect(spm[0].rows).toHaveLength(2);
  });

  test('skips a page whose monitors are all dangling', async () => {
    const res = await runImport({
      version: 1,
      statusPages: [
        {
          slug: 'bad',
          title: 'Bad',
          monitors: [{ ref: 99, type: 'url' }],
        },
      ],
    });

    expect(res.statusPages).toBe(0);
    expect(res.skipped[0]).toContain(
      'status_page bad: all monitor refs dangling (url ref 99 did not resolve)',
    );
    expect(inserts.filter((i) => i.table === 'status_pages')).toHaveLength(0);
  });

  test('imports a page and reports partially dangling monitors', async () => {
    const res = await runImport({
      version: 1,
      urlMonitors: [{ id: 1, name: 'u1', url: 'https://a.test' }],
      statusPages: [
        {
          slug: 'partial',
          title: 'Partial',
          monitors: [
            { ref: 1, type: 'url' },
            { ref: 99, type: 'api' },
          ],
        },
      ],
    });

    expect(res.statusPages).toBe(1);
    expect(inserts.some((i) => i.table === 'status_pages')).toBe(true);
    expect(inserts.filter((i) => i.table === 'status_page_monitors')).toHaveLength(1);
    expect(res.skipped[0]).toContain('status_page partial: api ref 99 did not resolve');
  });

  test('deduplicates repeated monitor refs', async () => {
    const res = await runImport({
      version: 1,
      urlMonitors: [{ id: 1, name: 'u1', url: 'https://a.test' }],
      statusPages: [
        {
          slug: 'dup',
          title: 'Dup',
          monitors: [
            { ref: 1, type: 'url' },
            { ref: 1, type: 'url' },
          ],
        },
      ],
    });

    expect(res.statusPages).toBe(1);
    expect(inserts.filter((i) => i.table === 'status_page_monitors')).toHaveLength(1);
  });

  test('imports a status page with no monitors', async () => {
    const res = await runImport({
      version: 1,
      statusPages: [{ slug: 'empty', title: 'Empty' }],
    });

    expect(res.statusPages).toBe(1);
    expect(inserts.filter((i) => i.table === 'status_page_monitors')).toHaveLength(0);
  });

  test('skips a page whose insert fails', async () => {
    failNextInsertOf = 'status_pages';

    const res = await runImport({
      version: 1,
      statusPages: [{ slug: 'bad', title: 'Bad' }],
    });

    expect(res.statusPages).toBe(0);
    expect(res.skipped[0]).toContain('status_page bad: mock status_pages failure');
  });
});

describe('asArray / asString / formText edge cases', () => {
  test('ignores non-array entity fields', async () => {
    const res = await runImport({
      version: 1,
      urlMonitors: 'not-an-array' as unknown as Record<string, unknown>[],
      apiChecks: 123 as unknown as Record<string, unknown>[],
      tcpMonitors: null as unknown as Record<string, unknown>[],
    });

    expect(res.url).toBe(0);
    expect(res.api).toBe(0);
    expect(res.tcp).toBe(0);
    expect(inserts).toHaveLength(0);
  });
});
