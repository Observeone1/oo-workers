/**
 * `/api/import` — SaaS → self-host bulk import.
 *
 * Thin adapter layer between the imported bundle (JSON payload from the
 * CLI's `obs export`, or hand-crafted) and the DB. Each `importX()`
 * function handles one entity type: validate row, insert via the
 * transaction handle, push to `result.skipped` on per-row failure.
 *
 * The whole import runs inside a single `db.transaction(...)`. A crash
 * mid-import (process kill, OOM, lost DB connection, unexpected throw
 * from an adapter) rolls back cleanly — operators can re-run the
 * import against the same target without manually unwinding partial
 * state. Per-row validation errors are caught and pushed to `skipped`
 * so one bad row never derails the rest.
 *
 * Repos are intentionally bypassed here: the existing repo methods
 * close over the module-level `db`, so calling them inside a `tx`
 * callback would leak their writes outside the transaction. Each
 * adapter inlines the insert against `tx` directly. The validation
 * mirrors what the per-type POST endpoints enforce; both shouldering
 * the same invariants is acceptable for the one extra surface in
 * exchange for atomicity.
 */
import { randomBytes } from 'node:crypto';
import { db } from '../config/db.ts';
import { DEFAULTS } from '../constants.ts';
import {
  alertChannels,
  apiAssertions,
  apiChecks,
  heartbeatMonitors,
  monitorAlertChannels,
  qaGeneratedTests,
  qaProjects,
  statusPageMonitors,
  statusPages,
  tcpMonitors,
  udpMonitors,
  urlMonitorAssertions,
  urlMonitors,
} from '../db/schema.ts';
import { parseHexPayload } from './udp-probe.ts';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export class ImportVersionError extends Error {}

const VALID_CHANNEL_TYPES = ['email', 'slack', 'discord', 'webhook'] as const;
type ChannelType = (typeof VALID_CHANNEL_TYPES)[number];

export interface ImportResult {
  url: number;
  api: number;
  qa: number;
  tcp: number;
  udp: number;
  heartbeat: number;
  channels: number;
  statusPages: number;
  channelBindings: number;
  skipped: string[];
  warnings: string[];
}

interface IdMaps {
  url: Map<number, number>;
  api: Map<number, number>;
  channel: Map<number, number>;
}

interface ChannelBinding {
  realId: number;
  refs: number[];
  name: string;
}

interface ChannelBindings {
  url: ChannelBinding[];
  api: ChannelBinding[];
}

export async function runImport(body: {
  version?: number;
  [k: string]: unknown;
}): Promise<ImportResult> {
  if (body.version !== 1) {
    throw new ImportVersionError(`unsupported import version ${body.version}`);
  }

  const result: ImportResult = {
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
  };

  await db.transaction(async (tx) => {
    const idMaps: IdMaps = {
      url: new Map(),
      api: new Map(),
      channel: new Map(),
    };
    const bindings: ChannelBindings = { url: [], api: [] };

    await importUrlMonitors(tx, asArray(body.urlMonitors), result, idMaps, bindings);
    await importApiChecks(tx, asArray(body.apiChecks), result, idMaps, bindings);
    await importTcpMonitors(tx, asArray(body.tcpMonitors), result);
    await importHeartbeats(tx, asArray(body.heartbeats), result);
    await importUdpMonitors(tx, asArray(body.udpMonitors), result);
    await importQaProjects(tx, asArray(body.qaProjects), result);
    await importChannels(tx, asArray(body.channels), result, idMaps);

    await wireChannelBindings(tx, bindings, idMaps, result);
    await importStatusPages(tx, asArray(body.statusPages), result, idMaps);
  });

  // Monitor→alert-channel routing advisory: only when bindings were
  // NOT supplied. If at least one binding was wired through from the
  // bundle, the export is "new-style" (CLI v1.25.0+) — no warning.
  // Pre-1.25.0 imports still get the loud "go bind your channels"
  // nudge so a half-migrated stack doesn't fly blind.
  const monitorsCreated = result.url + result.api + result.qa + result.tcp + result.udp;
  if (monitorsCreated > 0 && result.channelBindings === 0) {
    result.warnings.push(
      `${monitorsCreated} monitor(s) imported with no alert-channel bindings — ` +
        `they will not alert anyone until you bind a channel to each ` +
        `(Monitors → a monitor → Alert channels).`,
    );
  }

  return result;
}

function asArray(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : [];
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

// Run one import row inside its own SAVEPOINT. Without this, a single failed
// insert aborts the whole OUTER transaction server-side (Postgres 25P02
// "current transaction is aborted"), so every later row's own try/catch runs
// against a poisoned tx and the final COMMIT rolls the entire import back —
// while `result` still reports non-zero counts. A nested tx.transaction()
// emits a real SAVEPOINT, so a per-row failure rolls back only that row and
// the outer import continues, making the per-row `skipped` handling actually
// work as intended.
async function importRow(tx: Tx, fn: (stx: Tx) => Promise<void>): Promise<void> {
  await tx.transaction(async (stx) => {
    await fn(stx);
  });
}

async function importUrlMonitors(
  tx: Tx,
  rows: Array<Record<string, unknown>>,
  result: ImportResult,
  idMaps: IdMaps,
  bindings: ChannelBindings,
): Promise<void> {
  for (const u of rows) {
    try {
      await importRow(tx, async (stx) => {
        const [m] = await stx
          .insert(urlMonitors)
          .values({
            name: String(u.name),
            url: String(u.url),
            timeoutMs: Number(u.timeoutMs ?? DEFAULTS.URL_TIMEOUT_MS),
            intervalSeconds: Number(u.intervalSeconds ?? 60),
            enabled: (u.enabled as boolean | undefined) ?? true,
          })
          .returning({ id: urlMonitors.id });
        const assertions = (u.assertions as Array<Record<string, unknown>> | undefined) ?? [];
        if (assertions.length > 0) {
          await stx.insert(urlMonitorAssertions).values(
            assertions.map((a) => ({
              urlMonitorId: m.id,
              operator: String(a.operator),
              statusCode: Number(a.statusCode),
            })),
          );
        }
        if (typeof u.id === 'number') idMaps.url.set(u.id, m.id);
        const refs = u.channelRefs as number[] | undefined;
        if (Array.isArray(refs) && refs.length > 0) {
          bindings.url.push({ realId: m.id, refs, name: String(u.name) });
        }
        result.url++;
      });
    } catch (err) {
      result.skipped.push(`url ${u.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function importApiChecks(
  tx: Tx,
  rows: Array<Record<string, unknown>>,
  result: ImportResult,
  idMaps: IdMaps,
  bindings: ChannelBindings,
): Promise<void> {
  for (const a of rows) {
    try {
      await importRow(tx, async (stx) => {
        const [m] = await stx
          .insert(apiChecks)
          .values({
            name: String(a.name),
            url: String(a.url),
            method: String(a.method ?? 'GET'),
            headers: (a.headers as Record<string, string> | undefined) ?? {},
            body: asString(a.body),
            timeoutMs: Number(a.timeoutMs ?? DEFAULTS.API_TIMEOUT_IMPORT_DEFAULT_MS),
            intervalSeconds: Number(a.intervalSeconds ?? 60),
            enabled: (a.enabled as boolean | undefined) ?? true,
          })
          .returning({ id: apiChecks.id });
        const assertions = (a.assertions as Array<Record<string, unknown>> | undefined) ?? [];
        if (assertions.length > 0) {
          await stx.insert(apiAssertions).values(
            assertions.map((ass) => ({
              apiCheckId: m.id,
              type: String(ass.type),
              operator: String(ass.operator),
              path: asString(ass.path),
              value: asString(ass.value),
            })),
          );
        }
        if (typeof a.id === 'number') idMaps.api.set(a.id, m.id);
        const refs = a.channelRefs as number[] | undefined;
        if (Array.isArray(refs) && refs.length > 0) {
          bindings.api.push({ realId: m.id, refs, name: String(a.name) });
        }
        result.api++;
      });
    } catch (err) {
      result.skipped.push(`api ${a.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function importTcpMonitors(
  tx: Tx,
  rows: Array<Record<string, unknown>>,
  result: ImportResult,
): Promise<void> {
  for (const t of rows) {
    try {
      await importRow(tx, async (stx) => {
        await stx.insert(tcpMonitors).values({
          name: String(t.name),
          host: String(t.host),
          port: Number(t.port),
          payloadHex: asString(t.payloadHex),
          expectBanner: asString(t.expectBanner),
          timeoutMs: Number(t.timeoutMs ?? DEFAULTS.TCP_TIMEOUT_MS),
          intervalSeconds: Number(t.intervalSeconds ?? 60),
          enabled: (t.enabled as boolean | undefined) ?? true,
        });
        result.tcp++;
      });
    } catch (err) {
      result.skipped.push(`tcp ${t.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function importHeartbeats(
  tx: Tx,
  rows: Array<Record<string, unknown>>,
  result: ImportResult,
): Promise<void> {
  for (const h of rows) {
    try {
      await importRow(tx, async (stx) => {
        const period = Number(h.periodSeconds);
        if (!Number.isFinite(period) || period < 30) {
          throw new Error('periodSeconds must be ≥ 30');
        }
        const grace = h.graceSeconds == null ? 60 : Number(h.graceSeconds);
        if (!Number.isFinite(grace) || grace < 0) {
          throw new Error('graceSeconds must be non-negative');
        }
        // Reuse the SaaS ping_key as the self-host token so existing
        // services keep pinging the same URL. Adapter has already
        // mapped CLI ping_key → token; tolerate either field name
        // here in case a hand-written bundle uses ping_key directly.
        const token =
          typeof h.token === 'string'
            ? h.token
            : typeof h.ping_key === 'string'
              ? h.ping_key
              : randomBytes(32).toString('base64url');
        await stx.insert(heartbeatMonitors).values({
          name: String(h.name),
          description: asString(h.description),
          periodSeconds: period,
          graceSeconds: grace,
          enabled: (h.enabled as boolean | undefined) ?? true,
          token,
        });
        result.heartbeat++;
      });
    } catch (err) {
      result.skipped.push(
        `heartbeat ${h.name}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

async function importUdpMonitors(
  tx: Tx,
  rows: Array<Record<string, unknown>>,
  result: ImportResult,
): Promise<void> {
  for (const u of rows) {
    try {
      await importRow(tx, async (stx) => {
        if (u.payloadHex) parseHexPayload(String(u.payloadHex));
        await stx.insert(udpMonitors).values({
          name: String(u.name),
          host: String(u.host),
          port: Number(u.port),
          payloadHex: asString(u.payloadHex),
          expectResponse: (u.expectResponse as boolean | undefined) ?? false,
          timeoutMs: Number(u.timeoutMs ?? DEFAULTS.UDP_TIMEOUT_MS),
          intervalSeconds: Number(u.intervalSeconds ?? 60),
          enabled: (u.enabled as boolean | undefined) ?? true,
        });
        result.udp++;
      });
    } catch (err) {
      result.skipped.push(`udp ${u.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function importQaProjects(
  tx: Tx,
  rows: Array<Record<string, unknown>>,
  result: ImportResult,
): Promise<void> {
  for (const q of rows) {
    try {
      await importRow(tx, async (stx) => {
        const [m] = await stx
          .insert(qaProjects)
          .values({
            name: String(q.name),
            targetUrl: String(q.targetUrl),
            credentials: (q.credentials as Record<string, string> | null | undefined) ?? null,
            config: (q.config as Record<string, string> | undefined) ?? {},
            intervalSeconds: Number(q.intervalSeconds ?? DEFAULTS.QA_INTERVAL_SECONDS),
            enabled: (q.enabled as boolean | undefined) ?? true,
            status: 'active',
          })
          .returning({ id: qaProjects.id });
        const tests = (q.tests as Array<Record<string, unknown>> | undefined) ?? [];
        if (tests.length > 0) {
          await stx.insert(qaGeneratedTests).values(
            tests.map((t) => ({
              projectId: m.id,
              testName: String(t.name),
              testType: 'browser',
              script: String(t.script),
              description: asString(t.description),
            })),
          );
        }
        result.qa++;
      });
    } catch (err) {
      result.skipped.push(`qa ${q.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function importChannels(
  tx: Tx,
  rows: Array<Record<string, unknown>>,
  result: ImportResult,
  idMaps: IdMaps,
): Promise<void> {
  for (const ch of rows) {
    try {
      await importRow(tx, async (stx) => {
        const name = typeof ch.name === 'string' ? ch.name.trim() : '';
        const type = ch.type as ChannelType;
        const cfg = (ch.config ?? {}) as Record<string, unknown>;
        if (!name) throw new Error('name is required');
        if (!VALID_CHANNEL_TYPES.includes(type)) {
          throw new Error(`type must be one of ${VALID_CHANNEL_TYPES.join(', ')}`);
        }
        let createdId: number | undefined;
        if (type === 'email') {
          const to = typeof cfg.to === 'string' ? cfg.to.trim() : '';
          if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) {
            throw new Error('email channel needs a valid config.to address');
          }
          const [created] = await stx
            .insert(alertChannels)
            .values({ name, type, config: { to } })
            .returning({ id: alertChannels.id });
          createdId = created.id;
        } else {
          const url = typeof cfg.url === 'string' ? cfg.url.trim() : '';
          if (!/^https?:\/\//i.test(url)) {
            throw new Error('channel needs an http(s) config.url');
          }
          const [created] = await stx
            .insert(alertChannels)
            .values({ name, type, config: { url } })
            .returning({ id: alertChannels.id });
          createdId = created.id;
        }
        if (createdId !== undefined && typeof ch.id === 'number') {
          idMaps.channel.set(ch.id, createdId);
        }
        result.channels++;
      });
    } catch (err) {
      result.skipped.push(
        `channel ${ch?.name ?? '?'}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

async function wireChannelBindings(
  tx: Tx,
  bindings: ChannelBindings,
  idMap: IdMaps,
  result: ImportResult,
): Promise<void> {
  const resolveRefs = (refs: number[], context: string): number[] => {
    const out: number[] = [];
    for (const r of refs) {
      const real = idMap.channel.get(r);
      if (real !== undefined) {
        out.push(real);
      } else {
        result.skipped.push(
          `${context}: channel ref ${r} did not resolve (channel may have been skipped or absent from bundle)`,
        );
      }
    }
    return out;
  };
  const wire = async (
    type: 'url' | 'api',
    monitorId: number,
    channelIds: number[],
  ): Promise<void> => {
    // Dedup: monitor_alert_channels has a composite PK on
    // (monitorType, monitorId, channelId). A malformed bundle with a
    // duplicate ref (e.g. channelRefs: [10, 10]) would hit the PK and
    // throw out of the transaction callback — rolling back the WHOLE
    // import. Accept redundant input rather than abort.
    const unique = Array.from(new Set(channelIds));
    if (unique.length === 0) return;
    await tx.insert(monitorAlertChannels).values(
      unique.map((channelId) => ({
        monitorType: type,
        monitorId,
        channelId,
      })),
    );
    result.channelBindings += unique.length;
  };
  for (const b of bindings.url) {
    await wire('url', b.realId, resolveRefs(b.refs, `url ${b.name} channel binding`));
  }
  for (const b of bindings.api) {
    await wire('api', b.realId, resolveRefs(b.refs, `api ${b.name} channel binding`));
  }
}

async function importStatusPages(
  tx: Tx,
  rows: Array<Record<string, unknown>>,
  result: ImportResult,
  idMaps: IdMaps,
): Promise<void> {
  for (const sp of rows) {
    try {
      const monitors =
        (sp.monitors as Array<{ ref: number; type: 'url' | 'api' }> | undefined) ?? [];
      const resolved: Array<{ monitorType: 'url' | 'api'; monitorId: number }> = [];
      const dangling: string[] = [];
      for (const m of monitors) {
        const map = m.type === 'url' ? idMaps.url : idMaps.api;
        const real = map.get(m.ref);
        if (real !== undefined) {
          resolved.push({ monitorType: m.type, monitorId: real });
        } else {
          dangling.push(`${m.type} ref ${m.ref} did not resolve`);
        }
      }
      // Pre-flight: don't create a hollow shell if every binding dangled.
      if (monitors.length > 0 && resolved.length === 0) {
        result.skipped.push(
          `status_page ${sp.slug}: all monitor refs dangling (${dangling.join(', ')})`,
        );
        continue;
      }
      await importRow(tx, async (stx) => {
        const [page] = await stx
          .insert(statusPages)
          .values({
            slug: String(sp.slug),
            title: String(sp.title),
            description: asString(sp.description),
          })
          .returning({ id: statusPages.id });
        if (resolved.length > 0) {
          // Dedup: status_page_monitors has a composite PK on
          // (statusPageId, monitorType, monitorId). Same risk as wire()
          // above — a bundle with two refs to the same (type,id) would
          // abort the whole import on PK violation.
          const seen = new Set<string>();
          const uniqueResolved = resolved.filter((r) => {
            const k = `${r.monitorType}:${r.monitorId}`;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          });
          await stx.insert(statusPageMonitors).values(
            uniqueResolved.map((r) => ({
              statusPageId: page.id,
              monitorType: r.monitorType,
              monitorId: r.monitorId,
            })),
          );
        }
        result.statusPages++;
      });
      for (const note of dangling) {
        result.skipped.push(`status_page ${sp.slug}: ${note}`);
      }
    } catch (err) {
      result.skipped.push(
        `status_page ${sp.slug}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
