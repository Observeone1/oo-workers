/**
 * Shared `latest`-execution projection for monitor repos.
 *
 * Every monitor repo's `findAllWithLatest()` follows the same shape: a
 * `selectDistinctOn` subquery for the most recent execution per monitor,
 * a leftJoin onto the monitor table, and a per-row IIFE that runs
 * `projectStalled` (to flag executions whose age exceeds the interval)
 * and shapes the output. The SQL details vary by monitor type — the FK
 * column, the "latency" column name, whether `statusCode` is exposed —
 * but the IIFE is identical modulo field renames.
 *
 * `projectLatest` removes the boilerplate: pass the raw latest row, the
 * monitor's `intervalSeconds`, and a callback that builds the type-specific
 * output shape from the row + the staleness-projected `{ status, errorMessage }`.
 *
 * Returns `null` when there is no execution yet (the leftJoin produced
 * `l.id === null`), matching the previous per-repo behavior.
 */
import { projectStalled } from '../../services/exec-projection.ts';

export interface LatestExecutionInput {
  id: number | null;
  status: string;
  regionId: number | null;
  errorMessage: string | null;
  startTime: Date;
}

export function projectLatest<TLatest extends LatestExecutionInput, TOut>(
  l: TLatest | null,
  intervalSeconds: number,
  shape: (l: TLatest, projected: { status: string; errorMessage: string | null }) => TOut,
): TOut | null {
  if (!l || l.id === null) return null;
  const projected = projectStalled(
    { status: l.status, regionId: l.regionId, errorMessage: l.errorMessage },
    l.startTime,
    intervalSeconds,
  );
  return shape(l, projected);
}
