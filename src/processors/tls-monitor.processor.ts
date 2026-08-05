import type { Job } from 'bullmq';
import { DEFAULTS } from '../constants.ts';
import { tlsMonitorRepo } from '../db/repositories/tls-monitor.repo.ts';
import { tlsProbe } from '../services/tls-probe.ts';
import { runProbeProcessor } from './_run-probe.ts';

/** Dependency hook for tests — avoids process-wide mock.module poison
 * (matches agentProbeDeps/schedulerDeps elsewhere in the codebase). */
export const tlsProcessorDeps = { tlsProbe };

export const tlsMonitorProcessor = async (job: Job) => {
  const { executionId, monitor } = job.data;
  return runProbeProcessor({
    job,
    type: 'tls',
    executionId,
    monitorId: monitor.id,
    repo: tlsMonitorRepo,
    runProbe: () =>
      tlsProcessorDeps.tlsProbe({
        host: monitor.host,
        port: monitor.port,
        timeoutMs: monitor.timeoutMs || DEFAULTS.TCP_TIMEOUT_MS,
        warnDays: monitor.warnDays ?? 30,
        servername: monitor.servername ?? null,
        verifyChain: monitor.verifyChain ?? false,
        verifyHostname: monitor.verifyHostname ?? false,
        expectCnRegex: monitor.expectCnRegex ?? null,
      }),
    successFields: (r) => ({
      latencyMs: r.latencyMs,
      daysRemaining: r.daysRemaining ?? null,
      validTo: r.validTo ?? null,
      certSummary: r.certSummary ?? null,
    }),
    failFields: (r) => ({
      latencyMs: r.latencyMs,
      daysRemaining: r.daysRemaining ?? null,
      validTo: r.validTo ?? null,
      certSummary: r.certSummary ?? null,
      errorMessage: r.errorMessage,
    }),
  });
};
