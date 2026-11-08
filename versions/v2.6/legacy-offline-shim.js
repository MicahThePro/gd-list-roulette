/* Runs inside every build under versions/, before the version's own app bundle.
 *
 * An old version is kept online purely as an archive of what the site used to
 * look like. What it must not be is a second, current copy of the site: the
 * accounts, the global leaderboards and the run submissions all live on the
 * same Worker as today's build, so an old bundle left able to reach it would let
 * somebody sign in and submit from a build whose rules are years out of date --
 * and would do it with no warning that anything was different.
 *
 * So every request to the backend fails here, before it leaves the page, and
 * fails with the ordinary "could not reach the server" wording the app already
 * shows for a network failure. From the version's point of view the server is
 * simply unreachable: the leaderboard will not load, signing in will not work,
 * and nothing can be submitted. Playing runs is untouched -- that is local, and
 * the level lists still fall back to the snapshots bundled with the build.
 *
 * Two levels of enforcement, deliberately:
 *   1. Requests to the Worker's origin, or to a site-relative /api path, are
 *      rejected. This covers the accounts and leaderboard endpoints, and the
 *      list proxy the Worker also serves.
 *   2. Everything else still goes out normally, because the level lists are read
 *      live from third parties and a run that needs them must keep working.
 *
 * Requests to the list proxy are blocked rather than allowed-and-ignored on
 * purpose: letting them fail fast keeps the page from waiting on a timeout
 * before falling back to the bundled snapshot.
 *
 * This is a client-side guard, so it is a speed bump and not a wall -- someone
 * with a devtools console can undo it. The real rule is on the server: an old
 * build has to be refused, not just discouraged. Nothing here is a substitute
 * for that; it exists so an ordinary visitor on an old version is told the
 * server is unreachable instead of quietly playing a ranked game.
 */
;(function () {
  var MESSAGE =
    'Could not connect to the server. This version can no longer reach the online features.'

  var WORKER_HOST = 'demon-roulette-list-proxy.micah-nordlund.workers.dev'

  /* Only the endpoints the site itself owns. A link out to a level's video or
   * its page on the list it came from is not the backend and stays clickable. */
  function isBackendRequest(input) {
    var url
    try {
      url = new URL(typeof input === 'string' ? input : input && input.url, location.href)
    } catch {
      return false
    }

    if (url.hostname === WORKER_HOST) return true
    // A version deployed under a subpath asks for its own /api paths relatively.
    if (url.origin === location.origin && /\/api\//.test(url.pathname)) return true

    return false
  }

  function offlineError() {
    var error = new Error(MESSAGE)
    error.name = 'ApiError'
    error.status = 0
    return error
  }

  var nativeFetch = window.fetch
  window.fetch = function (input) {
    if (isBackendRequest(input)) {
      return Promise.reject(offlineError())
    }
    return nativeFetch.apply(this, arguments)
  }

  /* The app only uses fetch, but a blocked path has to stay blocked if any
   * version reaches for XHR instead -- an error event carries the same message,
   * so the surrounding code reports it the same way. */
  var nativeOpen = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function (method, url) {
    if (isBackendRequest(url)) {
      var blocked = this
      var error = offlineError()
      setTimeout(function () {
        blocked.dispatchEvent(new CustomEvent('error'))
        try {
          blocked.onerror && blocked.onerror(error)
        } catch {
          /* A handler that throws is its own problem, not a reason to stop. */
        }
      }, 0)
      return
    }
    return nativeOpen.apply(this, arguments)
  }

  window.__legacyOnlineDisabled = true
})()