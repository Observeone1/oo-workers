/**
 * Finalizing a QA run that will never produce a verdict.
 *
 * A QA run only reaches an outcome once someone computes its aggregate — the
 * processor for a master run, `agent-dispatch` once every expected test has
 * reported for a region run. When a run dies before that (worker killed,
 * region agent gone, the processor throwing mid-flight), `qa_runs.outcome`
 * stays NULL forever and the row rots: it is skipped by the previous-run
 * lookup, and its executions keep claiming to be `running`.
 *
 * **This never alerts, by policy.** A run we failed to execute says nothing
 * about whether the monitored target is healthy — it says our own machinery
 * broke. Paging the monitor's owner for that is noise they can't act on, so
 * the run is recorded as `QA_RUN_ABANDONED` (outside `QA_RUN_VERDICTS`,
 * therefore invisible to the transition detector) and logged for whoever
 * operates the fleet. See docs/alerts.md.
 *
 * Two callers reach this: the processor's catch (a run that aborted here and
 * now) and the scheduler's `tickAbandonedQaRuns` sweep (a run nobody ever
 * came back for).
 */

import { QA_EXEC_ABANDONED, QA_RUN_ABANDONED } from '../constants.ts';
import { qaProjectRepo } from '../db/repositories/qa-project.repo.ts';
import { emitExecution } from './exec-events.ts';

/**
 * Record `run` as abandoned and close out its still-running executions.
 * Returns true iff this call won the claim.
 *
 * The claim goes first because it is the atomic gate: if a straggler result
 * lands at the same moment and wins it, that caller owns the run and we must
 * not touch its rows. Nothing here dispatches — see the note above.
 *
 * `execMessage` is stamped on the stranded `qa_test_executions` rows so the
 * detail page can say why they stopped rather than just showing them dead.
 */
export async function finalizeUnfinishedQaRun(
  run: { id: number; projectId: number; regionId: number | null },
  execMessage: string,
): Promise<boolean> {
  if (!(await qaProjectRepo.claimRunAlert(run.id, QA_RUN_ABANDONED))) return false;

  // Without this the detail page shows those tests "running" forever, and a
  // late-arriving agent result could push runProgress to completion long
  // after the run was already finalized.
  const stranded = await qaProjectRepo.markRunTestsAbandoned(run.id, execMessage);
  for (const id of stranded) {
    emitExecution('qa', run.projectId, {
      id,
      status: QA_EXEC_ABANDONED,
      errorMessage: execMessage,
      regionId: run.regionId,
    });
  }

  return true;
}
