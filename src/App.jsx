import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getLanguage, subscribeToLanguage } from './i18n/i18n.js'
import { useTranslate } from './i18n/useTranslate.js'
import HomePage from './pages/HomePage'
import RoulettePage from './pages/RoulettePage'
import ResultsPage from './pages/ResultsPage'
import { usePersistentRun } from './hooks/usePersistentRun'
import { useRunHistory, purgeLegacyHistoryKeys } from './hooks/useRunHistory'
import { useAuth } from './hooks/useAuth'
import { useGameRules, timeLimitMinutesToMs } from './hooks/useGameRules'
import { useCensorSetting } from './hooks/useCensorSetting'
import PreviewBanner from './components/PreviewBanner'
import RedeemCodePage from './pages/RedeemCodePage'
import ProfilePage from './pages/ProfilePage'
import NotificationsPage from './pages/NotificationsPage'
import CustomRunPage from './pages/CustomRunPage'
import { getPreviewUser, syncPlayerData } from './services/adminService'
import { fetchMyEntries, fetchNotificationsCount } from './services/apiService'
import { getCustomRunLevel } from './services/customRunService'
import { fetchAredlLevelDetails, fetchChallengeLevelDetails, fetchImpossibleLevelDetails, fetchList } from './services/listService'
import { clampPercent, createRun, createLevelResult, countSkipReason, getElapsedLevelTimeMs, getRunElapsedMs, getNextTargetPercent, normalizePercentStep, pickNextLevel, summarizeResult } from './utils/roulette'
import { SITE_NAME, LATEST_VERSION } from './data/changelog'
import './App.css'

const SCREEN = {
  HOME: 'home',
  ROULETTE: 'roulette',
  RESULTS: 'results',
  REDEEM: 'redeem',
  PROFILE: 'profile',
  NOTIFICATIONS: 'notifications',
  CUSTOM_RUN: 'custom-run',
}

/* The player's own settings, read straight out of the cookies the rules hook
   writes, for the mirror a moderator can see.
 *
 * Read from the cookie rather than from the hook because the mirror is about what
 * is actually stored for the account, not about what the current page happens to
 * have in memory, and a missing cookie is simply a rule left at its default. */
const readCookieValue = (name) => {
  if (typeof document === 'undefined') return null
  const match = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null
}

const readStoredSettings = () => ({
  allowSkip: readCookieValue('demon-roulette-allow-skip'),
  levelTimeLimit: readCookieValue('demon-roulette-level-time-limit'),
  totalTimeLimit: readCookieValue('demon-roulette-total-time-limit'),
  listSource: readCookieValue('demon-roulette-list-source'),
  percentStep: readCookieValue('demon-roulette-percent-step'),
})

// The moderation panel is NOT a route in this app. It is its own entry point at
// /admin, built from admin/index.html into admin/index.html in the output,
// because GitHub Pages is a static host with no server to rewrite a path into
// the main page: a client-side route there returns GitHub's 404. See
// src/adminMain.jsx.

// The AREDL list endpoint returns no creator or video, only publisher_id, so
// those come from the per-level detail endpoint. That is fetched on demand for
// the one level on screen rather than for the whole list, which would be far
// too slow. run.source holds the list's display title.
const HYDRATABLE_SOURCES = new Set(['AREDL'])

// The Impossible Levels list omits the rate a level must be played at and the
// game version it needs, and neither can be derived from the list fields (the
// TPS/FPS unit depends on the level's 2.2 tag). Both are asked of the Worker
// for the one level on screen. The build-time snapshot may already carry them,
// in which case there is nothing to fetch.
const RATE_SOURCE = 'Impossible Levels List'

// run.source holds the list's display title, same as RATE_SOURCE above.
const CHALLENGE_SOURCE = 'Challenge List'

const attachLevelDetails = async (runState, level) => {
  if (!level || runState?.source !== RATE_SOURCE) {
    return level
  }

  if (level.rate && level.version) {
    return level
  }

  const { rate, version } = await fetchImpossibleLevelDetails(level.listId)
  return { ...level, rate: level.rate ?? rate, version: level.version ?? version }
}

const hydrateLevelForRun = async (runState, level) => {
  const withDetails = await attachLevelDetails(runState, level)
  const withAredl = await hydrateAredlLevel(runState, withDetails)
  return hydrateChallengeLevel(runState, withAredl)
}

/* The Challenge List index carries no level id and no video: challengelist.gd
 * publishes both only on a challenge's own page, and a Worker cannot visit 100
 * of those in one invocation -- it tried, and every fetch past the 49th threw, so
 * half the list rendered with no thumbnail and no id at all while the site
 * reported a successful load.
 *
 * So they are fetched here, for the one level on screen, the same as the
 * Impossible Levels rate. The Worker caches the answer at the edge for a week, so
 * this is one request the first time a level is reached and none after that.
 *
 * The fields already present win. The build-time snapshot carries both for every
 * level, and that path needs no request at all -- which is what keeps the list
 * usable when the Worker is down. */
const hydrateChallengeLevel = async (runState, level) => {
  if (!level || runState?.source !== CHALLENGE_SOURCE) {
    return level
  }

  if (level.levelId != null && level.video) {
    return level
  }

  const { levelId, video } = await fetchChallengeLevelDetails(level.listId)

  return {
    ...level,
    levelId: level.levelId ?? levelId,
    video: level.video ?? video,
    thumbnail:
      level.thumbnail ??
      (video ? `https://i.ytimg.com/vi/${video}/mqdefault.jpg` : null),
  }
}

const hydrateAredlLevel = async (runState, level) => {
  if (!level || !HYDRATABLE_SOURCES.has(runState?.source)) {
    return level
  }

  const creatorValue = typeof level.creator === 'string' ? level.creator.trim() : ''
  const thumbnailValue = typeof level.thumbnail === 'string' ? level.thumbnail.trim() : ''
  const shouldHydrate =
    !thumbnailValue ||
    !creatorValue ||
    creatorValue === 'Unknown creator' ||
    creatorValue === 'Unknown Creator'

  if (!shouldHydrate) {
    return level
  }

  const hydratedLevel = await fetchAredlLevelDetails(level)

  if (!hydratedLevel) {
    return level
  }

  return {
    ...level,
    ...hydratedLevel,
    creator: hydratedLevel.creator || level.creator || 'Unknown creator',
    thumbnail: hydratedLevel.thumbnail || level.thumbnail || null,
  }
}

function App() {
  /* Held up here so a language change repaints the whole app.
   *
   * The store itself lives in i18n/i18n.js rather than in context, because the
   * mask and the language are both read by plain functions called from inside
   * JSX in components that are handed no settings at all. What that design cannot
   * do is re-render anything by itself -- a ref and a module variable both fail
   * silently here -- so this one subscription is what turns a click on a
   * language button into a redraw of every screen. Nothing below this component
   * has to know the language exists: they all read `t` at render, and this makes
   * sure they are rendered again. */
  const { language, t } = useTranslate()
  const [, setLanguageState] = useState(getLanguage)
  useEffect(() => subscribeToLanguage(setLanguageState), [])
  /* Referenced so the language itself is a dependency of the title effect below,
     which is the one piece of site text a screen reader and a browser tab both
     read, and neither of them repaints on a state change alone. */
  const currentLanguage = language
  const [customRunId, setCustomRunId] = useState(() =>
    typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('custom') : null,
  )
  // The redeem page is reached as /redeem, a real path rather than a state, so a
  // moderator can bookmark it or have the admin panel link straight to it. GitHub
  // Pages cannot rewrite an unknown path into this app, so it is only honoured
  // when the file was actually served -- which is why it has to be its own
  // directory like the admin panel is. Read once at startup rather than in an
  // effect, so the right screen is on the first paint instead of a frame later.
  const [screen, setScreen] = useState(() =>
    typeof window !== 'undefined'
      ? new URLSearchParams(window.location.search).has('custom')
        ? SCREEN.CUSTOM_RUN
        : /\/redeem\/?$/.test(window.location.pathname)
          ? SCREEN.REDEEM
          : SCREEN.HOME
      : SCREEN.HOME,
  )
  const [run, setRun] = usePersistentRun()
  const [profileUsername, setProfileUsername] = useState('geometricalmike')
  const [pendingRunNavigation, setPendingRunNavigation] = useState(null)
  const runNavigationDialogRef = useRef(null)
  const [notificationCount, setNotificationCount] = useState(0)
  const [socialVersion, setSocialVersion] = useState(0)
  const gameRules = useGameRules()
  /* Whether swear words are masked. Held up here rather than inside the settings
   * dialog because the mask is applied by a plain function that components call
   * directly, so a change has to redraw the whole app -- not just the dialog that
   * owns the checkbox. See the note on `censorText` for why it is not a prop. */
  const [isMasked, setIsMasked] = useCensorSetting()
  const auth = useAuth()
  /* The account the board belongs to, so runs can be told apart by whose they are.
   *
   * Declared before the history because the history is told which account it is
   * holding. It used to be the other way round and had to read the account after
   * the fact, which is why the board could end up showing one account's runs
   * under another's name. */
  const history = useRunHistory(auth.user?.username ?? null)
  // Identifies the run being played, so an ended run is recorded exactly once
  // even though several code paths reach the results screen.
  const trackedRunId = useRef(null)
  // The key of the run on the results screen, kept so the submission guard can
  // recognise a run that was already sent. State rather than the ref above,
  // because changing it has to re-render the results page.
  const [resultRunKey, setResultRunKey] = useState('')
  const [customRunError, setCustomRunError] = useState('')

  const currentStatus = useMemo(() => summarizeResult(run), [run])

  const refreshNotificationCount = useCallback(async () => {
    if (!auth.user) {
      setNotificationCount(0)
      return
    }

    try {
      const count = await fetchNotificationsCount()
      setNotificationCount(Number.isFinite(count) ? count : 0)
    } catch {
      setNotificationCount(0)
    }
  }, [auth.user])

  useEffect(() => {
    refreshNotificationCount()
  }, [refreshNotificationCount, auth.user?.username, auth.user?.id, screen])

  const bumpSocialState = useCallback(() => {
    setSocialVersion((current) => current + 1)
  }, [])

  // The browser tab title carries the version too, derived from the same
  // changelog entry as the on-page heading.
  useEffect(() => {
    document.title = `${SITE_NAME} ${LATEST_VERSION}`
  }, [currentLanguage])

  /* Deletes the copies of runs older versions kept in this browser.

   * Runs used to be held in a cookie and a localStorage mirror, which meant one
   * account's runs were readable by the next account signed in on the same
   * browser. Runs now live only on the account, and anything left behind by an
   * older version is a copy nobody on the site is responsible for any more, so it
   * is removed rather than left sitting in storage. */
  useEffect(() => {
    purgeLegacyHistoryKeys()
  }, [])

  const startRun = async (request = {}) => {
    const importedList = await fetchList(request)
    const percentStep = normalizePercentStep(request.percentStep ?? 1)
    const createdRun = createRun({
      startingPercent: percentStep,
      levels: importedList.levels,
      source: importedList.sourceTitle,
      allowDuplicates: false,
      percentStep,
      // The player's current rules are frozen onto the run here. Reading them
      // again while it is played would mean changing a setting mid-run silently
      // changed the rules.
      allowSkip: gameRules.allowSkip,
      levelTimeLimitMs: timeLimitMinutesToMs(gameRules.levelTimeLimitMinutes),
      totalTimeLimitMs: timeLimitMinutesToMs(gameRules.totalTimeLimitMinutes),
      // Which Pointercrate lists this run draws from, so the leaderboard can say
      // afterwards. Null on every other list, which is what createRun stores.
      pointercrateParts: importedList.pointercrateParts ?? null,
    })

    const hydratedCurrentLevel = await hydrateLevelForRun(createdRun, createdRun.currentLevel)
    setRun({
      ...createdRun,
      currentLevel: hydratedCurrentLevel,
    })
    setScreen(SCREEN.ROULETTE)
  }

  const startCustomRun = (definition, firstLevel) => {
    const createdRun = createRun({
      startingPercent: definition.percentStep,
      levels: [firstLevel],
      source: definition.source,
      allowDuplicates: true,
      percentStep: definition.percentStep,
      allowSkip: definition.allowSkip,
      levelTimeLimitMs: definition.levelTimeLimitMs,
      totalTimeLimitMs: definition.totalTimeLimitMs,
    })
    const customRun = {
      ...createdRun,
      currentLevel: firstLevel,
      usedLevelIds: [firstLevel.id],
      customRunId: definition.id,
      customRunCreator: definition.creator,
      customRunLevelCount: definition.levelCount,
      customRunIndex: 0,
    }
    trackedRunId.current = null
    setCustomRunError('')
    setRun(customRun)
    setScreen(SCREEN.ROULETTE)
  }

  const setCustomRunLocation = (id) => {
    const url = new URL(window.location.href)
    url.searchParams.set('custom', id)
    window.history.pushState({}, '', url)
    setCustomRunId(id)
    setScreen(SCREEN.CUSTOM_RUN)
  }

  const openCustomRunUrl = (url) => {
    const id = new URL(url, window.location.origin).searchParams.get('custom')
    if (!id) {
      throw new Error('The custom run link is missing its run id.')
    }
    setCustomRunLocation(id)
  }

  const finishRound = async (achievedPercent) => {
    if (!run || !run.currentLevel) return

    const normalizedAchieved = clampPercent(achievedPercent)
    const isSuccess = normalizedAchieved >= run.currentTarget
    const percentStep = normalizePercentStep(run.percentStep ?? 1)
    const endedAt = Date.now()
    const currentResult = createLevelResult({
      level: run.currentLevel,
      targetPercent: run.currentTarget,
      achievedPercent: normalizedAchieved,
      result: isSuccess ? 'success' : 'failure',
      startedAt: run.currentLevelStartedAt ?? endedAt,
      endedAt,
    })

    const updatedRounds = [
      ...run.rounds,
      {
        ...currentResult,
        roundNumber: run.rounds.length + 1,
      },
    ]

    const nextTarget = isSuccess
      ? getNextTargetPercent(normalizedAchieved, percentStep)
      : run.currentTarget
    const usedLevelIds = [...(run.usedLevelIds || []), run.currentLevel.id]
    const nextLevel = pickNextLevel(run.levels, usedLevelIds, run.allowDuplicates)

    if (!isSuccess) {
      const failedRun = {
        ...run,
        status: 'failed',
        rounds: updatedRounds,
        usedLevelIds,
        endingPercent: run.currentTarget,
      }
      endRun(failedRun, endedAt)
      return
    }

    if (run.customRunId && run.customRunIndex >= run.customRunLevelCount - 1) {
      const completedCustomRun = {
        ...run,
        status: 'completed',
        rounds: updatedRounds,
        usedLevelIds,
        endingPercent: normalizedAchieved,
        currentLevel: null,
      }
      endRun(completedCustomRun, endedAt)
      return
    }

    // The run finishes when the level just cleared reached 100%, not when the
    // next target would be 100. With a step of 20 the targets are 20, 40, 60,
    // 80, 100, so clearing 80 must still hand out the 100% level.
    if (normalizedAchieved >= 100) {
      const completedRun = {
        ...run,
        currentTarget: 100,
        status: 'completed',
        rounds: updatedRounds,
        usedLevelIds,
        endingPercent: 100,
        currentLevel: null,
      }
      endRun(completedRun, endedAt)
      return
    }

    let hydratedNextLevel
    if (run.customRunId) {
      try {
        const { level } = await getCustomRunLevel(run.customRunId, run.customRunIndex + 2)
        hydratedNextLevel = level
        setCustomRunError('')
      } catch (error) {
        setCustomRunError(t('roulette.customRunRetry', { message: error?.message ?? t('roulette.nextLevelFailed') }))
        return
      }
    } else {
      hydratedNextLevel = await hydrateLevelForRun(run, nextLevel)
    }
    const activeRun = {
      ...run,
      currentTarget: nextTarget,
      rounds: updatedRounds,
      usedLevelIds,
      currentLevel: hydratedNextLevel,
      currentLevelStartedAt: Date.now(),
      endingPercent: nextTarget,
      status: 'active',
      ...(run.customRunId ? { customRunIndex: run.customRunIndex + 1 } : {}),
    }

    setRun(activeRun)
  }

  // Every path that ends a run routes through here, so a run is recorded once
  // no matter whether it was cleared, failed, or given up.
  const endRun = useCallback(
    (endedRun, endedAt = Date.now(), nextScreen = SCREEN.RESULTS) => {
      setRun(endedRun)
      setScreen(nextScreen)

      const key = endedRun.runId ?? `${endedRun.source ?? ''}-${endedRun.startedAt ?? endedAt}`
      // The same key the submission guard uses, so the results screen and the
      // leaderboard row agree on which run this is.
      setResultRunKey(key)
      if (endedRun.customRunId) return
      if (trackedRunId.current === key) return
      trackedRunId.current = key
      history.recordRun(endedRun, endedAt)
    },
    [setRun, history],
  )

  // The reason is optional: a skip with no reason given still records a skip,
  // it just has no breakdown in the leaderboard.
  const handleSkip = async (skipReason = null) => {
    if (!run || !run.currentLevel) return

    const endedAt = Date.now()
    const currentResult = createLevelResult({
      level: run.currentLevel,
      targetPercent: run.currentTarget,
      achievedPercent: null,
      result: 'skipped',
      startedAt: run.currentLevelStartedAt ?? endedAt,
      endedAt,
      skipReason,
    })

    const usedLevelIds = [...(run.usedLevelIds || []), run.currentLevel.id]
    if (run.customRunId && run.customRunIndex >= run.customRunLevelCount - 1) {
      endRun({
        ...run,
        skippedCount: (run.skippedCount || 0) + 1,
        skipReasons: countSkipReason(run.skipReasons, currentResult.skipReason),
        rounds: [...run.rounds, { ...currentResult, roundNumber: run.rounds.length + 1 }],
        usedLevelIds,
        currentLevel: null,
        status: 'failed',
        endingPercent: run.currentTarget,
        customRunIncomplete: true,
      }, endedAt)
      return
    }

    let nextLevel
    let hydratedNextLevel
    if (run.customRunId) {
      try {
        const response = await getCustomRunLevel(run.customRunId, run.customRunIndex + 2)
        hydratedNextLevel = response.level
        setCustomRunError('')
      } catch (error) {
        setCustomRunError(t('roulette.customRunSkipRetry', { message: error?.message ?? t('roulette.nextLevelFailed') }))
        return
      }
    } else {
      nextLevel = pickNextLevel(run.levels, usedLevelIds, run.allowDuplicates)
      hydratedNextLevel = await hydrateLevelForRun(run, nextLevel)
    }
    const updatedRun = {
      ...run,
      skippedCount: (run.skippedCount || 0) + 1,
      skipReasons: countSkipReason(run.skipReasons, currentResult.skipReason),
      rounds: [
        ...run.rounds,
        {
          ...currentResult,
          roundNumber: run.rounds.length + 1,
        },
      ],
      usedLevelIds,
      currentLevel: hydratedNextLevel,
      currentLevelStartedAt: Date.now(),
      status: 'active',
      ...(run.customRunId ? { customRunIndex: run.customRunIndex + 1 } : {}),
    }

    setRun(updatedRun)
  }

  const handleGiveUp = (nextScreen = SCREEN.RESULTS) => {
    if (!run) return

    const failedRun = {
      ...run,
      status: 'failed',
      endingPercent: run.currentTarget,
      gaveUp: true,
      gaveUpAt: Date.now(),
    }
    endRun(failedRun, Date.now(), nextScreen)
  }

  /* Ends a run because a time limit ran out, rather than because the player
     chose to. The level in progress is recorded as a timed-out round so it
     shows up in the leaderboard detail like any other level, and `timeUp` tells
     the results screen to explain that nobody pressed anything.

     `overBy` is the limit that expired, since the two can both be true at once
     and the results screen only has room for one headline. */
  const endRunOnTimeLimit = useCallback((overBy) => {
    if (!run || !run.currentLevel) return

    const endedAt = Date.now()
    const timedOut = createLevelResult({
      level: run.currentLevel,
      targetPercent: run.currentTarget,
      achievedPercent: null,
      result: 'timeout',
      startedAt: run.currentLevelStartedAt ?? endedAt,
      endedAt,
    })

    const expiredRun = {
      ...run,
      status: 'failed',
      timeUp: overBy,
      rounds: [...run.rounds, { ...timedOut, roundNumber: run.rounds.length + 1 }],
      usedLevelIds: [...(run.usedLevelIds || []), run.currentLevel.id],
      endingPercent: run.currentTarget,
      currentLevel: null,
    }

    endRun(expiredRun, endedAt)
  }, [run, endRun])

  /* Watches both clocks and ends the run when either expires.

     Kept here rather than in the run screen so the rule is enforced by the
     component that owns the run, and so it still applies after a reload: a
     saved run carries its own limits, so the timer picks up where it left off.
     The check runs on an interval rather than only between rounds, so a limit
     that expires mid-level stops the run promptly. */
  useEffect(() => {
    if (screen !== SCREEN.ROULETTE || !run || run.status !== 'active' || !run.currentLevel) {
      return undefined
    }

    const levelLimitMs = Number.isFinite(run.levelTimeLimitMs) ? run.levelTimeLimitMs : 0
    const totalLimitMs = Number.isFinite(run.totalTimeLimitMs) ? run.totalTimeLimitMs : 0
    if (levelLimitMs <= 0 && totalLimitMs <= 0) return undefined

    const check = () => {
      const levelElapsed = getElapsedLevelTimeMs({ startedAt: run.currentLevelStartedAt })
      if (levelLimitMs > 0 && levelElapsed >= levelLimitMs) {
        endRunOnTimeLimit('level')
        return
      }

      const totalElapsed = getRunElapsedMs({
        rounds: run.rounds,
        currentLevelStartedAt: run.currentLevelStartedAt,
      })
      if (totalLimitMs > 0 && totalElapsed >= totalLimitMs) {
        endRunOnTimeLimit('total')
      }
    }

    check()
    const intervalId = window.setInterval(check, 500)
    return () => window.clearInterval(intervalId)
  }, [screen, run, endRunOnTimeLimit])

  const handleRestart = () => {
    setRun(null)
    trackedRunId.current = null
    if (run?.customRunId && customRunId) {
      setScreen(SCREEN.CUSTOM_RUN)
      return
    }
    const url = new URL(window.location.href)
    url.searchParams.delete('custom')
    window.history.replaceState({}, '', url)
    setCustomRunId(null)
    setScreen(SCREEN.HOME)
  }

  // Abandoning a run mid-game, as opposed to giving up on the current level.
  // Giving up ends the run, records it on the leaderboard and shows results;
  // quitting just discards it and returns to the menu, leaving no trace. That
  // distinction matters, so this deliberately does not route through endRun.
  const handleQuitRun = (destination) => {
    // A button passes its click event to its handler. Treat only known screen
    // names as explicit destinations; otherwise a normal quit would store the
    // event object as `screen` and leave only the persistent header rendered.
    const fallbackScreen = run?.customRunId && customRunId ? SCREEN.CUSTOM_RUN : SCREEN.HOME
    const nextScreen = Object.values(SCREEN).includes(destination) ? destination : fallbackScreen
    setRun(null)
    trackedRunId.current = null
    setScreen(nextScreen)
  }

  const leaveCustomRun = () => {
    const url = new URL(window.location.href)
    url.searchParams.delete('custom')
    window.history.replaceState({}, '', url)
    setCustomRunId(null)
    setScreen(SCREEN.HOME)
  }

  const openProfiles = () => {
    setProfileUsername('geometricalmike')
    if (screen === SCREEN.ROULETTE && run?.status === 'active') {
      setPendingRunNavigation(SCREEN.PROFILE)
      return
    }
    setScreen(SCREEN.PROFILE)
  }

  const openNotifications = () => {
    if (screen === SCREEN.ROULETTE && run?.status === 'active') {
      setPendingRunNavigation(SCREEN.NOTIFICATIONS)
      return
    }
    setScreen(SCREEN.NOTIFICATIONS)
  }

  useEffect(() => {
    if (!pendingRunNavigation) return undefined

    runNavigationDialogRef.current?.focus()

    const handleNavigationDialogKeyDown = (event) => {
      if (event.key === 'Escape') {
        setPendingRunNavigation(null)
      }
    }

    window.addEventListener('keydown', handleNavigationDialogKeyDown)
    return () => window.removeEventListener('keydown', handleNavigationDialogKeyDown)
  }, [pendingRunNavigation])

  /* Previewing another account.
   *
   * A moderator redeems a one-time code and is signed in as that player. Every
   * screen then shows that player's data under that player's name, which is the
   * point, and also a way to be deceived by it, so the banner is pinned over the
   * whole app and stays up until the preview is explicitly ended.
   *
   * The username is read from localStorage rather than kept in state, because a
   * reload happens -- opening a redeem code in a new tab lands here first -- and
   * the banner must not quietly disappear across one.
   *
   * Starting one has to reach three places, not one. The token in storage is the
   * account every request is made as, but the app's own copy of the player, the
   * account's runs on screen and the local history were all separate, so the
   * header said one name while the writes went to another and the board showed a
   * third thing. Redeeming a code now swaps all three at once. */
  const [previewUser, setPreviewUser] = useState(() => getPreviewUser())

  const startPreviewing = (user) => {
    // The account being replaced, passed in rather than read inside the hook, so
    // ending the preview can put it back.
    auth.startPreview(user, auth.user)
    history.beginPreview()
    setPreviewUser(user.username)
  }

  // A reload in the middle of a preview lands here with a preview marker in
  // storage and no state for any of it. The banner and the account are restored
  // from the marker and from the session the token belongs to; the board is emptied
  // and re-read as a replacement, so the previewed account's runs -- and only
  // theirs -- are what it shows. Without this, a reload left the moderator's own
  // runs under somebody else's name, which is the same bug in a worse place.
  useEffect(() => {
    if (!previewUser) return
    history.beginPreview()
  }, [previewUser]) // eslint-disable-line react-hooks/exhaustive-deps

  // The player data mirror. A signed-in player uploads their history and settings
  // so a moderator can see what the account holds; the browser stays the source
  // of truth and this is a copy, so a failure is logged and otherwise ignored.
  useEffect(() => {
    if (!auth.user) {
      return undefined
    }

    /* Not during a preview. This uploads whatever the board holds to whichever
       account is signed in, and during a preview those are two different people's
       data: it would write the moderator's own runs and settings onto the account
       being previewed. The previewed account's board is read from the server, which
       is where its runs already are, so there is nothing for the mirror to do. */
    if (history.isPreviewing) {
      return undefined
    }

    const controller = new AbortController()
    const timer = setTimeout(() => {
      syncPlayerData({
        history: history.entries,
        settings: readStoredSettings(),
      }).catch(() => {
        // A mirror that did not write is not worth interrupting anyone over.
      })
    }, 1500)

    return () => {
      clearTimeout(timer)
      controller.abort()
    }
    // Re-runs when the history or the signed-in player changes, so the mirror is
    // not left holding whatever it had at sign in.
  }, [auth.user, history.entries, history.isPreviewing])

  /* A signed-in player's leaderboard is the account's, not the device's.
   *
   * Signing in replaces what is on screen with the runs the account holds, so
   * the same account on another device shows the same board; and the server also
   * reports the keys of any runs a moderator has trashed, which are removed too.
   * Signing out empties the board, because the runs on it belong to the account
   * that ended and not to whoever signs in next on this browser.
   *
   * `nonce` is bumped by the results screen after it saves a run, so the run just
   * added to the account shows up on the board without a reload. The request
   * itself is the only thing that changes what the hook holds, and it is applied
   * from its own callback rather than from the effect body. */
  const [accountNonce, setAccountNonce] = useState(0)
  // The apply function in a ref rather than in the dependency list: the hook
  // returns a new callback object on every render, so depending on it directly
  // would re-read the account after every unrelated render.
  const applyAccountEntries = useRef(history.applyAccountEntries)
  // The preview flag read from the same place, for the same reason: the effect
  // below must not re-run every time it flips just to be told about it.
  const historyRef = useRef(history)

  useEffect(() => {
    historyRef.current = history
  }, [history])

  useEffect(() => {
    applyAccountEntries.current = history.applyAccountEntries
  }, [history.applyAccountEntries])

  /* Nothing else to hand over on sign in.

     There used to be a set-aside of runs this browser recorded that no account
     owned, handed back to whichever account they belonged to when it signed in.
     With the board no longer kept in the browser there is no such set-aside: the
     account's runs come from the server and a run played signed out stays on the
     board for the session rather than being adopted by the next account. */

  useEffect(() => {
    if (!auth.user) {
      return undefined
    }

    const controller = new AbortController()
    const read = () => {
      fetchMyEntries(controller.signal)
        .then((payload) => {
          if (controller.signal.aborted) return
          /* `replace` during a preview, and only then. Merging is right for an
             ordinary sign in -- this device may hold runs the account has not seen
             yet -- but it is exactly wrong for a preview: the moderator's own runs
             would stay on the board under somebody else's name, and an account with
             no runs would appear to have the moderator's.
             `owner` is the account this board is for, so the history can tell the
             account's runs from another account's rather than keeping both. */
          // Replace, never merge: the board is the account's runs and nothing else,
          // so an account with no runs shows an empty board rather than the runs of
          // whoever was signed in here before them.
          applyAccountEntries.current(payload)
        })
        .catch(() => {
          // A sync that did not write is not worth interrupting anybody over: the
          // board keeps whatever it had, and the next read tries again.
        })
    }

    read()

    /* Re-read on an interval, so a run trashed by a moderator disappears from the
     * player's board while they are looking at it.
     *
     * Without this, trashing is only visible on the next page load, which is not
     * the same promise: the moderation queue is judged on whether a run is off
     * the site, and "off the site as soon as they next reload" is a weaker thing
     * than it sounds to somebody waiting to check.
     *
     * Not while the tab is hidden -- re-reading a background tab costs a request
     * to find out nothing changed, and the read happens on focus anyway. The
     * interval is deliberately long for the same reason: this is a backstop for a
     * rare event, not a live feed, and a burst of requests from every open tab
     * would be a poor trade for a change made a few times a day. */
    const POLL_MS = 60_000
    let intervalId = null

    const startPolling = () => {
      if (intervalId !== null) return
      intervalId = window.setInterval(() => {
        if (document.visibilityState === 'visible') read()
      }, POLL_MS)
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible') read()
    }

    if (document.visibilityState === 'visible') {
      startPolling()
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      if (intervalId !== null) window.clearInterval(intervalId)
      document.removeEventListener('visibilitychange', onVisibility)
      controller.abort()
    }
  }, [auth.user, accountNonce])

  return (
    <div className={previewUser ? 'app-shell preview-active' : 'app-shell'}>
      <PreviewBanner
        username={previewUser}
        onEnded={() => {
          setPreviewUser(null)
          /* Ending a preview ends the preview session, not the moderator's.
           *
           * The banner already ended the session -- it owns the button, and
           * endPreviewSession is what revokes the previewed account's token and
           * puts the moderator's own token back in storage. Calling it a second
           * time here is not harmless: it revokes logout again, this time
           * against the token that was just restored, so the moderator's own
           * session dies on the server and the refresh below signs them out of an
           * account they never left. So it is called once, from one place.
           *
           * `refresh` re-reads the account from the server, which is what covers
           * a preview that survived a reload -- there was no copy of the account
           * in memory to put back. */
          history.endPreview()
          auth.endPreview()
          auth.refresh()
        }}
      />
      <header className="topbar">
        <div className="brand-wrap">
          <span className="brand-mark" aria-label="GDLR">
            <span>GD</span>
            <span>LR</span>
          </span>
          <div>
            <strong>
              {t('topbar.madeBy')}{' '}
              <a
                href="https://gdbrowser.com/u/geometricalmike"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'white', textDecoration: 'none' }}
                onMouseOver={(e) => e.target.style.textDecoration = 'underline'}
                onMouseOut={(e) => e.target.style.textDecoration = 'none'}
              >
                GeometricalMike
              </a>
            </strong>
            <small>
              {t('topbar.dedicatedTo')}{' '}
              <a
                href="https://gdbrowser.com/u/vortrox"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'white', textDecoration: 'none' }}
                onMouseOver={(e) => e.target.style.textDecoration = 'underline'}
                onMouseOut={(e) => e.target.style.textDecoration = 'none'}
              >
                Vortrox
              </a>,{' '}
              <a
                href="https://gdbrowser.com/u/kingsammelot"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'white', textDecoration: 'none' }}
                onMouseOver={(e) => e.target.style.textDecoration = 'underline'}
                onMouseOut={(e) => e.target.style.textDecoration = 'none'}
              >
                KingSammelot
              </a>, and{' '}
              <a
                href="https://gdbrowser.com/u/zoink"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: 'white', textDecoration: 'none' }}
                onMouseOver={(e) => e.target.style.textDecoration = 'underline'}
                onMouseOut={(e) => e.target.style.textDecoration = 'none'}
              >
                Zoink
              </a>.
            </small>
          </div>
        </div>

        <div className="topbar-actions">
          <a
            className="secondary-button small-button github-project-link"
            href="https://github.com/MicahThePro/gd-list-roulette"
            target="_blank"
            rel="noopener noreferrer"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="currentColor"
                d="M12 .9a11.1 11.1 0 0 0-3.51 21.63c.56.1.76-.24.76-.54v-2.08c-3.1.67-3.76-1.32-3.76-1.32-.51-1.29-1.24-1.63-1.24-1.63-1.02-.7.08-.69.08-.69 1.13.08 1.73 1.16 1.73 1.16 1 .1.76 2.14 3.53 1.52.1-.73.39-1.23.7-1.52-2.48-.28-5.09-1.24-5.09-5.52 0-1.22.44-2.22 1.16-3-.12-.29-.5-1.43.11-2.98 0 0 .95-.3 3.05 1.15a10.6 10.6 0 0 1 5.55 0c2.1-1.45 3.05-1.15 3.05-1.15.61 1.55.23 2.69.11 2.98.72.78 1.16 1.78 1.16 3 0 4.29-2.61 5.24-5.1 5.51.4.35.75 1.03.75 2.08v3.09c0 .3.2.65.77.54A11.1 11.1 0 0 0 12 .9Z"
              />
            </svg>
            {t('topbar.github')}
          </a>
          <button
            type="button"
            className="secondary-button small-button"
            onClick={openProfiles}
          >
            {t('topbar.profiles')}
          </button>
          <button
            type="button"
            className="secondary-button small-button notification-button"
            onClick={openNotifications}
            disabled={!auth.user}
          >
            <span>{t('topbar.notifications')}</span>
            {notificationCount > 0 && (
              <span className="notification-badge" aria-label={t('topbar.unreadNotifications', { count: notificationCount })}>
                {notificationCount > 99 ? '99+' : notificationCount}
              </span>
            )}
          </button>
          {screen === SCREEN.RESULTS && run && (
            <div className="status-pill">
              <span>{run.status}</span>
              <strong>{currentStatus}</strong>
            </div>
          )}
        </div>
      </header>

      {pendingRunNavigation && (
        <div
          className="modal-backdrop"
          role="presentation"
          onClick={() => setPendingRunNavigation(null)}
        >
          <div
            className="modal run-navigation-dialog"
            ref={runNavigationDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="run-navigation-title"
            tabIndex={-1}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key !== 'Tab') return
              const buttons = Array.from(
                runNavigationDialogRef.current?.querySelectorAll('button:not([disabled])') ?? [],
              )
              if (!buttons.length) return

              const first = buttons[0]
              const last = buttons[buttons.length - 1]
              if (event.shiftKey && document.activeElement === first) {
                event.preventDefault()
                last.focus()
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault()
                first.focus()
              }
            }}
          >
            <h2 id="run-navigation-title">{t('nav.endRunTitle')}</h2>
            <p>
              {t('nav.endRunBody', {
                target: pendingRunNavigation === SCREEN.PROFILE ? t('topbar.profiles') : t('topbar.notifications'),
              })}
              {auth.user ? t('nav.signedInHint') : t('nav.signedOutHint')}
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="secondary-button"
                onClick={() => setPendingRunNavigation(null)}
                autoFocus
              >
                {t('nav.keepPlaying')}
              </button>
              <button
                type="button"
                className="danger-button"
                onClick={() => {
                  const destination = pendingRunNavigation
                  setPendingRunNavigation(null)
                  handleQuitRun(destination)
                }}
              >
                {t('nav.discardAndOpen', {
                  target: pendingRunNavigation === SCREEN.PROFILE ? t('topbar.profiles') : t('topbar.notifications'),
                })}
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => {
                  const destination = pendingRunNavigation
                  setPendingRunNavigation(null)
                  handleGiveUp(auth.user ? destination : SCREEN.RESULTS)
                }}
              >
                {auth.user
                  ? t('nav.giveUpAndOpen', {
                      target: pendingRunNavigation === SCREEN.PROFILE ? t('topbar.profiles') : t('topbar.notifications'),
                    })
                  : t('nav.giveUpAndReview')}
              </button>
            </div>
          </div>
        </div>
      )}

      {screen === SCREEN.REDEEM && (
        <RedeemCodePage
          onExit={() => setScreen(SCREEN.HOME)}
          onRedeemed={(user) => {
            startPreviewing(user)
            setScreen(SCREEN.HOME)
          }}
        />
      )}
      {screen === SCREEN.HOME && (
        <HomePage
          onStart={startRun}
          onOpenCustomRun={openCustomRunUrl}
          history={history}
          run={run}
          gameRules={gameRules}
          isMasked={isMasked}
          onIsMaskedChange={setIsMasked}
          auth={auth}
          onOpenProfile={(username) => {
            setProfileUsername(username || 'geometricalmike')
            setScreen(SCREEN.PROFILE)
          }}
          onOpenNotifications={() => setScreen(SCREEN.NOTIFICATIONS)}
        />
      )}
      {screen === SCREEN.PROFILE && (
        <ProfilePage
          username={profileUsername}
          viewer={auth.user}
          relationshipVersion={socialVersion}
          onRelationshipChange={bumpSocialState}
          onOpenProfile={(username) => {
            setProfileUsername(username || 'geometricalmike')
            setScreen(SCREEN.PROFILE)
          }}
          onBack={() => setScreen(SCREEN.HOME)}
        />
      )}
      {screen === SCREEN.NOTIFICATIONS && (
        <NotificationsPage
          viewer={auth.user}
          onNotificationChange={refreshNotificationCount}
          onOpenProfile={(username) => {
            setProfileUsername(username || 'geometricalmike')
            setScreen(SCREEN.PROFILE)
          }}
          onBack={() => setScreen(SCREEN.HOME)}
        />
      )}
      {screen === SCREEN.CUSTOM_RUN && customRunId !== null && (
        <CustomRunPage
          id={customRunId}
          onStart={startCustomRun}
          onBack={leaveCustomRun}
        />
      )}
      {screen === SCREEN.ROULETTE && run && (
        <RoulettePage
          run={run}
          onSuccess={(value) => finishRound(value)}
          onSkip={handleSkip}
          onGiveUp={handleGiveUp}
          onQuit={handleQuitRun}
          customRunError={customRunError}
        />
      )}
      {screen === SCREEN.RESULTS && run && (
        <ResultsPage
          run={run}
          runKey={resultRunKey}
          onRestart={handleRestart}
          isCustomRun={Boolean(run.customRunId)}
          auth={auth}
          onAccountChanged={() => setAccountNonce((value) => value + 1)}
          onSignedOut={history.restoreLocal}
        />
      )}
    </div>
  )
}

export default App
