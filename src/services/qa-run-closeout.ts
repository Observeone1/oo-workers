/**
 * Closing out a QA run that will never produce a verdict.
 *
 * A QA run only alerts once someone computes its aggregate — the processor
 * for a master run, `agent-dispatch` once every expected test has reported
 * for a region run. When a run dies before that (worker killed, region
 * agent gone, the processor throwing mid-flight), `qa_runs.outcome` stays
 * NULL, `claimRunAlert` is never called, and the failing browser check is
 * completely silent. The run is also invisible to the next run's
 * previous-outcome lookup, which skips NULL-outcome rows, so the eventual
 * recovery can't fire either.
 *
 * Two callers reach this: the processor's catch (a run that aborted here
 * and now) and the scheduler's `tickAbandonedQaRuns` sweep (a run nobody
 * ever came back for). Both need the same three steps in the same order,
 * hence one place for them.
 */

import { qaProjectRepo } from '../db/repositories/qa-project.repo.ts';
import { emitExecution } from './exec-events.ts';
import { maybeAlertOnQaRunTransition } from './transition-detector.ts';

/**
 * Record `runId` as FAILED, close out its still-running executions, and —
 * unless `notify` is false — fire the normal transition alert.
 *
 * `claimRunAlert` is claimed FIRST because it is the atomic gate: if a
 * straggler result lands at the same moment and wins the claim, that caller
 * owns the run and we must not touch its rows. Returns true iff this call
 * won the claim.
 *
 * Recording and notifying are separable because the two callers sit at
 * different distances from the event. The processor's catch fires as the run
 * dies, so its verdict is the current state of the monitor and always worth
 * paging. The sweep runs up to 15 minutes late, by which point newer runs
 * may have already reported — there the verdict is bookkeeping (it stops the
 * row being invisible to the previous-outcome lookup, which skips NULL
 * outcomes) and paging would be a lie about the monitor's current state.
 *
 * `errorMessage` rides into the alert body so an operator can tell a dead
 * run from a genuine test failure; `execMessage` is stamped on the stranded
 * `qa_test_executions` rows.
 */
export async function failUnfinishedQaRun(
  run: { id: number; projectId: number; regionId: number | null },
  errorMessage: string,
  execMessage: string,
  notify = true,
): Promise<boolean> {
  if (!(await qaProjectRepo.claimRunAlert(run.id, 'FAILED'))) return false;

  // Without this the detail page shows those tests "running" forever, and a
  // late-arriving agent result could push runProgress to completion long
  // after we already alerted.
  const stranded = await qaProjectRepo.markRunTestsAbandoned(run.id, execMessage);
  for (const id of stranded) {
    emitExecution('qa', run.projectId, {
      id,
      status: 'error',
      errorMessage,
      regionId: run.regionId,
    });
  }

  if (notify) await maybeAlertOnQaRunTransition(run.id, { errorMessage });
  return true;
}
