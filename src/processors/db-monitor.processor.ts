import type { Job } from 'bullmq';
import { DEFAULTS } from '../constants.ts';
import { dbMonitorRepo } from '../db/repositories/db-monitor.repo.ts';
import { dbProbe, type DbProtocol } from '../services/db-probe.ts';
import { runProbeProcessor } from './_run-probe.ts';

export const dbMonitorProcessor = async (job: Job) => {
  const { executionId, monitor } = job.data;
  return runProbeProcessor({
    job,
    type: 'db',
    executionId,
    monitorId: monitor.id,
    repo: dbMonitorRepo,
    runProbe: () =>
      dbProbe({
        host: monitor.host,
        port: monitor.port,
        protocol: monitor.protocol as DbProtocol,
        tls: monitor.tls,
        timeoutMs: monitor.timeoutMs || DEFAULTS.DB_TIMEOUT_MS,
      }),
    successFields: (r) => ({ latencyMs: r.latencyMs }),
    failFields: (r) => ({ latencyMs: r.latencyMs, errorMessage: r.errorMessage }),
  });
};
