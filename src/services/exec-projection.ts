/**
 * Lazy projection for stalled executions.
 *
 * Regional jobs use plain Redis lists with no BullMQ retry semantics, so a
 * crashed agent leaves its execution row at PENDING indefinitely. The
 * master path uses BullMQ — better protected, but not bullet-proof: hard
 * worker restarts, container OOM kills, and dropped jobs can all leave
 * master-path rows stuck at PENDING too. Rather than run a background
 * sweeper that overwrites these rows, we project "stalled" at read time
 * — the underlying DB row is left as PENDING (a late result can still
 * write into it via writeAgentResult / worker update), but every
 * consumer sees status=FAILED once the row is older than 2× the monitor's
 * interval. Applies to BOTH regional and master-path executions.
 */

const STALL_MULTIPLE = 2;
const STALL_REASON = 'no result within 2× interval (stalled)';

export interface StalleableRow {
  status: string;
  errorMessage?: string | null;
}

/**
 * Return the row unchanged unless it's a PENDING execution older than 2×
 * the monitor's interval — in which case return a copy with status=FAILED
 * and a synthetic errorMessage. The actual DB row is untouched.
 */
export function projectStalled<T extends StalleableRow>(
  row: T,
  startTime: Date | string | null | undefined,
  intervalSeconds: number,
): T {
  if (row.status !== 'PENDING') return row;
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
