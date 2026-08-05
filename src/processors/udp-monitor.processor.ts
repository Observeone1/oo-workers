import type { Job } from 'bullmq';
import { DEFAULTS } from '../constants.ts';
import { udpMonitorRepo } from '../db/repositories/udp-monitor.repo.ts';
import { parseHexPayload, udpProbe } from '../services/udp-probe.ts';
import { emitExecution } from '../services/exec-events.ts';
import { runProbeProcessor } from './_run-probe.ts';

/** Dependency hook for tests — avoids process-wide mock.module poison
 * (matches agentProbeDeps/schedulerDeps elsewhere in the codebase). */
export const udpProcessorDeps = { udpProbe };

export const udpMonitorProcessor = async (job: Job) => {
  const { executionId, monitor } = job.data;

  let payload: Buffer | null;
  try {
    payload = parseHexPayload(monitor.payloadHex);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await udpMonitorRepo.updateExecution(executionId, {
      status: 'FAILED',
      errorMessage: msg,
      endTime: new Date(),
    });
    emitExecution('udp', monitor.id, { id: executionId, status: 'FAILED', errorMessage: msg });
    throw new Error(msg);
  }

  return runProbeProcessor({
    job,
    type: 'udp',
    executionId,
    monitorId: monitor.id,
    repo: udpMonitorRepo,
    runProbe: () =>
      udpProcessorDeps.udpProbe({
        host: monitor.host,
        port: monitor.port,
        payload,
        expectResponse: !!monitor.expectResponse,
        timeoutMs: monitor.timeoutMs || DEFAULTS.UDP_TIMEOUT_MS,
      }),
    successFields: (r) => ({ latencyMs: r.latencyMs, responseBytes: r.responseBytes ?? null }),
    failFields: (r) => ({ latencyMs: r.latencyMs, errorMessage: r.errorMessage }),
  });
};
