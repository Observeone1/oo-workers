import type { Job } from 'bullmq';
import { DEFAULTS } from '../constants.ts';
import { tlsMonitorRepo } from '../db/repositories/tls-monitor.repo.ts';
import { tlsProbe } from '../services/tls-probe.ts';
import { runProbeProcessor } from './_run-probe.ts';

export const tlsMonitorProcessor = async (job: Job) => {
  const { executionId, monitor } = job.data;
  return runProbeProcessor(
    job,
    'tls',
    executionId,
    monitor.id,
    tlsMonitorRepo,
    () =>
      tlsProbe({
        host: monitor.host,
        port: monitor.port,
        timeoutMs: monitor.timeoutMs || DEFAULTS.TCP_TIMEOUT_MS,
        warnDays: monitor.warnDays ?? 30,
        servername: monitor.servername ?? null,
        verifyChain: monitor.verifyChain ?? false,
        verifyHostname: monitor.verifyHostname ?? false,
        expectCnRegex: monitor.expectCnRegex ?? null,
      }),
    (r) => ({
      latencyMs: r.latencyMs,
      daysRemaining: r.daysRemaining ?? null,
      validTo: r.validTo ?? null,
      certSummary: r.certSummary ?? null,
    }),
    (r) => ({
      latencyMs: r.latencyMs,
      daysRemaining: r.daysRemaining ?? null,
      validTo: r.validTo ?? null,
      certSummary: r.certSummary ?? null,
      errorMessage: r.errorMessage,
    }),
  );
};
