/**
 * /api/agent/* — multi-region agent endpoints. All gated by requireAgent()
 * which validates the key + resolves the bound region (sets c.var.region
 * for downstream handlers).
 *
 * - GET  /me                                    — diagnostic
 * - GET  /jobs                                  — long-poll BRPOP; 204 on timeout
 * - POST /results                               — agent posts back probe results
 * - POST /qa/executions                         — create per-test exec rows for a QA run
 * - PUT  /qa/artifacts/:executionId/:kind       — stream-proxy trace/screenshot to RustFS
 */
import type { Hono } from 'hono';
import { requireAgent } from '../middleware/auth.ts';
import {
  popJobForRegion,
  writeAgentResult,
  type AgentResultBody,
} from '../services/agent-dispatch.ts';
import { qaProjectRepo } from '../db/repositories/qa-project.repo.ts';
import {
  isStorageConfigured,
  putObjectStream,
  qaRunArtifactKey,
} from '../services/object-storage.ts';
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

  // POST /api/agent/qa/executions — agent creates per-test exec rows for a
  // QA run it has dispatched locally. Mirrors the master-side processor's
  // per-test createExecution() (qa-project.processor.ts) but enforces that
  // the QA project is bound to the caller's region. Returns [{ testId, executionId }].
  app.post('/api/agent/qa/executions', requireAgent(), async (c) => {
    const region = c.get('region');
    let body: { projectId?: number; testIds?: number[] };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'invalid JSON body' }, 400);
    }
    const projectId = body?.projectId;
    const testIds = body?.testIds;
    if (typeof projectId !== 'number' || !Array.isArray(testIds) || testIds.length === 0) {
      return c.json({ error: 'projectId (number) and testIds (non-empty number[]) required' }, 400);
    }
    if (!testIds.every((t) => typeof t === 'number' && Number.isInteger(t))) {
      return c.json({ error: 'testIds must be integers' }, 400);
    }
    const bound = await qaProjectRepo.isProjectBoundToRegion(projectId, region.id);
    if (!bound) {
      return c.json({ error: 'project not bound to this region' }, 403);
    }
    const validTests = await qaProjectRepo.findTestsByIds(projectId, testIds);
    const validIds = new Set(validTests.map((t) => t.id));
    const unknown = testIds.filter((id) => !validIds.has(id));
    if (unknown.length > 0) {
      return c.json({ error: `unknown testIds for this project: ${unknown.join(',')}` }, 400);
    }
    const executions: { testId: number; executionId: number }[] = [];
    for (const testId of testIds) {
      const [row] = await qaProjectRepo.createExecution(testId, projectId, 'running', region.id);
      executions.push({ testId, executionId: row.id });
    }
    logger.info(
      `agent qa exec-create region=${region.slug} project=${projectId} tests=${testIds.length}`,
    );
    return c.json({ executions });
  });

  // PUT /api/agent/qa/artifacts/:executionId/:kind — stream-proxy a trace
  // or screenshot from the agent into master's RustFS. The request body is
  // raw bytes (not multipart); master pipes it via putObjectStream so
  // nothing is buffered in memory. kind is 'trace' or 'screenshot-<n>'.
  // Returns { key } so the agent can include it in the result POST.
  app.put('/api/agent/qa/artifacts/:executionId/:kind', requireAgent(), async (c) => {
    const region = c.get('region');
    const executionId = Number(c.req.param('executionId'));
    const kindParam = c.req.param('kind');
    if (!Number.isInteger(executionId) || executionId <= 0) {
      return c.json({ error: 'bad executionId' }, 400);
    }
    if (!/^(trace|screenshot-\d+)$/.test(kindParam)) {
      return c.json({ error: 'kind must be "trace" or "screenshot-<n>"' }, 400);
    }
    if (!isStorageConfigured()) {
      return c.json({ error: 'object storage is not configured on this master' }, 503);
    }
    const exec = await qaProjectRepo.findExecutionById(executionId);
    if (!exec) return c.json({ error: 'execution not found' }, 404);
    if (exec.regionId !== region.id) {
      return c.json({ error: 'execution not owned by this region' }, 403);
    }
    const projectName = (await qaProjectRepo.findProjectNameById(exec.projectId)) ?? 'untitled';
    const filename = kindParam === 'trace' ? 'trace.zip' : `${kindParam}.png`;
    const key = qaRunArtifactKey(exec.projectId, projectName, executionId, filename);
    const contentType = kindParam === 'trace' ? 'application/zip' : 'image/png';
    const contentLength = Number(c.req.header('content-length') ?? 0);
    if (!Number.isInteger(contentLength) || contentLength <= 0) {
      return c.json({ error: 'content-length header required and must be > 0' }, 400);
    }
    const reqBody = c.req.raw.body;
    if (!reqBody) return c.json({ error: 'empty body' }, 400);
    try {
      await putObjectStream(key, reqBody, contentType, contentLength);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`qa artifact upload failed region=${region.slug} exec=${executionId}: ${msg}`);
      return c.json({ error: `upload failed: ${msg}` }, 502);
    }
    logger.info(
      `agent qa artifact region=${region.slug} exec=${executionId} kind=${kindParam} bytes=${contentLength}`,
    );
    return c.json({ key });
  });
}
