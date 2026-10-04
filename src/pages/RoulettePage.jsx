import { useEffect, useRef, useState } from 'react'
import { formatDurationMs, getRunElapsedMs, getSkipReasonLabel, SKIP_REASONS } from '../utils/roulette'
import { censorText } from '../utils/censor'
import { useTranslate } from '../i18n/useTranslate.js'

export default function RoulettePage({ run, onSuccess, onSkip, onGiveUp, onQuit, customRunError = '' }) {
  const { t } = useTranslate()
  const [achievedPercent, setAchievedPercent] = useState('')
  const [validationMessage, setValidationMessage] = useState('')
  const [levelCopyMessage, setLevelCopyMessage] = useState('')
  const [isConfirmingQuit, setIsConfirmingQuit] = useState(false)
  const [isSkipPickerOpen, setIsSkipPickerOpen] = useState(false)

  useEffect(() => {
    setAchievedPercent('')
    setValidationMessage('')
    setIsSkipPickerOpen(false)
  }, [run.currentTarget, run.currentLevel?.id])

  // The recording prompt is shown in a dialog, and Escape closes it the same
  // way it closes the skip picker. Only the newest dialog responds, so the
  // picker takes priority while it is the later one opened.
  // Escape backs out of the skip picker the same way it backs out of the quit
  // dialog, and the picker takes priority since it is the later one opened.
  useEffect(() => {
    if (!isSkipPickerOpen) return undefined

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setIsSkipPickerOpen(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isSkipPickerOpen])

  // A skip has to actually skip. Opening the picker and then leaving the page
  // with it still up would strand the run, so the reason is chosen and
  // immediately applied rather than picked and confirmed separately.
  // Guarded on canSkip as well as the button being hidden, so a picker left
  // open across a settings change cannot smuggle a skip through.
  const chooseSkipReason = (reasonId) => {
    setIsSkipPickerOpen(false)
    if (!canSkip) return
    onSkip(reasonId)
  }

  // Escape cancels, as it should for a dialog. The listener only exists while
  // the dialog is open, and the page's own key handler is left alone because
  // this is a cancel action rather than a gameplay input.
  useEffect(() => {
    if (!isConfirmingQuit) return undefined

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setIsConfirmingQuit(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isConfirmingQuit])

  useEffect(() => {
    if (!levelCopyMessage) return undefined

    const timeoutId = window.setTimeout(() => {
      setLevelCopyMessage('')
    }, 1200)

    return () => window.clearTimeout(timeoutId)
  }, [levelCopyMessage])

  // Defaults to allowed: a run started before the setting existed simply skips
  // as it always did.
  const canSkip = run?.allowSkip !== false
  const levelLimitMs = Number.isFinite(run?.levelTimeLimitMs) ? run.levelTimeLimitMs : 0
  const totalLimitMs = Number.isFinite(run?.totalTimeLimitMs) ? run.totalTimeLimitMs : 0

  const [displayElapsed, setDisplayElapsed] = useState(0)

  useEffect(() => {
    if (!run || !run.currentLevel) return undefined

    const startedAt = run.currentLevelStartedAt ?? Date.now()
    const tick = () => {
      setDisplayElapsed(Date.now() - startedAt)
    }

    tick()
    const intervalId = window.setInterval(tick, 250)

    return () => window.clearInterval(intervalId)
  }, [run.currentLevel?.id, run.currentLevelStartedAt])

  // Both countdowns are driven by the same tick as the level clock, so the three
  // numbers on screen can never disagree by a frame.
  const [limitsNow, setLimitsNow] = useState(() => Date.now())

  useEffect(() => {
    if (levelLimitMs <= 0 && totalLimitMs <= 0) return undefined

    const tick = () => setLimitsNow(Date.now())
    const intervalId = window.setInterval(tick, 250)
    return () => window.clearInterval(intervalId)
  }, [levelLimitMs, totalLimitMs, run.currentLevel?.id, run.rounds.length])

  const challengeEntries = (run?.rounds ?? []).map((round, index) => ({
    id: `${round.level?.id ?? 'round'}-${index}`,
    name: round.level?.name ?? t('roulette.unknownLevel'),
    creator: round.level?.creator ?? t('roulette.unknownCreator'),
    thumbnail: round.level?.thumbnail ?? null,
    target: round.targetPercent ?? run?.currentTarget,
    result: round.result,
    skipReason: round.skipReason,
    achieved: round.achievedPercent,
    elapsedLabel: round.elapsedLabel ?? (Number.isFinite(round.elapsedMs) ? formatDurationMs(round.elapsedMs) : null),
    isCurrent: false,
  }))

  const challengeListRef = useRef(null)

  useEffect(() => {
    if (!challengeListRef.current) return
    challengeListRef.current.scrollTop = challengeListRef.current.scrollHeight
  }, [challengeEntries.length])

  if (!run || !run.currentLevel) {
    return null
  }

  const handleInputChange = (value) => {
    const sanitized = value.replace(/%/g, '')

    if (sanitized === '') {
      setAchievedPercent('')
      setValidationMessage(t('roulette.enterNothing', { target: run.currentTarget }))
      return
    }

    const numeric = Number(sanitized)
    if (!Number.isFinite(numeric)) {
      setAchievedPercent('')
      setValidationMessage(t('roulette.enterBelow', { target: run.currentTarget }))
      return
    }

    if (numeric < run.currentTarget) {
      setAchievedPercent(String(numeric))
      setValidationMessage(t('roulette.enterLess', { target: run.currentTarget }))
      return
    }

    const clamped = Math.min(100, numeric)
    setAchievedPercent(String(clamped))
    setValidationMessage('')
  }

  return (
    <main className="page-shell roulette-page">
      <div className="roulette-layout">
        <section className="panel status-panel">
          {customRunError && <p className="validation-message" role="alert">{customRunError}</p>}
          {!run.customRunId && (
            <aside className="recording-reminder" aria-label={t('roulette.recordingAdviceLabel')}>
              <strong>{t('roulette.recordingTitle')}</strong>
              <span>{t('roulette.recordingBody')}</span>
            </aside>
          )}
          <div className="status-header">
            <div>
              <p className="eyebrow">{t('roulette.round', { number: run.rounds.length + 1 })}</p>
              <h2>{t('roulette.target', { target: run.currentTarget })}</h2>
            </div>
            <div className="status-actions">
              <span className="badge">{censorText(run.source)}</span>
            </div>
          </div>

          <div className="level-card">
            {run.currentLevel.thumbnail && (
              <a
                className="level-thumbnail-link"
                href={run.currentLevel.permalink || run.currentLevel.detailUrl}
                target="_blank"
                rel="noreferrer"
              >
                <img
                  className="level-thumbnail"
                  src={run.currentLevel.thumbnail}
                  alt={t('roulette.thumbnailAlt', { name: censorText(run.currentLevel.name) })}
                  loading="lazy"
                />
              </a>
            )}

            <p className="level-meta">{t('roulette.onTheList', { position: run.currentLevel.position })}</p>
            {/* The required rate and game version come from the Impossible
                Levels site. Either can be absent, so each is rendered only
                when present, and the row disappears entirely when neither is. */}
            {(run.currentLevel.rate || run.currentLevel.version) && (
              <div className="level-badges">
                {run.currentLevel.rate && (
                  <span
                    className={`level-rate level-rate-${run.currentLevel.rate.endsWith('TPS') ? 'tps' : 'fps'}`}
                  >
                    {run.currentLevel.rate}
                  </span>
                )}
                {run.currentLevel.version && (
                  <span className="level-version">v{run.currentLevel.version}</span>
                )}
              </div>
            )}
            <h3>{censorText(run.currentLevel.name)}</h3>
            <p>{run.currentLevel.creator ? t('roulette.by', { creator: run.currentLevel.creator }) : t('roulette.communityPick')}</p>
            <div className="timer-badge">{t('roulette.time', { time: formatDurationMs(displayElapsed) })}</div>
            {/* Only the clock that is actually running is shown. The level
                countdown turns red in the last 30 seconds so the end of a run
                is visible before it happens rather than announced. */}
            {levelLimitMs > 0 && (
              <div className={`timer-badge timer-countdown${displayElapsed >= levelLimitMs - 30000 ? ' timer-countdown-urgent' : ''}`}>
                {t('roulette.levelTimeLeft', { time: formatDurationMs(Math.max(0, levelLimitMs - displayElapsed)) })}
              </div>
            )}
            {totalLimitMs > 0 && (() => {
              const totalUsed = getRunElapsedMs({
                rounds: run.rounds,
                currentLevelStartedAt: run.currentLevelStartedAt,
                now: limitsNow,
              })
              const totalLeft = Math.max(0, totalLimitMs - totalUsed)
              return (
                <div className={`timer-badge timer-countdown${totalLeft <= 30000 ? ' timer-countdown-urgent' : ''}`}>
                  {t('roulette.runTimeLeft', { time: formatDurationMs(totalLeft) })}
                </div>
              )
            })()}
            {run.currentLevel.levelId != null ? (
              <button
                className="level-id-link level-id-button"
                type="button"
                onClick={() => {
                  navigator.clipboard?.writeText(String(run.currentLevel.levelId))
                  setLevelCopyMessage(t('roulette.copied'))
                }}
              >
                {t('roulette.levelId', { id: run.currentLevel.levelId })}
              </button>
            ) : (
              <a
                className="level-id-link level-id-button"
                href={run.currentLevel.detailUrl || run.currentLevel.permalink}
                target="_blank"
                rel="noreferrer"
              >
                {t('roulette.viewOnChallengeList')}
              </a>
            )}
            {levelCopyMessage && <div className="copy-toast">{levelCopyMessage}</div>}
          </div>

          <div className="result-form">
            <label>
              {t('roulette.achieved')}
              <input
                type="number"
                min={run.currentTarget}
                max="100"
                value={achievedPercent}
                placeholder={`${run.currentTarget}%`}
                onChange={(event) => handleInputChange(event.target.value)}
              />
            </label>
            {validationMessage && <div className="validation-message">{validationMessage}</div>}
          </div>

          <div className="action-row">
            <button
              className="primary-button"
              type="button"
              onClick={() => {
                const numericValue = achievedPercent === '' ? run.currentTarget : Number(achievedPercent)
                onSuccess(numericValue)
              }}
              disabled={achievedPercent === '' || Number(achievedPercent) < run.currentTarget}
            >
              {t('roulette.success')}
            </button>
            {canSkip && (
              <button
                className="secondary-button"
                type="button"
                aria-haspopup="dialog"
                aria-expanded={isSkipPickerOpen}
                onClick={() => setIsSkipPickerOpen((open) => !open)}
              >
                {t('roulette.skip')}
              </button>
            )}
            <button className="secondary-button" type="button" onClick={onGiveUp}>
              {t('roulette.giveUp')}
            </button>
            {/* Quitting discards the run entirely, unlike Give up which ends
                it and records it. A single click only opens the confirm
                dialog, because it is the one action here that cannot be undone. */}
            <button
              className="secondary-button"
              type="button"
              onClick={() => setIsConfirmingQuit(true)}
            >
              {t('roulette.quitRun')}
            </button>
          </div>

        </section>

        <aside className="panel challenge-panel">
          <div className="challenge-header">
            <p className="eyebrow">{t('roulette.challengeBoard')}</p>
            <h3>{t('roulette.levelsHeading')}</h3>
          </div>

          <div className="challenge-list" ref={challengeListRef}>
            {challengeEntries.map((entry) => (
              <div key={entry.id} className="challenge-item">
                {/* The thumbnail cell is always rendered, even with no image to
                    put in it. Omitting it would pull the level name into the
                    thumbnail's grid column and squeeze the text. */}
                {entry.thumbnail ? (
                  <img src={entry.thumbnail} alt={t('roulette.thumbnailAlt', { name: censorText(entry.name) })} className="challenge-thumb" loading="lazy" />
                ) : (
                  <span className="challenge-thumb challenge-thumb-empty" aria-hidden="true" />
                )}
                <div className="challenge-copy">
                  <strong>{censorText(entry.name)}</strong>
                  <span>{entry.creator}</span>
                  <small>
                    {entry.result === 'skipped'
                      ? t('roulette.skippedLine', {
                          reason: entry.skipReason ? t('roulette.skipReasonSeparator') + getSkipReasonLabel(entry.skipReason) : '',
                          target: entry.target,
                        })
                      : t('roulette.targetLine', { target: entry.target })}
                    {entry.achieved !== null && entry.achieved !== undefined ? ` • ${entry.achieved}%` : ''}
                    {entry.elapsedLabel ? ` • ${entry.elapsedLabel}` : ''}
                  </small>
                </div>
              </div>
            ))}
          </div>
        </aside>
      </div>

      {isSkipPickerOpen && canSkip && (
        <div
          className="modal-backdrop"
          onClick={() => setIsSkipPickerOpen(false)}
          role="presentation"
        >
          <div
            className="modal skip-picker"
            role="dialog"
            aria-modal="true"
            aria-labelledby="skip-dialog-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="skip-dialog-title">{t('roulette.skipDialogTitle')}</h2>
            <p>{t('roulette.skipDialogBody')}</p>
            <div className="skip-reason-list">
              {SKIP_REASONS.map((reason) => (
                <button
                  key={reason.id}
                  type="button"
                  className="skip-reason-button"
                  onClick={() => chooseSkipReason(reason.id)}
                >
                  {reason.label}
                </button>
              ))}
            </div>
            <div className="modal-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={() => chooseSkipReason(null)}
                autoFocus
              >
                {t('roulette.skipWithoutReason')}
              </button>
              <button
                className="secondary-button"
                type="button"
                onClick={() => setIsSkipPickerOpen(false)}
              >
                {t('common.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      {isConfirmingQuit && (
        <div
          className="modal-backdrop"
          onClick={() => setIsConfirmingQuit(false)}
          role="presentation"
        >
          {/* role="dialog" with aria-modal marks this as a real dialog for
              assistive tech, and the click on the inner box is stopped so
              clicking inside it does not dismiss. */}
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="quit-dialog-title"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="quit-dialog-title">{t('roulette.quitDialogTitle')}</h2>
            <p>{t('roulette.quitDialogBody')}</p>
            <div className="modal-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={() => setIsConfirmingQuit(false)}
                autoFocus
              >
                {t('roulette.noKeepPlaying')}
              </button>
              <button
                className="danger-button"
                type="button"
                onClick={() => onQuit()}
              >
                {t('roulette.yesQuitRun')}
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
