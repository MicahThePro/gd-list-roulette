/**
 * The protocol header the Worker gates on.
 *
 * The Worker refuses any /api request that does not carry this, which is how a
 * build under versions/ is kept out of the current server. See worker/protocol.js
 * for why the rule lives there rather than in the browser.
 *
 * The value names the shape of the API contract -- which routes exist and what a
 * run payload looks like -- not the release. It is deliberately NOT bumped for
 * ordinary releases; it changes only when a change breaks older clients outright,
 * and only when those clients must be refused.
 *
 * Defined once here rather than repeated in each of the three services that talk
 * to the Worker, because a copy per service is a copy that drifts: one service
 * sending a stale value would be refused by the Worker's own gate, and the
 * failure would look like that one screen being broken rather than a version
 * mismatch. That has happened before in this codebase, with the list source
 * names, which is why it is a single import now.
 */
export const PROTOCOL_HEADER = 'x-dlr-protocol'
export const PROTOCOL_VALUE = '3'

/** The headers every API request carries, for spreading into a fetch call. */
export const protocolHeaders = () => ({ [PROTOCOL_HEADER]: PROTOCOL_VALUE })