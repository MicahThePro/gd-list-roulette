import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../i18n/useTranslate.js'

/**
 * The percentage-step setting, shown in a dialog like the What's new and quit
 * run popups rather than as an inline panel in the form.
 *
 * The draft is free to be empty so the field can be cleared while typing; the
 * real value only commits on blur, falling back to the minimum.
 *
 * There is no Cancel or Done button on purpose. Both would do exactly what
 * Close already does, and a Cancel that silently saves the change would be
 * actively misleading. The value commits as soon as the field loses focus, so
 * closing the dialog by any route keeps whatever was typed.
 */
export default function SettingsDialog({
  isOpen,
  onClose,
  percentStep,
  percentStepDraft,
  onDraftChange,
  onCommit,
  estimatedRounds,
  allowSkip,
  onAllowSkipChange,
  levelTimeLimitDraft,
  onLevelTimeLimitDraftChange,
  onCommitLevelTimeLimit,
  totalTimeLimitDraft,
  onTotalTimeLimitDraftChange,
  onCommitTotalTimeLimit,
  isMasked,
  onIsMaskedChange,
}) {
  const { t } = useTranslate()
  const closeRef = useRef(null)
  const dialogRef = useRef(null)
  // The dialog is the same component across opens, so a ref carries whether the
  // user has already dismissed the "what's new" hint for this visit. It is not
  // worth being told twice, but it is worth being told at least once.
  const [hasSeenHint, setHasSeenHint] = useState(false)

  useEffect(() => {
    if (!isOpen) return undefined

    // Escape commits and closes. Every control commits on the way out, not just
    // the percentage step, so closing the dialog never silently discards a time
    // limit that was typed but not yet blurred.
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        onCommit()
        onCommitLevelTimeLimit()
        onCommitTotalTimeLimit()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)

    /* Focus the dialog itself, not one of its fields.
     *
     * It used to focus the percentage field, which put the caret in a box nobody
     * had asked to edit -- so opening Settings to change one thing meant the first
     * thing typed went into a field two rows above it.
     *
     * It also made this the wrong place to focus from. The effect depends on
     * `onCommit`, which is a new function on every render of the page above, so a
     * commit from *any* field re-ran the effect and pulled focus back to the
     * percentage box. That is the second half of what was reported: clicking out of
     * a text box threw the caret into it. Blurring is the only moment a commit
     * happens, which is why it looked like blur was the trigger when it was only
     * the occasion for a re-render.
     *
     * The dialog takes focus instead, with tabIndex -1 so it can. It accepts no
     * keystrokes, so nothing is typed into it by accident, and Tab still lands on the
     * first real control. Its focus ring is suppressed in CSS -- an outline round the
     * whole dialog reads as a selection the player did not make.
     *
     * Only on open. The effect re-runs on every commit, and re-focusing on each of
     * those is the bug being fixed. */
    dialogRef.current?.focus()

    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose, onCommit, onCommitLevelTimeLimit, onCommitTotalTimeLimit])

  // Roving focus inside the dialog: Tab and Shift+Tab cycle the input and the
  // close button instead of escaping to the page behind. Native dialogs trap
  // focus; a div with role="dialog" does not, so this has to be done by hand.
  const handleKeyDownForFocus = (event) => {
    if (event.key !== 'Tab') return

    // Collected from the live DOM rather than a hand-kept list of refs, so a
    // control added later is trapped automatically instead of needing to be
    // remembered in two places. Only genuinely focusable, visible controls
    // count, which is why disabled and hidden elements are filtered out.
    const focusables = Array.from(
      dialogRef.current?.querySelectorAll(
        'input:not([type="checkbox"]), button:not([disabled])',
      ) ?? [],
    )
    if (!focusables.length) return

    const first = focusables[0]
    const last = focusables[focusables.length - 1]

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  if (!isOpen) return null

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        ref={dialogRef}
        className="modal settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        /* tabIndex -1 so the container can hold focus, which is what keeps Tab inside the
           dialog now that no field is focused for it. */
        tabIndex={-1}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDownForFocus}
      >
        <div className="changelog-head">
          <div>
            <p className="eyebrow">{t('settings.eyebrow')}</p>
            <h2 id="settings-title">{t('settings.title')}</h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="secondary-button changelog-close"
            onClick={() => {
              setHasSeenHint(true)
              onCommit()
              onClose()
            }}
          >
            {t('common.close')}
          </button>
        </div>

        <div className="settings-dialog-body">
          <section className="settings-section">
            <label className="settings-field">
              {t('settings.percentIncrement')}
              <input
                type="text"
                inputMode="numeric"
                value={percentStepDraft}
                onChange={(event) => onDraftChange(event.target.value.replace(/[^0-9]/g, ''))}
                onBlur={() => {
                  setHasSeenHint(true)
                  onCommit()
                }}
                placeholder="1"
                aria-describedby="settings-step-hint"
              />
            </label>

            <p className="settings-hint" id="settings-step-hint">
              {t('settings.stepHint', {
                step: percentStep,
                rounds: estimatedRounds,
                levels: estimatedRounds === 1 ? t('settings.stepHintLevel') : t('settings.stepHintLevels'),
              })}
            </p>

            {!hasSeenHint && (
              <p className="settings-note">
                {t('settings.savedOnBlur')}
              </p>
            )}
          </section>

          <section className="settings-section">
            <label className="settings-toggle-row">
              <input
                type="checkbox"
                checked={allowSkip}
                onChange={(event) => onAllowSkipChange(event.target.checked)}
              />
              <span>
                <strong>{t('settings.allowSkipping')}</strong>
                <small>{t('settings.allowSkippingNote')}</small>
              </span>
            </label>
          </section>

          <section className="settings-section">
            <label className="settings-field">
              {t('settings.levelLimit')}
              <input
                type="text"
                inputMode="numeric"
                value={levelTimeLimitDraft}
                onChange={(event) => onLevelTimeLimitDraftChange(event.target.value.replace(/[^0-9]/g, ''))}
                onBlur={onCommitLevelTimeLimit}
                placeholder="0"
                aria-describedby="settings-level-limit-hint"
              />
            </label>

            <p className="settings-hint" id="settings-level-limit-hint">
              {levelTimeLimitDraft === '' || Number(levelTimeLimitDraft) === 0
                ? t('settings.levelLimitOff')
                : t('settings.levelLimitOn')}
            </p>
          </section>

          <section className="settings-section">
            <label className="settings-field">
              {t('settings.totalLimit')}
              <input
                type="text"
                inputMode="numeric"
                value={totalTimeLimitDraft}
                onChange={(event) => onTotalTimeLimitDraftChange(event.target.value.replace(/[^0-9]/g, ''))}
                onBlur={onCommitTotalTimeLimit}
                placeholder="0"
                aria-describedby="settings-total-limit-hint"
              />
            </label>

            <p className="settings-hint" id="settings-total-limit-hint">
              {totalTimeLimitDraft === '' || Number(totalTimeLimitDraft) === 0
                ? t('settings.totalLimitOff')
                : t('settings.totalLimitOn')}
            </p>
          </section>

          {/* The mask, and the only setting here that changes what a player reads rather
              than how a run behaves.

              Kept to one line each on purpose. A warning that runs to a paragraph
              stops being read as a warning and starts being furniture, and the
              point here is only ever "these names can contain swearing" -- which
              fits in a sentence, and which stays visible rather than needing a
              confirm the player can dismiss and forget. */}
          <section className="settings-section">
            <label className="settings-toggle-row">
              <input
                type="checkbox"
                checked={!isMasked}
                onChange={(event) => onIsMaskedChange(!event.target.checked)}
              />
              <span>
                <strong>{t('settings.showUncensored')}</strong>
                <small>{t('settings.showUncensoredNote')}</small>
              </span>
            </label>

            {!isMasked && (
              <p className="settings-censor-warning">
                {t('settings.censorWarning')}
              </p>
            )}
          </section>

          <p className="settings-note settings-note-footer">
            {t('settings.footer')}
          </p>
        </div>
      </div>
    </div>
  )
}
