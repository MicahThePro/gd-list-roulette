/**
 * The version gate: the Worker refuses API traffic from any build that is not
 * the current one.
 *
 * An old version under versions/ is an archive. It is still a full site, it still
 * runs, and until now it also still talked to this Worker -- so somebody could
 * sign in from a build whose rules are years out of date, submit a run scored by
 * that build's logic, and have it land on the same global leaderboard as everyone
 * else's. The archived bundles are separately blocked in the browser, but a
 * browser guard is only a speed bump: devtools undoes it.
 *
 * So the rule is enforced here, where it cannot be undone from a console. Every
 * request to /api/* must carry a header naming a protocol this Worker understands.
 * The current build sends it; every archived build predates it and sends nothing,
 * so those requests are refused before any route runs. Nothing changes in the
 * database, so a refusal is free.
 *
 * Why a header rather than the version number itself: a version string would have
 * to be edited in two places on every release and would drift the first time
 * somebody forgot. This is deliberately not bumped for ordinary releases. It
 * names the shape of the API contract -- which routes exist, and what a run
 * payload looks like -- so it changes only when that contract changes
 * incompatibly, and only when old clients must be refused.
 *
 * The name is deliberately something an archived bundle cannot be guessed to
 * contain. It is not a secret and does not need to be: anyone can read it out of
 * the current bundle and attach it by hand. The point is not to hide the gate, it
 * is to make refusing an old build a single header the current build sends for
 * free. Deliberately patching around it is a choice someone has to make on
 * purpose, on a build that is already on record as archived.
 */

/** The header the current build sends on every API request. */
export const PROTOCOL_HEADER = 'x-dlr-protocol'

/**
 * The protocol this Worker speaks.
 *
 * Raise this only when a change breaks older clients outright: a removed or
 * renamed route, or a run payload the server can no longer read. Raising it locks
 * every previously current build out of the API until that build is redeployed,
 * which is the intent -- those runs would otherwise be scored and ranked by rules
 * that no longer exist.
 */
export const PROTOCOL_VERSION = '3'

/** The value the current build sends. */
export const PROTOCOL_VALUE = PROTOCOL_VERSION

/**
 * Whether this Worker will serve a request at all.
 *
 * A missing header is the archived-build case and is refused. A present but
 * unrecognised header is refused too, and deliberately as a different status: it
 * means the client is newer than the server, which is a deployment that went out
 * in the wrong order rather than an archived build, and the two deserve different
 * responses so that mistake is visible rather than looking like everyone suddenly
 * going offline.
 */
export const checkProtocol = (request) => {
  const value = request.headers.get(PROTOCOL_HEADER)

  if (value === null) {
    return {
      ok: false,
      status: 426,
      error:
        'Could not connect to the server. This version of the site is archived and can no longer use the online features.',
    }
  }

  if (value !== PROTOCOL_VALUE) {
    const clientVersion = Number(value)
    const serverVersion = Number(PROTOCOL_VALUE)
    const message =
      Number.isInteger(clientVersion) && clientVersion < serverVersion
        ? 'Could not connect to the server. This version of the site is archived and can no longer use the online features.'
        : `This server speaks protocol ${PROTOCOL_VERSION}, but your version speaks ${value}. Try reloading the site.`
    return {
      ok: false,
      status: 409,
      error: message,
    }
  }

  return { ok: true }
}