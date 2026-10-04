/**
 * How a stored run status is written on screen.
 *
 * A status is data, not copy: it is written onto the run when it ends, stored in
 * the database, and compared exactly by the submission checks and the leaderboard
 * groupers. So it cannot be a translated string, and a player's language must not
 * change what is written.
 *
 * What changes with the language is only the label printed over the top of it.
 * That mapping lives here rather than inside either leaderboard because both need
 * it and both had their own copy, which is the same class of drift this file's
 * sibling notes warn about elsewhere in the project: two definitions of one thing
 * that agree until somebody edits one of them.
 */

/** The labels, as catalogue keys rather than text. */
const STATUS_LABELS = {
  completed: 'results.cleared',
  gaveup: 'results.gaveUp',
  failed: 'results.failed',
}

/**
 * The label for a stored status.
 *
 * `t` is passed in rather than imported so this stays a plain function: it is
 * called from render paths that already hold a `t`, and it keeps the module usable
 * from a node-side test without a browser.
 *
 * An unrecognised status falls back to the neutral "run ended" rather than
 * printing the raw value at a reader. A status can only be one this list lacks if
 * a newer build wrote the run, and that run is still real data the player can see
 * the total of -- so it gets a sentence instead of a machine word.
 */
export const statusLabel = (t, status) => t(STATUS_LABELS[status] ?? 'results.runEnded')

/** The catalogue keys, for the round-level results in the run detail. */
export const RESULT_LABEL_KEYS = {
  success: 'results.passed',
  skipped: 'results.skipped',
  failure: 'results.failed',
  gaveup: 'results.gaveUp',
  // A round the clock ran out on, rather than one the player ended.
  timeout: 'results.timedOut',
}
