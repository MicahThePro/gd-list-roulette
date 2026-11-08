import { useCallback, useEffect, useRef, useState } from 'react'
import { LEADERBOARD_BOARDS, fetchLeaderboard } from '../services/apiService'
import { LIST_SOURCES, LIST_SOURCE_LABELS } from '../services/listService'
import { censorText } from '../utils/censor'
import { formatDurationMs } from '../utils/roulette'
import PointercratePartsBadge from './PointercratePartsBadge'
import { POINTERCRATE_PARTS } from '../services/pointercrateParts.js'

/* The list filter, built from the same names the list loader gives a run.
 * These were retyped here and drifted once: this filter expected 'All Rated
 * Extreme Demons List' while runs were stored as 'AREDL', so selecting AREDL
 * matched nothing and its runs were only ever visible under "All lists".
 *
 * `id` is the raw stored name and `label` is the censored one. Keeping them apart
 * is the whole point: `id` is what is sent to the Worker and matched with an exact
 * comparison, so it has to be the string runs are actually stored under. Censoring
 * the id would filter on a value no run has, and the option would select nothing. */
const SOURCES = [
  { id: 'all', label: 'All lists' },
  ...Object.values(LIST_SOURCES).map((name) => ({
    id: name,
    label: censorText(LIST_SOURCE_LABELS[name] ?? name),
  })),
]

const STATUS_LABELS = {
  completed: 'Cleared',
  gaveup: 'Gave up',
  failed: 'Failed',
}

const formatWhen = (timestamp) => {
  if (!Number.isFinite(timestamp)) return 'Unknown date'
  const date = new Date(timestamp)
  const sameYear = date.getFullYear() === new Date().getFullYear()
  return date.toLocaleDateString(undefined, {
    year: sameYear ? undefined : 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

/**
 * The global leaderboard, read from the Worker's D1 database.
 *
 * Separate from the local Leaderboard component on purpose: that one is a
 * personal history that lives in this browser and can be edited, while this one
 * is every run anybody has submitted. Keeping them apart means a clear-all on
 * one can never be mistaken for clearing the other.
 */
export default function GlobalLeaderboard({ user, onOpenProfile }) {
  const [board, setBoard] = useState('farthest')
  const [source, setSource] = useState('all')
  /* Which Pointercrate list to narrow to. Empty means no narrowing.
   *
   * Its own state rather than folded into `source`, because it is only meaningful
   * on one of the five lists: folded in, the id would have to mean both "which
   * list" and "which part of it", and switching to AREDL would leave a stale part
   * filter behind that silently emptied the board. */
  const [parts, setParts] = useState('')
  const [data, setData] = useState(null)
  // The board and list currently on screen, and the trio the data on hand is
  // for. Loading is derived from those rather than a flag, so switching board
  // or list shows the loading state without an effect having to set it.
  const [loaded, setLoaded] = useState({ board: null, source: null, parts: null })
  const [error, setError] = useState('')

  const isLoading = loaded.board !== board || loaded.source !== source || loaded.parts !== parts

  /* Whether the pointer or the keyboard is currently inside the control bar.
   *
   * A native <select> popup lives outside the page's DOM, so a re-render that
   * touches the options closes it -- the browser does not repaint a popup over
   * changed markup, it drops it. The board re-reads itself every 30 seconds and
   * again whenever the effect below fires, so a player who opened the list
   * dropdown had it shut under their cursor roughly once a poll landed, which is
   * what made the dropdown look broken rather than merely unlucky.

   * Polling is therefore held while the bar has focus. It resumes the moment the
   * player leaves, and the one thing it would have told them -- that somebody
   * else submitted a run -- is not worth a control that fights the hand. */
  const [isBarBusy, setIsBarBusy] = useState(false)
  const barRef = useRef(null)

  /* `load` is called from a 30s interval that does not re-run on every render, so
   * it cannot read `isBarBusy` from a closure without re-subscribing that timer on
   * every pointer movement. The ref is how the interval learns the current value. */
  const isBarBusyRef = useRef(false)

  /* Synced in an effect rather than during render, because a ref written during
   * render is a value the current render never sees -- and this one is read by the
   * polling interval. Declared above the load effects so it has already landed
   * by the time they ask. */
  useEffect(() => {
    isBarBusyRef.current = isBarBusy
  }, [isBarBusy])

  useEffect(() => {
    const bar = barRef.current
    if (!bar) return undefined

    const enter = () => setIsBarBusy(true)
    /* focusout only fires when focus moves to something focusable, so a click
       into the bar's dead space would otherwise leave it "busy" forever. */
    const leave = (event) => {
      if (!bar.contains(event.relatedTarget)) setIsBarBusy(false)
    }
    /* Selecting an option in a native dropdown finishes with a pointerup on the
       popup, which is outside the page and outside the bar -- so the release has
       to be watched on the window, or the bar stays busy and never polls again. */
    const release = () => setIsBarBusy(false)

    bar.addEventListener('focusin', enter)
    bar.addEventListener('pointerdown', enter)
    bar.addEventListener('focusout', leave)
    window.addEventListener('pointerup', release)

    return () => {
      bar.removeEventListener('focusin', enter)
      bar.removeEventListener('pointerdown', enter)
      bar.removeEventListener('focusout', leave)
      window.removeEventListener('pointerup', release)
    }
  }, [])

  /* Choosing a different list clears the part filter. Left in place it would
   * filter AREDL rows by a Pointercrate column, which no row has, and the board
   * would come back empty with nothing on screen to say why. */
  const handleSourceChange = (value) => {
    setSource(value)
    setParts('')
  }

  // Every setter here is called from a promise callback or an interval tick,
  // never from the effect body, so the effects below are a subscription to the
  // server rather than a render-time update. The promise is returned so a caller
  // can catch it -- failures are handled inside as well, so it only ever
  // rejects if the fetch itself is malformed.
  //
  // `requestSeq` is the read that is allowed to paint. A slower response for a
  // filter the player has already left must not overwrite the board they are
  // looking at now. Aborting is not enough on its own: the catch-up refresh and
  // the 30s poll each used to start a request nobody aborted, and a response
  // that resolved in the same turn as abort would still call the setters.
  const requestSeq = useRef(0)
  const inflight = useRef(null)
  // The query the rows on screen belong to. State drives the loading flag; the
  // ref is what a failed read checks, because that callback cannot see the
  // state from the render that started it.
  const loadedRef = useRef(loaded)
  const load = useCallback(
    (signal) => {
      const seq = ++requestSeq.current
      inflight.current?.abort()
      inflight.current = null

      /* A refresh asked for while a control is being used is dropped rather than
       * queued. Holding it would only close the popup on the very next tick,
       * which is the bug this guard exists to stop. The sequence bump above has
       * already retired whatever was in flight, so that dropped refresh cannot
       * land later under a different filter. */
      if (isBarBusyRef.current || signal?.aborted) return Promise.resolve()

      const controller = new AbortController()
      inflight.current = controller
      const abortFromCaller = () => controller.abort()
      signal?.addEventListener('abort', abortFromCaller)

      const query = { board, source, parts }
      return fetchLeaderboard({ board, source, parts, signal: controller.signal })
        .then((result) => {
          if (seq !== requestSeq.current || controller.signal.aborted) return
          loadedRef.current = query
          setData(result)
          setLoaded(query)
          setError('')
        })
        .catch((caught) => {
          if (caught?.name === 'AbortError' || seq !== requestSeq.current) return
          const previous = loadedRef.current
          const sameQuery = previous.board === query.board
            && previous.source === query.source
            && previous.parts === query.parts
          setError(caught?.message ?? 'Could not load the leaderboard.')
          // A refresh of the board already on screen keeps its rows and shows
          // the error above them. A failed filter change must not: those rows
          // belong to the previous filter, and leaving `loaded` stale would
          // spin on "Loading" forever.
          if (sameQuery) return
          loadedRef.current = query
          setLoaded(query)
          setData({ entries: [], you: null, personal: null })
        })
        .finally(() => {
          signal?.removeEventListener('abort', abortFromCaller)
          if (inflight.current === controller) inflight.current = null
        })
    },
    [board, source, parts],
  )

  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal)
    return () => controller.abort()
  }, [load])

  /* Catches up the refreshes that were skipped while a dropdown was open.
   *
   * Without this the player would be left looking at whatever the board said
   * before they started clicking, with no signal that it was stale. The first
   * run is skipped: the effect above has already loaded for these inputs, and a
   * duplicate request on every mount is a cost with no reader.
   *
   * This follows the bar becoming idle, not `load`. Depending on `load` started
   * a second request on every filter change and threw the controller away, so
   * the next change could not abort it and a slow response briefly painted the
   * filter the player had already left. */
  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  }, [load])

  const hasLoadedOnce = useRef(false)
  useEffect(() => {
    if (isBarBusy) return undefined
    if (!hasLoadedOnce.current) {
      hasLoadedOnce.current = true
      return undefined
    }
    const controller = new AbortController()
    loadRef.current(controller.signal)
    return () => controller.abort()
  }, [isBarBusy])

  // The board is re-read on a timer rather than cached, because a player who
  // just submitted a run wants to see themselves on it. Half a minute is long
  // enough not to hammer the Worker and short enough to feel live.
  useEffect(() => {
    const intervalId = window.setInterval(() => {
      const controller = new AbortController()
      load(controller.signal)
    }, 30000)
    return () => window.clearInterval(intervalId)
  }, [load])

  return (
    <div className="global-board">
      <div className="global-board-bar" ref={barRef}>
        <div className="global-board-boards" role="tablist" aria-label="Leaderboard board">
          {LEADERBOARD_BOARDS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={board === entry.id}
              className={board === entry.id ? 'secondary-button small-button board-chip board-chip-active' : 'secondary-button small-button board-chip'}
              onClick={() => setBoard(entry.id)}
            >
              {entry.label}
            </button>
          ))}
        </div>

        <label className="global-board-source">
          <span className="visually-hidden">Filter by list</span>
          <select value={source} onChange={(event) => handleSourceChange(event.target.value)}>
            {SOURCES.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>

        {/* The three Pointercrate parts, as chips rather than a second dropdown.

            This was a <select>, and that was the whole problem: a native popup is
            not part of the document, so any re-render that changes the <option>
            list drops it, and the board re-reads itself on a timer. A player
            clicking "Pointercrate Demon List" -> "Legacy list only" watched the
            menu close itself, and the second click re-opened it, over and over.
            Chips are ordinary buttons, so they cannot be closed by anything but
            the player, and they are also the same control the personal board
            already uses -- one thing to learn rather than two.

            The chips go on their own row below the bar rather than joining the
            board chips and the list dropdown on one line: four chips plus two
            dropdowns do not fit a laptop, and wrapping puts them on top of each
            other. */}
      </div>

      {source === LIST_SOURCES.POINTERCRATE && (
        <div className="lb-part-filters" role="group" aria-label="Filter by Pointercrate list">
          <button
            type="button"
            className={parts === '' ? 'lb-filter lb-filter-active' : 'lb-filter'}
            aria-pressed={parts === ''}
            onClick={() => setParts('')}
          >
            All lists
          </button>
          {POINTERCRATE_PARTS.map((part) => (
            <button
              key={part.id}
              type="button"
              className={parts === part.id ? 'lb-filter lb-filter-active' : 'lb-filter'}
              aria-pressed={parts === part.id}
              onClick={() => setParts(parts === part.id ? '' : part.id)}
            >
              {part.label} only
            </button>
          ))}
        </div>
      )}

      {error && <div className="validation-message">{error}</div>}

      {/* Rows stay hidden until they belong to the filter on screen. `loaded`
          already disagrees with the selection the moment it changes, but the
          previous response was left painted underneath, so a fast click through
          the chips showed the last board for a moment under the new one. */}
      {isLoading && <p className="global-board-message">Loading the global leaderboard...</p>}

      {!isLoading && data && data.personal && (
        <p className="lb-note">
          You have submitted {data.personal.runs} run{data.personal.runs === 1 ? '' : 's'}, best{' '}
          {data.personal.best}%
          {data.you ? `, ranked #${data.you.rank} on this board.` : '. Submit a run to be ranked.'}
        </p>
      )}

      {!isLoading && data && data.entries.length === 0 && !error && (
        <p className="global-board-message">
          No runs on this board yet. Sign in and submit one from the results screen.
        </p>
      )}

      <div className="lb-list">
        {!isLoading && (data?.entries ?? []).map((entry) => {
          const isYou = user && entry.username === user.username
          return (
            <div
              key={`${entry.username}-${entry.runId}`}
              className={isYou ? 'lb-row lb-row-you' : 'lb-row'}
            >
              <span className="lb-rank">#{entry.rank}</span>
              {/* The same button class the personal board uses. It was a span
                  here, so it inherited the pointer and did nothing with it.
                  The name is the player's profile. */}
              <button
                type="button"
                className="lb-main"
                onClick={() => onOpenProfile?.(entry.username)}
                aria-label={`Open @${entry.username}'s profile`}
              >
                <span className="lb-top">
                  {/* The display name is what the player chose to be known by, so
                      it leads. The @handle follows it because the two are not the
                      same thing and only one of them is editable: a display name
                      can be anything, so a run ranked under "Alex" beside "@alex2"
                      is one account and not a look-alike impostor -- and printing
                      the handle is what makes that distinguishable. Showing only
                      the display name left no way to tell two players apart at
                      all. */}
                  <strong>{entry.displayName}</strong>
                  <span className="lb-handle">@{entry.username}</span>
                  {isYou && <em className="lb-you-tag">you</em>}
                  <span className="lb-sub">
                    {entry.passed} cleared · {entry.roundsPlayed} played ·{' '}
                    {formatDurationMs(entry.totalMs)}
                    {entry.timedOut ? ' · out of time' : ''} · {formatWhen(entry.createdAt)}
                  </span>
                </span>
                <span className="lb-sub">
                  {/* Masked at render, from the raw stored source. A run's source
                      is the list's identity string and is compared exactly on the
                      server, so it is never rewritten -- only what is printed. */}
                  {censorText(entry.source)}
                  <PointercratePartsBadge parts={entry.pointercrateParts} />
                  {entry.percentStep !== 1 ? ` · +${entry.percentStep}% steps` : ''} ·{' '}
                  {STATUS_LABELS[entry.status] ?? entry.status}
                </span>
              </button>
              <strong className="lb-pct">{entry.score}%</strong>
            </div>
          )
        })}
      </div>
    </div>
  )
}
