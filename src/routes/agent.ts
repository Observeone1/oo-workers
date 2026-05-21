/**
 * /api/agent/* — multi-region agent endpoints. All three are gated by
 * requireAgent() which validates the key + resolves the bound region
 * (sets c.var.region for downstream handlers).
 *
 * - GET /me        — diagnostic: confirms the agent key is valid + bound
 * - GET /jobs      — long-poll BRPOP; 204 on wait timeout, 200 + payload otherwise
 * - POST /results  — agent posts back probe results; region-ownership enforced
 */
import type { Hono } from 'hono';
import { requireAgent } from '../middleware/auth.ts';
import {
  popJobForRegion,
  writeAgentResult,
  type AgentResultBody,
} from '../services/agent-dispatch.ts';
import { logger } from '../utils/logger.ts';
import type { RouteDeps } from './types.ts';

export function registerAgentRoutes(app: Hono, { blockingConn }: RouteDeps): void {
  // Diagnostic endpoint: confirms the agent key is valid + bound, returns
  // the region it's bound to so the preflight CLI can flag mismatches.
  app.get('/api/agent/me', requireAgent(), async (c) => {
    const region = c.get('region');
    return c.json({ region: { id: region.id, slug: region.slug, label: region.label } });
  });

  // Long-poll endpoint: agent calls this repeatedly, master holds the
  // connection until a job is available or `wait` seconds pass. Returns
  // 204 on timeout (agent reconnects). On 200, the body is the job
  // payload (type, executionId, regionId, type-specific monitor fields).
  app.get('/api/agent/jobs', requireAgent(), async (c) => {
    const region = c.get('region');
    const waitRaw = c.req.query('wait');
    const wait = Math.min(60, Math.max(1, waitRaw ? Number.parseInt(waitRaw, 10) || 30 : 30));
    const payload = await popJobForRegion(blockingConn, region.slug, wait);
    if (!payload) return c.body(null, 204);
    return c.json(payload);
  });

  // POST /api/agent/results — agent posts back the probe result. The
  // executions row must reference the agent's region or the write is
  // rejected (403). Idempotent on executionId: a second POST for the
  // same exec is silently dropped (rows.updated=false because the
  // status no longer matches PENDING semantics; here we only filter on
  // region_id, but a re-update simply rewrites the same values).
  app.post('/api/agent/results', requireAgent(), async (c) => {
    const region = c.get('region');
    let body: AgentResultBody;
    try {
      body = (await c.req.json()) as AgentResultBody;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    if (!body || typeof body !== 'object') {
      return c.json({ error: 'body must be a JSON object' }, 400);
    }
    if (!body.type || typeof body.executionId !== 'number' || !body.status) {
      return c.json({ error: 'type, executionId, status are required' }, 400);
    }
    const outcome = await writeAgentResult(region.id, body);
    if (!outcome.updated) {
      return c.json(
        { error: 'execution not found or not owned by this region', reason: outcome.reason },
        403,
      );
    }
    logger.info(
      `agent result region=${region.slug} type=${body.type} exec=${body.executionId} status=${body.status}`,
    );
    return c.json({ ok: true });
  });
}
