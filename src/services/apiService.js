import { LIST_SOURCES } from './listService.js'
import { protocolHeaders } from './protocol.js'

/**
 * The client half of the Worker's accounts and global leaderboard API.
 *
 * The same Worker that re-serves the Impossible Levels and Challenge Lists
 * also owns the D1 database, so there is one origin to talk to and one thing
 * to deploy. It is the same URL the list service already uses.
 *
 * The session token is held in localStorage rather than only in a cookie: the
 * site is served from GitHub Pages, so the Worker is a third-party origin and
 * modern browsers will not attach its cookie to the site's own requests. The
 * token therefore travels in an Authorization header on every call. The Worker
 * also sets a SameSite=Lax cookie, which is only a fallback for the reload case.
 */

const API_URL = 'https://demon-roulette-list-proxy.micah-nordlund.workers.dev'
const TOKEN_KEY = 'demon-roulette-session'

/* The lists a run can be submitted for.
 *
 * Derived from LIST_SOURCES rather than retyped. A run's `source` is the
 * display name the list loader gave it, and the Worker stores and groups by that
 * string, so this has to be the same set of strings -- not a parallel copy that
 * can drift. It did once: AREDL was 'All Rated Extreme Demons List' here while
 * the loader produced 'AREDL', so every AREDL run was silently treated as an
 * unranked list and could not be submitted at all.
 *
 * The Worker itself applies no allowlist; this is the site choosing not to offer
 * a button for a run it will not rank. */
export const SUBMITTABLE_SOURCES = Object.values(LIST_SOURCES)

/** The boards the global leaderboard can be sorted by. */
export const LEADERBOARD_BOARDS = [
  { id: 'farthest', label: 'Farthest %', labelKey: 'global.boardFarthest' },
  { id: 'levels', label: 'Most levels cleared', labelKey: 'global.boardLevels' },
  { id: 'fastest', label: 'Fastest run', labelKey: 'global.boardFastest' },
  { id: 'clean', label: 'Fewest skips', labelKey: 'global.boardClean' },
  { id: 'recent', label: 'Most recent', labelKey: 'global.boardRecent' },
]

export class ApiError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

const readToken = () => {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}

export const saveToken = (token) => {
  try {
    if (token) {
      localStorage.setItem(TOKEN_KEY, token)
    } else {
      localStorage.removeItem(TOKEN_KEY)
    }
  } catch {
    // Private browsing with storage disabled still works for the session in
    // memory; it just will not survive a reload.
  }
}

export const getStoredToken = readToken

const request = async (path, { method = 'GET', body, auth = false, signal } = {}) => {
  const headers = protocolHeaders()
  if (body !== undefined) {
    headers['content-type'] = 'application/json'
  }

  const token = auth ? readToken() : null
  if (token) {
    headers.authorization = `Bearer ${token}`
  }

  let response
  try {
    response = await fetch(`${API_URL}${path}`, {
      method,
      headers,
      signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw error
    }
    // A network failure, an offline tab or a Worker that is not deployed yet.
    // The message says which, because the fix is different for each.
    throw new ApiError(
      'Could not reach the server. Check your connection, or try again in a moment.',
      0,
    )
  }

  let payload
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok) {
    throw new ApiError(payload?.error ?? `The server returned ${response.status}`, response.status)
  }

  return payload
}

export const register = async ({ username, password, displayName }) => {
  const result = await request('/api/register', {
    method: 'POST',
    body: { username, password, displayName },
  })
  saveToken(result.token)
  return result.user
}

export const login = async ({ username, password }) => {
  const result = await request('/api/login', { method: 'POST', body: { username, password } })
  saveToken(result.token)

  /* A code used as a password is a moderator previewing somebody, and has to be
     marked as one. Without this the sign in looked exactly like an ordinary
     session: the same header, the same name, no banner -- so a moderator could
     upload a run as a player without ever being told they were acting as them.
     /api/redeem already did this; this is the same rule for the other door into
     the same outcome. */
  if (result.viaCode) {
    try {
      localStorage.setItem('demon-roulette-preview', result.user.username)
    } catch {
      // Without storage the banner is gone, but the session is held in memory by
      // the app, so the preview still works for this visit.
    }
  }

  return result.user
}

export const logout = async () => {
  try {
    await request('/api/logout', { method: 'POST', auth: true })
  } catch {
    // Signing out locally has to happen even if the call failed, otherwise a
    // player on a plane could not sign out of the site.
  }
  saveToken(null)
}

export const fetchMe = async (signal) => {
  if (!readToken()) {
    return null
  }
  try {
    const result = await request('/api/me', { auth: true, signal })
    return result.user ?? null
  } catch (error) {
    // A token the server no longer knows about is cleared, so the UI drops back
    // to signed out instead of showing a broken account.
    if (error instanceof ApiError && error.status === 401) {
      saveToken(null)
      return null
    }
    throw error
  }
}

/**
 * Turns an ended run into the payload the Worker accepts.
 *
 * The give-up level is not in run.rounds, so it is appended here the same way
 * the results screen appends it, and a timed-out run keeps the timeout round
 * that the run screen already recorded.
 *
 * Submitting a run and uploading its recording live in submissionService, so
 * everything to do with a run reaching the server is in one file. The run
 * payload itself is re-exported from here because the Worker tests mirror this
 * exact shape.
 */
export { buildRunPayload } from './submissionService'

export const fetchMyRuns = async (signal) => {
  const result = await request('/api/runs?limit=100', { auth: true, signal })
  return result.runs ?? []
}

export const deleteRun = async (id) => request(`/api/runs/${id}`, { method: 'DELETE', auth: true })

/**
 * The signed-in player's own runs, in the same shape the local leaderboard
 * stores them, plus the keys of the runs a moderator has trashed.
 *
 * This is what makes the leaderboard follow the account rather than the device:
 * signing in on another device replaces the board with the account's runs, and
 * the trashed keys are what stops a hidden run reappearing from this device's
 * own copy of it.
 */
export const fetchMyEntries = async (signal) => {
  const result = await request('/api/my-entries', { auth: true, signal })
  return {
    entries: result.entries ?? [],
    trashedRunKeys: result.trashedRunKeys ?? [],
  }
}

export const searchUsers = async (query = '', page = 1, limit = 12) => {
  const cleanQuery = String(query ?? '').trim()
  const safePage = Number.isFinite(Number(page)) ? Math.max(1, Number(page)) : 1
  const safeLimit = Number.isFinite(Number(limit)) ? Math.max(1, Number(limit)) : 12
  const result = await request(
    `/api/users/search?q=${encodeURIComponent(cleanQuery)}&page=${safePage}&limit=${safeLimit}`,
    { signal: undefined },
  )
  return {
    users: result.users ?? [],
    page: Number(result.page ?? safePage),
    total: Number(result.total ?? 0),
    totalPages: Number(result.totalPages ?? 1),
  }
}

export const fetchUserProfile = async (username, signal) => {
  const result = await request(
    `/api/users/${encodeURIComponent(String(username ?? '').trim())}`,
    { auth: true, signal },
  )
  return result
}

export const followUser = async (username) => {
  const result = await request(`/api/users/${encodeURIComponent(String(username ?? '').trim())}/follow`, {
    method: 'POST',
    auth: true,
  })
  return result
}

export const unfollowUser = async (username) => {
  const result = await request(`/api/users/${encodeURIComponent(String(username ?? '').trim())}/unfollow`, {
    method: 'POST',
    auth: true,
  })
  return result
}

export const fetchNotifications = async (signal) => {
  const result = await request('/api/notifications', { auth: true, signal })
  return result
}

export const fetchNotificationsCount = async (signal) => {
  const result = await request('/api/notifications/count', { auth: true, signal })
  return Number(result.count ?? 0)
}

export const markNotificationRead = async (id) => {
  const result = await request(`/api/notifications/${encodeURIComponent(String(id))}/read`, {
    method: 'POST',
    auth: true,
  })
  return result
}

/**
 * Changes the signed-in player's display name.
 *
 * The server owns the once-a-day limit and enforces it; this only reports what it
 * said. The response carries the server's own timestamp for when the change
 * counted, so the countdown on screen is measured from the same clock the rule
 * was measured from -- a device whose clock is behind would otherwise unlock the
 * field early and then be refused.
 */
export const updateDisplayName = async (displayName) => {
  const result = await request('/api/me', {
    method: 'PATCH',
    auth: true,
    body: { displayName },
  })
  return {
    user: result.user ?? null,
    cooldown: result.cooldown ?? null,
  }
}

export const fetchLeaderboard = async ({ board = 'farthest', source = 'all', parts = '', limit = 50, signal } = {}) => {
  const params = new URLSearchParams({ board, source, limit: String(limit) })
  /* Only sent when set. The Worker ignores it on anything but Pointercrate, but
   * leaving it off when empty keeps the URL free of a parameter that means
   * nothing, and keeps the cached response for the unfiltered board distinct from
   * a filtered one. */
  if (parts) {
    params.set('parts', parts)
  }
  const result = await request(`/api/leaderboard?${params.toString()}`, { signal })
  return {
    board: result.board ?? board,
    label: result.label ?? '',
    source: result.source ?? 'all',
    parts: result.parts ?? null,
    entries: result.entries ?? [],
    you: result.you ?? null,
    personal: result.personal ?? null,
  }
}
