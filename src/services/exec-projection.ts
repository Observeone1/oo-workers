/**
 * Lazy projection for stalled regional executions.
 *
 * Regional jobs use plain Redis lists with no BullMQ retry semantics, so a
 * crashed agent leaves its execution row at PENDING indefinitely. Rather
 * than running a background sweeper that overwrites these rows, we
 * project the "stalled" state at read time — the underlying row is left
 * as PENDING (a late agent result can still write into it via
 * writeAgentResult), but every consumer of the row sees it as FAILED
 * once it's older than 2× the monitor's interval.
 *
 * Master-path executions (region_id IS NULL) are not projected — BullMQ's
 * own retry/lock primitives handle stalls there.
 */

const STALL_MULTIPLE = 2;
const STALL_REASON = 'no agent result within 2× interval (stalled)';

export interface StalleableRow {
  status: string;
  regionId: number | null;
  errorMessage?: string | null;
}

/**
 * Return the row unchanged unless it's a PENDING regional execution
 * older than 2× the monitor's interval — in which case return a copy
 * with status=FAILED and a synthetic errorMessage. The actual DB row
 * is untouched.
 */
export function projectStalled<T extends StalleableRow>(
  row: T,
  startTime: Date | string | null | undefined,
  intervalSeconds: number,
): T {
  if (row.status !== 'PENDING' || row.regionId === null) return row;
  if (!startTime) return row;
  const startMs = typeof startTime === 'string' ? Date.parse(startTime) : startTime.getTime();
  const ageSec = (Date.now() - startMs) / 1000;
  if (ageSec <= intervalSeconds * STALL_MULTIPLE) return row;
  return {
    ...row,
    status: 'FAILED',
    errorMessage: row.errorMessage ?? STALL_REASON,
  };
}
