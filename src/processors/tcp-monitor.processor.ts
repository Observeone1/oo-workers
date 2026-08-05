import type { Job } from 'bullmq';
import { DEFAULTS } from '../constants.ts';
import { tcpMonitorRepo } from '../db/repositories/tcp-monitor.repo.ts';
import { tcpProbe } from '../services/tcp-probe.ts';
import { parseHexPayload } from '../services/udp-probe.ts';
import { emitExecution } from '../services/exec-events.ts';
import { maybeAlertOnTransition } from '../services/transition-detector.ts';
import { runProbeProcessor } from './_run-probe.ts';

/** Dependency hook for tests — avoids process-wide mock.module poison
 * (matches agentProbeDeps/schedulerDeps elsewhere in the codebase). */
export const tcpProcessorDeps = { tcpProbe };

export const tcpMonitorProcessor = async (job: Job) => {
  const { executionId, monitor } = job.data;

  let payload: Buffer | null;
  try {
    payload = parseHexPayload(monitor.payloadHex);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'invalid payload_hex';
    await tcpMonitorRepo.updateExecution(executionId, {
      status: 'FAILED',
      errorMessage: msg,
      endTime: new Date(),
    });
    emitExecution('tcp', monitor.id, { id: executionId, status: 'FAILED', errorMessage: msg });
    void maybeAlertOnTransition('tcp', monitor.id, executionId, 'FAILED', { errorMessage: msg });
    throw new Error(msg);
  }

  return runProbeProcessor({
    job,
    type: 'tcp',
    executionId,
    monitorId: monitor.id,
    repo: tcpMonitorRepo,
    runProbe: () =>
      tcpProcessorDeps.tcpProbe({
        host: monitor.host,
        port: monitor.port,
        timeoutMs: monitor.timeoutMs || DEFAULTS.TCP_TIMEOUT_MS,
        payload,
        expectBanner: monitor.expectBanner ?? null,
      }),
    successFields: (r) => ({ latencyMs: r.latencyMs, banner: r.banner ?? null }),
    failFields: (r) => ({
      latencyMs: r.latencyMs,
      banner: r.banner ?? null,
      errorMessage: r.errorMessage,
    }),
  });
};
