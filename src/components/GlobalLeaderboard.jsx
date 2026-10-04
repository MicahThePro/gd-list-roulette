import { useCallback, useEffect, useRef, useState } from 'react'
import { LEADERBOARD_BOARDS, fetchLeaderboard } from '../services/apiService'
import { LIST_SOURCES, LIST_SOURCE_LABELS } from '../services/listService'
import { censorText } from '../utils/censor'
import { formatDurationMs } from '../utils/roulette'
import PointercratePartsBadge from './PointercratePartsBadge'
import { POINTERCRATE_PARTS } from '../services/pointercrateParts.js'
import { useTranslate } from '../i18n/useTranslate.js'
import { statusLabel } from '../utils/statusLabel.js'

/* The list filter, built from the same names the list loader gives a run.
 * These were retyped here and drifted once: this filter expected 'All Rated
 * Extreme Demons List' while runs were stored as 'AREDL', so selecting AREDL
 * matched nothing and its runs were only ever visible under "All lists".
 *
 * `id` is the raw stored name and `label` is the censored one. Keeping them apart
 * is the whole point: `id` is what is sent to the Worker and matched with an exact
 * comparison, so it has to be the string runs are actually stored under. Censoring
 * the id would filter on a value no run has, and the option would select nothing. */
/* The list names stay in their own language -- they are also the exact values a
 * run is stored under and filtered by. Only "All lists" is site copy. */
const SOURCES = [
  { id: 'all', labelKey: 'board.allLists' },
  ...Object.values(LIST_SOURCES).map((name) => ({
    id: name,
    label: censorText(LIST_SOURCE_LABELS[name] ?? name),
  })),
]

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
export default function GlobalLeaderboard({ user }) {
  const { t } = useTranslate()
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
  const load = useCallback(
    (signal) => {
      /* A refresh asked for while a control is being used is dropped rather than
       * queued. Holding it would only close the popup on the very next tick,
       * which is the bug this guard exists to stop. */
      if (isBarBusyRef.current) return Promise.resolve()
      return fetchLeaderboard({ board, source, parts, signal })
        .then((result) => {
          setData(result)
          setLoaded({ board, source, parts })
          setError('')
        })
        .catch((caught) => {
          if (caught?.name === 'AbortError') return
          setError(caught?.message ?? t('global.loadFailed'))
        })
    },
    [board, source, parts, t],
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
   * duplicate request on every mount is a cost with no reader. */
  const hasLoadedOnce = useRef(false)
  useEffect(() => {
    if (isBarBusy) return
    if (!hasLoadedOnce.current) {
      hasLoadedOnce.current = true
      return
    }
    load(new AbortController().signal)
  }, [isBarBusy, load])

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
        <div className="global-board-boards" role="tablist" aria-label={t('global.boardsAria')}>
          {LEADERBOARD_BOARDS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              aria-selected={board === entry.id}
              className={board === entry.id ? 'secondary-button small-button board-chip board-chip-active' : 'secondary-button small-button board-chip'}
              onClick={() => setBoard(entry.id)}
            >
              {t(entry.labelKey ?? entry.id)}
            </button>
          ))}
        </div>

        <label className="global-board-source">
          <span className="visually-hidden">{t('board.filterByList')}</span>
          <select value={source} onChange={(event) => handleSourceChange(event.target.value)}>
            {SOURCES.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.labelKey ? t(entry.labelKey) : entry.label}
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
        <div className="lb-part-filters" role="group" aria-label={t('board.filterByPointercrate')}>
          <button
            type="button"
            className={parts === '' ? 'lb-filter lb-filter-active' : 'lb-filter'}
            aria-pressed={parts === ''}
            onClick={() => setParts('')}
          >
            {t('board.allLists')}
          </button>
          {POINTERCRATE_PARTS.map((part) => (
            <button
              key={part.id}
              type="button"
              className={parts === part.id ? 'lb-filter lb-filter-active' : 'lb-filter'}
              aria-pressed={parts === part.id}
              onClick={() => setParts(parts === part.id ? '' : part.id)}
            >
              {t('board.partOnly', { part: part.label })}
            </button>
          ))}
        </div>
      )}

      {error && <div className="validation-message">{error}</div>}

      {isLoading && !data && <p className="global-board-message">{t('global.loading')}</p>}

      {data && data.personal && (
        <p className="lb-note">
          {t('global.personalNoteRuns', {
            count: data.personal.runs,
            runs: data.personal.runs === 1 ? t('global.personalRunsOne') : t('global.personalRunsMany'),
            best: data.personal.best,
          })}
          {data.you ? t('global.personalNoteRanked', { rank: data.you.rank }) : t('global.personalNoteSubmit')}
        </p>
      )}

      {data && data.entries.length === 0 && !error && (
        <p className="global-board-message">
          {t('global.empty')}
        </p>
      )}

      <div className="lb-list">
        {(data?.entries ?? []).map((entry) => {
          const isYou = user && entry.username === user.username
          return (
            <div
              key={`${entry.username}-${entry.runId}`}
              className={isYou ? 'lb-row lb-row-you' : 'lb-row'}
            >
              <span className="lb-rank">#{entry.rank}</span>
              <span className="lb-main">
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
                  {isYou && <em className="lb-you-tag">{t('global.you')}</em>}
                  <span className="lb-sub">
                    {t('global.rowMeta', {
                      cleared: entry.passed,
                      played: entry.roundsPlayed,
                      time: formatDurationMs(entry.totalMs),
                    })}
                    {entry.timedOut ? t('global.outOfTime') : ''} · {formatWhen(entry.createdAt)}
                  </span>
                </span>
                <span className="lb-sub">
                  {/* Masked at render, from the raw stored source. A run's source
                      is the list's identity string and is compared exactly on the
                      server, so it is never rewritten -- only what is printed. */}
                  {censorText(entry.source)}
                  <PointercratePartsBadge parts={entry.pointercrateParts} />
                  {entry.percentStep !== 1 ? t('global.steps', { step: entry.percentStep }) : ''} ·{' '}
                  {statusLabel(t, entry.status)}
                </span>
              </span>
              <strong className="lb-pct">{entry.score}%</strong>
            </div>
          )
        })}
      </div>
    </div>
  )
}
