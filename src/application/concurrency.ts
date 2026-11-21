/** Dynamic concurrency limits supplied to the single graph scheduler. */
export interface ConcurrencyController {
  /** Current upper bound for active command tasks. */
  readonly currentConcurrency: number;
  /** Highest command limit permitted by the selected execution mode. */
  readonly maxConcurrency: number;
  /** Revision that changes whenever the current upper bound changes. */
  readonly revision: number;

  /**
   * Wait until the supplied revision becomes stale or the controller closes.
   * @param revision Observed revision to wait beyond.
   * @param signal Optional signal used to release an abandoned wait.
   * @returns A promise resolved when the limit changes or the wait is cancelled.
   */
  waitForChange(revision: number, signal?: AbortSignal): Promise<void>;
}
