import { useEffect, useState } from 'react'
import Leaderboard from '../components/Leaderboard'
import GlobalLeaderboard from '../components/GlobalLeaderboard'
import AccountDialog from '../components/AccountDialog'
import WorkerSignal from '../components/WorkerSignal'
import ChangelogDialog from '../components/ChangelogDialog'
import SettingsDialog from '../components/SettingsDialog'
import LanguagePicker from '../components/LanguagePicker'
import CustomRunBuilder from '../components/CustomRunBuilder'
import { fetchAredlListBounds, fetchChallengeListBounds, fetchGslListBounds, fetchImpossibleLevelsBounds, LIST_SOURCES } from '../services/listService'
import { usePersistentPercentStep } from '../hooks/usePersistentPercentStep'
import { usePersistentListSource } from '../hooks/usePersistentListSource'
import { SITE_NAME, LATEST_VERSION } from '../data/changelog'
import { usePointercrateParts } from '../hooks/usePointercrateParts'
import { POINTERCRATE_PARTS } from '../services/pointercrateParts.js'
import { censorText } from '../utils/censor'
import { translate } from '../i18n/i18n.js'
import { useTranslate } from '../i18n/useTranslate.js'

const CHALLENGE_LIST_SOURCE = 'challengelist'
const IMPOSSIBLE_LEVELS_SOURCE = 'impossiblelevels'
/* Full names for the list dropdown.
 *
 * GSL is taken from LIST_SOURCES and passes through censorText when it renders, so it
 * reads "Global S****y List" while the mask is on and "Global Shitty List" once the
 * player has turned it off, with no second string kept here to fall out of step with
 * that setting.
 *
 * AREDL is the exception and cannot come from LIST_SOURCES, because there the value
 * 'AREDL' is data, not a label -- it is what a run is stamped with and what the
 * submission check and the global board's filter match on. The long form belongs to
 * the dropdown alone. Writing it there is safe precisely because nothing keys off it;
 * putting it in LIST_SOURCES is the drift sourceNames.test.js exists to catch, and its
 * "the long form of the AREDL name is not used as data" check is what fails if so.
 *
 * The option *values* stay the raw source ids either way, so the name shown can change
 * without changing which list is played or what a finished run is recorded as. */
const SOURCE_LABELS = {
  pointercrate: LIST_SOURCES.POINTERCRATE,
  aredl: 'All Rated Extreme Demons List (AREDL)',
  gsl: LIST_SOURCES.GSL,
  [CHALLENGE_LIST_SOURCE]: LIST_SOURCES.CHALLENGE,
  [IMPOSSIBLE_LEVELS_SOURCE]: LIST_SOURCES.IMPOSSIBLE,
}
const RANKABLE_SOURCES = ['aredl', 'gsl', CHALLENGE_LIST_SOURCE, IMPOSSIBLE_LEVELS_SOURCE]
const DEFAULT_MAX = 150

const getBoundsForSource = (sourceName) => {
  if (sourceName === 'gsl') return fetchGslListBounds()
  if (sourceName === CHALLENGE_LIST_SOURCE) return fetchChallengeListBounds()
  if (sourceName === IMPOSSIBLE_LEVELS_SOURCE) return fetchImpossibleLevelsBounds()
  return fetchAredlListBounds()
}

export default function HomePage({ onStart, onOpenCustomRun, history, gameRules, isMasked, onIsMaskedChange, auth }) {
  const { t } = useTranslate()
  const [isLoading, setIsLoading] = useState(false)
  const [isBoardOpen, setIsBoardOpen] = useState(false)
  // The board view has two halves: what this browser has played, and what
  // everybody has submitted. Separate tabs rather than one merged list, so a
  // personal run is never mistaken for a submitted one.
  const [boardTab, setBoardTab] = useState('mine')
  const [isAccountOpen, setIsAccountOpen] = useState(false)
  const [isChangelogOpen, setIsChangelogOpen] = useState(false)
  const [isCustomBuilderOpen, setIsCustomBuilderOpen] = useState(false)
  const [source, setSource] = usePersistentListSource()
  /* Only meaningful for Pointercrate; the tick boxes are hidden on every other
   * source rather than shown disabled, because there is no second list to pick
   * from there and a dead control invites the question. */
  const { parts: pointercrateParts, togglePart } = usePointercrateParts()
  const isPointercrate = source === 'pointercrate'
  const [startRange, setStartRange] = useState('')
  const [endRange, setEndRange] = useState('')
  const [rangeMax, setRangeMax] = useState(DEFAULT_MAX)
  /* Said out loud rather than swallowed. A run on an account is deleted on the
     server, and a delete that does not reach the server leaves the run exactly
     where it was -- so a failure here has to be visible, or the button reads as
     broken with nothing to explain why. */
  const [boardError, setBoardError] = useState('')
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [percentStep, setPercentStep] = usePersistentPercentStep()
  const [percentStepDraft, setPercentStepDraft] = useState(() => String(percentStep))
  // The time limits follow the same commit-on-blur pattern as the percentage
  // step: the draft is free to be empty while typing, and the real value only
  // lands on blur, so clearing the field is possible at all.
  const [levelTimeLimitDraft, setLevelTimeLimitDraft] = useState(() =>
    String(gameRules.levelTimeLimitMinutes),
  )
  const [totalTimeLimitDraft, setTotalTimeLimitDraft] = useState(() =>
    String(gameRules.totalTimeLimitMinutes),
  )
  const estimatedRounds = Math.ceil(100 / percentStep)
  const isRankable = RANKABLE_SOURCES.includes(source)

  /* Whether there is an account to hold runs.
   *
   * A personal board with no account behind it could only be empty: runs are not
   * saved while signed out, so there is nothing for it to show and nothing the
   * player could do on it. Rather than render an empty board and a tab that leads
   * nowhere, the personal board is simply not there, and a signed-out player gets
   * the global one. This is the same question the history answers for itself, read
   * from the one place that already knows. */
  const hasAccount = Boolean(auth.user)

  /* Which board is on screen.
   *
   * Derived rather than stored on purpose: a stored tab would remember 'mine' from
   * a session where an account was signed in, and signing out would leave a signed
   * out player staring at the personal board with no way to have chosen it. Forced
   * to 'global' while signed out means the tab the player cannot use is never the
   * one they land on, and signing back in restores their own board. */
  const activeTab = hasAccount ? boardTab : 'global'

  const clampValue = (value, minimum = 1, maximum = rangeMax) => {
    const numeric = Number(value)
    if (!Number.isFinite(numeric)) {
      return minimum
    }

    return Math.min(Math.max(Math.trunc(numeric), minimum), maximum)
  }

  const normalizeDraft = (value, minimum = 1, maximum = rangeMax) => {
    if (value === '') {
      return ''
    }

    const numeric = Number(value)
    if (!Number.isFinite(numeric)) {
      return ''
    }

    const cleaned = String(Math.trunc(numeric))
    if (Number(cleaned) < minimum) {
      return String(minimum)
    }
    if (Number(cleaned) > maximum) {
      return String(maximum)
    }
    return cleaned
  }

  useEffect(() => {
    if (!RANKABLE_SOURCES.includes(source)) {
      setRangeMax(DEFAULT_MAX)
      return undefined
    }

    let isActive = true

    const loadBounds = async () => {
      const bounds = await getBoundsForSource(source)
      if (!isActive) return
      const resolvedMax = Math.max(1, Number(bounds.end) || DEFAULT_MAX)
      setRangeMax(resolvedMax)
      // Always reset to the full range for the newly selected list. Clamping
      // the previous value would be wrong in one direction: going from a
      // longer list to a shorter one hides levels, and going from a shorter
      // list to a longer one would keep the old smaller end value.
      setStartRange('1')
      setEndRange(String(resolvedMax))
    }

    loadBounds().catch(() => {
      if (isActive) {
        setRangeMax(DEFAULT_MAX)
        setStartRange('1')
        setEndRange(String(DEFAULT_MAX))
      }
    })

    return () => {
      isActive = false
    }
  }, [source])

  const handleStartChange = (value) => {
    const nextStart = value === '' ? '' : normalizeDraft(value, 1, rangeMax)
    setStartRange(nextStart)

    if (nextStart !== '' && endRange !== '') {
      const numericStart = Number(nextStart)
      const numericEnd = Number(endRange)
      if (Number.isFinite(numericEnd) && numericStart > numericEnd) {
        setEndRange(String(numericStart))
      }
    }
  }

  const handleEndChange = (value) => {
    if (value === '') {
      setEndRange('')
      return
    }

    const minimum = Number(startRange || 1)
    const nextValue = normalizeDraft(value, 1, rangeMax)
    if (Number(nextValue) < minimum) {
      setEndRange(String(minimum))
      return
    }

    setEndRange(nextValue)
  }

  // The draft is free to be empty so the field can be cleared while typing;
  // the real value only commits on blur, falling back to 1.
  const handlePercentStepChange = (value) => {
    setPercentStepDraft(value)
  }

  const commitPercentStep = () => {
    const committed = setPercentStep(percentStepDraft)
    setPercentStepDraft(String(committed))
  }

  // An empty field means off, not zero-as-typed-and-uncommitted, so an emptied
  // box clears the limit rather than leaving the last committed one in place.
  const commitLevelTimeLimit = () => {
    const committed = gameRules.setLevelTimeLimitMinutes(levelTimeLimitDraft === '' ? 0 : levelTimeLimitDraft)
    setLevelTimeLimitDraft(String(committed))
  }

  const commitTotalTimeLimit = () => {
    const committed = gameRules.setTotalTimeLimitMinutes(totalTimeLimitDraft === '' ? 0 : totalTimeLimitDraft)
    setTotalTimeLimitDraft(String(committed))
  }

  const handleSubmit = async (event) => {
    event.preventDefault()
    setIsLoading(true)
    try {
      const nextStart = isRankable ? clampValue(startRange || '1', 1, rangeMax) : undefined
      const nextEnd = isRankable ? clampValue(endRange || String(rangeMax), 1, rangeMax) : undefined

      if (isRankable && nextEnd < nextStart) {
        setEndRange(String(nextStart))
      }

      await onStart({
        source,
        start: nextStart,
        end: nextEnd,
        percentStep,
        /* Only Pointercrate has parts. Passed for every source anyway, because
           normalizeListRequest drops it for the others and a conditional
           argument is one more thing that can go out of step with the list. */
        pointercrateParts,
      })
    } finally {
      setIsLoading(false)
    }
  }

  /* One message for both. The two failures have the same shape -- the run is
     still on the board because the server did not take the delete -- so they say
     the same thing, and clearing it on the next attempt means a delete that works
     takes the complaint away with it. */
  const reportBoardError = (error) => {
    setBoardError(error?.message ?? t('home.deleteRunFailed'))
  }

  return (
    <main className="page-shell home-page">
      {/* The leaderboard replaces the start form rather than overlaying it.
          A fixed overlay measured correctly in the DOM but did not reliably
          paint above the page, and a full-page view is simpler and matches the
          request for it to fill the screen. */}
      {isBoardOpen ? (
        <section className="panel board-page">
          <header className="board-page-bar">
            <div>
              <p className="eyebrow">{t('home.eyebrowRuns')}</p>
              <h2>{t('home.leaderboards')}</h2>
            </div>
            <button
              type="button"
              className="secondary-button"
              onClick={() => setIsBoardOpen(false)}
            >
              {t('common.back')}
            </button>
          </header>

          {/* The two boards are separate views rather than two lists in one
              scroll area, so a personal run can never be read as a submitted
              one and a clear-all here can never be mistaken for clearing the
              global board.

              This sits inside .board-page, which is a three row grid: header,
              the list area, then the footer. The tab strip is NOT given its own
              row, because a fourth child lands in the minmax(0, 1fr) row and
              stretches to fill it, which is what made these two buttons tower
              over the whole page. It is placed inside the list row instead, so
              the row count is unchanged and the strip is only as tall as it
              needs to be. */}
          <div className="board-body">
            {/* The tab strip only exists with an account. Signed out there is one
                board, so a strip offering a choice that is not really there would
                be decoration pretending to be a control. */}
            {hasAccount && (
              <div className="board-view-tabs" role="tablist" aria-label={t('board.leaderboardAria')}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'mine'}
                  className={activeTab === 'mine' ? 'board-view-tab board-view-tab-active' : 'board-view-tab'}
                  onClick={() => setBoardTab('mine')}
                >
                  {t('home.yourRuns')}
                  {history.entries.length > 0 && (
                    <span className="lb-badge">{history.entries.length}</span>
                  )}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={activeTab === 'global'}
                  className={activeTab === 'global' ? 'board-view-tab board-view-tab-active' : 'board-view-tab'}
                  onClick={() => setBoardTab('global')}
                >
                  {t('home.global')}
                </button>
              </div>
            )}

          {!hasAccount && (
              /* Says why the other board is not here, rather than leaving its
                 absence to be noticed. A player who has run on this site before
                 will look for their own runs, and "nothing here" reads as lost
                 data unless it is explained. */
              <p className="settings-note board-signed-out-note">
                {t('home.boardSignedOut')}
              </p>
          )}

          {activeTab === 'global' ? (
            <GlobalLeaderboard user={auth.user} />
          ) : (
            <div className="board-personal">
              {/* Only on the personal board: a failed delete is about this list, and
                  a message sitting under the global board would blame the wrong
                  thing. */}
              {boardError && <div className="validation-message">{boardError}</div>}
              <Leaderboard
                entries={history.entries}
                onDelete={(id) => history.deleteEntry(id, { onServerError: reportBoardError })}
                auth={auth}
              />
            </div>
          )}
          </div>
        </section>
      ) : (
      <section className="panel hero-panel">
        <header className="hero-copy">
          <p className="eyebrow">{t('home.eyebrow')}</p>
          <h1>
            {SITE_NAME}
            <span className="hero-version">{LATEST_VERSION}</span>
            <WorkerSignal />
          </h1>
          <p className="lead">
            {t('home.lead')}
          </p>
        </header>

        <div className="hero-columns">
          <div className="hero-column hero-column-main">
            <form className="setup-form" onSubmit={handleSubmit}>
          <div className="settings-row">
            <button
              type="button"
              className="secondary-button small-button"
              onClick={() => setIsSettingsOpen(true)}
              aria-expanded={isSettingsOpen}
            >
              {t('home.settings')}
            </button>
            <button
              type="button"
              className="secondary-button small-button"
              onClick={() => setIsBoardOpen((open) => !open)}
              aria-expanded={isBoardOpen}
            >
              {isBoardOpen ? t('home.hideLeaderboard') : t('home.leaderboard')}
              {/* The count is the account's runs, so it is only shown to somebody
                  signed in who can actually open the board it counts. */}
              {hasAccount && history.entries.length > 0 && (
                <span className="lb-badge">{history.entries.length}</span>
              )}
            </button>
            <button
              type="button"
              className="secondary-button small-button"
              onClick={() => setIsChangelogOpen(true)}
            >
              {t('home.whatsNew')}
            </button>
            <button
              type="button"
              className="secondary-button small-button"
              onClick={() => {
                if (auth.user) setIsCustomBuilderOpen(true)
                else setIsAccountOpen(true)
              }}
            >
              {t('home.createRun')}
            </button>
            <button
              type="button"
              className="secondary-button small-button"
              onClick={() => setIsAccountOpen(true)}
            >
              {auth.user ? auth.user.displayName : t('home.signIn')}
            </button>
            <span className="settings-summary">
              {t('home.stepSummary', { step: percentStep, rounds: estimatedRounds })}
              {/* Best score is read off the account's runs, so signed out there is
                  no best to report -- and showing a bare "Best 0%" would read as a
                  claim that the player has done nothing. */}
              {hasAccount && history.entries.length > 0 && t('home.best', { score: history.bestScore })}
            </span>
          </div>

          <label>
            {t('home.listSource')}
            <select
              className="source-select"
              value={source}
              onChange={(event) => setSource(event.target.value)}
            >
              {/* Keys stay the raw source ids -- that is what the loader matches
                  on. Only the text a player reads is censored, so the option is
                  chosen by name but still selects the same list as before. */}
              {Object.entries(SOURCE_LABELS).map(([id, label]) => (
                <option key={id} value={id}>
                  {censorText(label)}
                </option>
              ))}
            </select>
          </label>

          {/* Pointercrate publishes three lists. They are shown as tick boxes
              rather than a dropdown because they are not alternatives -- they are
              three disjoint slices of one ranked sequence, and ticking two is a
              real choice a player makes to widen the draw. A dropdown would force
              exactly one.

              Hidden rather than disabled on the other four sources: there is no
              second list there to choose, so a greyed-out control would only
              raise the question. */}
          {isPointercrate && (
            <fieldset className="pointercrate-parts">
              <legend>{t('home.pointercrateLists')}</legend>
              {POINTERCRATE_PARTS.map((part) => (
                <label className="settings-toggle-row" key={part.id}>
                  <input
                    type="checkbox"
                    checked={pointercrateParts.includes(part.id)}
                    onChange={() => togglePart(part.id)}
                  />
                  <span>
                    <strong>{part.label}</strong>
                    <small>{translate(part.key)}</small>
                  </span>
                </label>
              ))}
              {/* Said outright, because it is the one non-obvious thing about these three:
                  that together the first two are the whole ranked top 150, which is
                  what this source played before the boxes existed. */}
              <small className="pointercrate-parts-hint">
                {t('home.pointercrateHint')}
              </small>
            </fieldset>
          )}

          {isRankable && (
            <div className="range-row">
              <label>
                {t('home.startRank')}
                <input
                  type="number"
                  step="1"
                  value={startRange}
                  onChange={(event) => handleStartChange(event.target.value)}
                  placeholder="1"
                />
              </label>
              <label>
                {t('home.endRank')}
                <input
                  type="number"
                  step="1"
                  value={endRange}
                  onChange={(event) => handleEndChange(event.target.value)}
                  placeholder={String(rangeMax)}
                />
              </label>
              <small className="range-hint">{t('home.arrowHint')}</small>
            </div>
          )}

          <button type="submit" className="primary-button" disabled={isLoading}>
            {isLoading ? t('home.loadingList', { source: SOURCE_LABELS[source] ?? t('common.loading') }) : t('home.startRoulette')}
          </button>
            </form>
          </div>

          {/* At the bottom of the menu rather than in the settings dialog on purpose:
              it is a one-time choice, not a rule the player tunes between runs, and
              somebody who cannot read the site at all needs to find it before they
              can open anything else. */}
          <LanguagePicker />
        </div>

      </section>
      )}
      <SettingsDialog
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        percentStep={percentStep}
        percentStepDraft={percentStepDraft}
        onDraftChange={handlePercentStepChange}
        onCommit={commitPercentStep}
        estimatedRounds={estimatedRounds}
        allowSkip={gameRules.allowSkip}
        onAllowSkipChange={gameRules.setAllowSkip}
        levelTimeLimitDraft={levelTimeLimitDraft}
        onLevelTimeLimitDraftChange={setLevelTimeLimitDraft}
        onCommitLevelTimeLimit={commitLevelTimeLimit}
        totalTimeLimitDraft={totalTimeLimitDraft}
        onTotalTimeLimitDraftChange={setTotalTimeLimitDraft}
        onCommitTotalTimeLimit={commitTotalTimeLimit}
        isMasked={isMasked}
        onIsMaskedChange={onIsMaskedChange}
      />
      <AccountDialog
        isOpen={isAccountOpen}
        onClose={() => setIsAccountOpen(false)}
        auth={auth}
        onSignedOut={history.restoreLocal}
      />
      <ChangelogDialog
        isOpen={isChangelogOpen}
        onClose={() => setIsChangelogOpen(false)}
      />
      {isCustomBuilderOpen && auth.user && (
        <CustomRunBuilder
          user={auth.user}
          onClose={() => setIsCustomBuilderOpen(false)}
          onOpenRun={(url) => {
            setIsCustomBuilderOpen(false)
            onOpenCustomRun(url)
          }}
        />
      )}
    </main>
  )
}
