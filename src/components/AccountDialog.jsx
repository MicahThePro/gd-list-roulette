import { useState } from 'react'
import { formatCooldown, useCooldownRemaining } from '../hooks/useCooldownRemaining'
import { useTranslate } from '../i18n/useTranslate.js'

const MIN_PASSWORD_LENGTH = 8
/* Matches the Worker's MAX_DISPLAY_NAME. Capping here as well is a courtesy
 * that keeps the counter honest -- without it the field would happily take more
 * characters than the server will keep, and the last few would be silently
 * dropped on save. The server cap remains the rule. */
const MAX_DISPLAY_NAME = 40

/**
 * Sign in, sign up and account summary, in one dialog.
 *
 * Deliberately one dialog with two modes rather than two dialogs: switching
 * between them is the common path, and reopening the dialog to do it would be
 * an extra click for no gain. The form is a plain form so Enter submits and the
 * browser handles the field types.
 *
 * The fields are cleared when the dialog closes rather than in an effect on
 * open, so closing and reopening does not run a render-then-update cycle, and a
 * stale error from a failed attempt never greets the next attempt.
 *
 * `pendingRun` and `onAuthenticated` are how the results screen uses it: the
 * player signs in while holding a run they just finished, and that run goes on
 * the account they just made or signed in to. There is no question to answer,
 * because there is no decision to make -- they came here from a run, and the
 * account is what keeps runs. Asking, and unticking the box, was how runs ended
 * up only on the device: the run was on screen, the account was right there, and
 * the player had to know they had to ask for the thing they were already looking
 * at. `pendingRun` therefore travels with the callback rather than with a
 * checkbox.
 */
export default function AccountDialog({ isOpen, onClose, auth, pendingRun = null, onAuthenticated, onSignedOut }) {
  const { t } = useTranslate()
  const { user, isRestoring, isBusy, error, setError, signIn, signUp, signOut, changeDisplayName } = auth
  const [mode, setMode] = useState('signin')
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  /* Whether the display name is being edited, and what has been typed into it.
     Separate from `displayName`, which belongs to the sign-up form: the two are
     different fields that happen to share a name, and reusing one state value
     between them meant opening the account panel showed whatever was last typed
     into the sign-up form. */
  const [isEditingName, setIsEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState('')

  /* The once-a-day limit, counting down live.
     *
     * The user's own account is the input: a moderator previewing somebody else's
     * account sees that account's cooldown, because that is the name they would
     * be changing. */
  const { remainingMs, isLocked } = useCooldownRemaining(user?.displayNameChangedAt)

  /* Whether a run in hand goes on the account. Not a choice the player makes here
     -- they came from a run, so it is kept -- but read as a constant rather than
     inlined, so the one place that decides is the one place that says so. */
  const attachRun = Boolean(pendingRun)

  /* Leaves edit mode for a different account.
     *
     * A dialog can be reopened by a different player on the same device, and a
     * half-typed name left over from the previous account would then be offered
     * to somebody else as their own.
     *
     * Done as part of the state the dialog already keeps -- see handleClose, which
     * clears it -- rather than as an effect watching the account. An effect here
     * would both be the extra render React warns about and run on the account
     * changing underneath a dialog that is still open, cancelling a half-typed
     * name mid-sentence because something unrelated re-read the account. */

  const handleClose = () => {
    setPassword('')
    setError('')
    // Cleared here rather than in an effect on open, for the same reason the
    // password is: closing is the one moment the dialog knows it is going away.
    // An effect would leave a half-typed display name sitting in the state of a
    // dialog that is not on screen, so reopening -- or, on a shared browser,
    // letting the next player open it -- would offer them somebody else's
    // unsaved name as their own starting point.
    setIsEditingName(false)
    setNameDraft('')
    onClose()
  }
  if (!isOpen) {
    return null
  }

  const isSignUp = mode === 'signup'
  const canSubmit =
    username.trim().length >= 3 &&
    password.length >= MIN_PASSWORD_LENGTH &&
    !isBusy

  /* Whether the name being typed is worth sending.
     *
     * An unchanged name is not a change, so saving it would spend the player's one
     * daily edit on writing back the same text. The server would allow that --
     * it cannot tell the difference either, since the two values are equal -- so
     * the check is made here rather than by rejecting an identical name at the
     * other end. Whitespace is compared trimmed for the same reason. */
  const trimmedDraft = nameDraft.trim()
  const nameIsChanged = trimmedDraft.length > 0 && trimmedDraft !== (user?.displayName ?? '')
  const canSaveName = nameIsChanged && !isLocked && !isBusy

  /* Signing out also puts this device's own runs back on the board. Without that
   * the account's runs stay on screen after the account has ended, which on a
   * shared browser is the next person's problem. */
  const handleSignOut = async () => {
    await signOut()
    onSignedOut?.()
    handleClose()
  }

  const handleSubmit = async (event) => {    event.preventDefault()
    if (!canSubmit) {
      return
    }

    const result = isSignUp
      ? await signUp({ username: username.trim(), password, displayName: displayName.trim() })
      : await signIn({ username: username.trim(), password })

    if (result.ok) {
      // The attachment happens after the session exists, because saving the run
      // is a call made as the signed-in player. Doing it here rather than in the
      // caller's own submit handler is what makes every entry point -- the home
      // screen and the results screen -- behave the same way.
      onAuthenticated?.(result.user, { attachRun, run: pendingRun })
      handleClose()
    }
  }

  /* Saving the new display name.
     *
     * The dialog closes only when the server agreed. Leaving it open on a failure
     * keeps the typed name in the field so it can be corrected, and keeps the
     * edit visible rather than reverting silently. The draft is seeded from the
     * account's current name on open, so cancelling and reopening starts from
     * what is really stored. */
  const handleSaveName = async (event) => {
    event.preventDefault()
    if (!canSaveName) {
      return
    }

    const result = await changeDisplayName(trimmedDraft)
    if (result.ok) {
      setIsEditingName(false)
      setNameDraft('')
    }
  }

  const handleStartEditingName = () => {
    setNameDraft(user?.displayName ?? '')
    setIsEditingName(true)
    setError('')
  }

  const handleCancelName = () => {
    setIsEditingName(false)
    setNameDraft('')
    setError('')
  }

  return (
    <div className="modal-backdrop" role="presentation" onClick={handleClose}>
      <div
        className="modal account-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t('account.yourAccount')}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modal-actions">
          <h2>{user ? t('account.yourAccount') : isSignUp ? t('account.createAccount') : t('account.signIn')}</h2>
          <button type="button" className="secondary-button small-button" onClick={handleClose}>
            {t('common.close')}
          </button>
        </div>

        {isRestoring && !user && <p className="settings-note">{t('account.checking')}</p>}

        {user ? (
          <div className="account-panel">
            <p className="account-name">{user.displayName}</p>
            <p className="account-handle">@{user.username}</p>
            <p className="settings-note">
              {t('account.signedInAs', { username: user.username })}
            </p>

            {/* The display name editor.
                Live countdown, and the button greys out while the daily limit is
                running. The countdown sits exactly where the edit control is, so
                the thing that is unavailable and the reason it is unavailable are
                the same object on screen -- rather than a note elsewhere that the
                reader has to connect back to this field. */}
            {isEditingName ? (
              <form className="account-name-form" onSubmit={handleSaveName}>
                <label>
                  {t('account.displayName')}
                  <input
                    type="text"
                    value={nameDraft}
                    autoComplete="nickname"
                    maxLength={MAX_DISPLAY_NAME}
                    /* Disabled while the limit runs rather than merely refusing on
                       submit, so the field cannot be typed into at all during the
                       wait. The server refuses it either way. */
                    disabled={isLocked || isBusy}
                    onChange={(event) => setNameDraft(event.target.value)}
                    placeholder={t('account.displayNamePlaceholder')}
                  />
                </label>

                {isLocked && (
                  <p className="settings-note account-cooldown">
                    {t('account.cooldownIn', { time: formatCooldown(remainingMs) })}
                  </p>
                )}

                {!isLocked && (
                  <p className="settings-note">
                    {t('account.nameDailyNote', { username: user.username })}
                  </p>
                )}

                {error && <div className="validation-message">{error}</div>}

                <div className="modal-actions">
                  <button type="submit" className="primary-button" disabled={!canSaveName}>
                    {isBusy ? t('results.saving') : t('account.saveDisplayName')}
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={handleCancelName}
                    disabled={isBusy}
                  >
                    {t('common.cancel')}
                  </button>
                </div>
              </form>
            ) : (
              <div className="account-name-actions">
                <button
                  type="button"
                  className="secondary-button small-button"
                  onClick={handleStartEditingName}
                  /* Greyed out for the whole wait, and not merely inert: the
                     countdown is rendered in place of the control so the reader
                     can see when it comes back rather than having to try. */
                  disabled={isLocked}
                >
                  {t('account.changeDisplayName')}
                </button>
                {isLocked && (
                  <span className="account-cooldown-timer">
                    {t('account.availableAgainIn', { time: formatCooldown(remainingMs) })}
                  </span>
                )}
              </div>
            )}

            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={handleSignOut}>
                {t('account.signOut')}
              </button>
            </div>
          </div>
        ) : (
          <form className="account-form" onSubmit={handleSubmit}>
            <label>
              {t('account.username')}
              <input
                type="text"
                value={username}
                autoComplete="username"
                maxLength={20}
                onChange={(event) => {
                  setUsername(event.target.value)
                  setError('')
                }}
                placeholder={t('account.usernamePlaceholder')}
              />
            </label>

            {isSignUp && (
              /* The two names are different things with different rules, and both rules
                 are invisible until they surprise you -- so both are said here, before
                 anything is typed.
                 The username is an identity: folded to lower case, so it is one handle
                 with one spelling, and nobody else can take it in any case. The display
                 name is a label: kept exactly as typed, and two players are allowed to
                 have the same one. Which of the two a player is looking at is the whole
                 difference between the two sentences. */
              <p className="settings-note">
                {t('account.usernameNote')}
              </p>
            )}

            {isSignUp && (
              <label>
                {t('account.displayName')}
                <input
                  type="text"
                  value={displayName}
                  autoComplete="nickname"
                  maxLength={40}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder={t('account.displayNamePlaceholderLong')}
                />
              </label>
            )}

            <label>
              {t('account.password')}
              <input
                type="password"
                value={password}
                autoComplete={isSignUp ? 'new-password' : 'current-password'}
                maxLength={200}
                onChange={(event) => {
                  setPassword(event.target.value)
                  setError('')
                }}
                placeholder={isSignUp ? t('account.passwordPlaceholder', { count: MIN_PASSWORD_LENGTH }) : ''}
              />
            </label>

            {isSignUp && (
              <p className="settings-hint">
                {t('account.passwordHint')}
              </p>
            )}

            {pendingRun && (
              /* Says what is about to happen rather than asking about it. The run
                 they just finished is the reason this dialog is open, so it goes on
                 the account being signed in to -- the wording makes that plain
                 before they type their password, not after. */
              <p className="settings-hint">
                {t('account.runSavedTo', {
                  username: username.trim() || t('results.yourAccountFallback'),
                })}
              </p>
            )}

            {error && <div className="validation-message">{error}</div>}

            <div className="modal-actions">
              <button type="submit" className="primary-button" disabled={!canSubmit}>
                {isBusy ? t('account.working') : isSignUp ? t('account.createAccount') : t('account.signIn')}
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setMode(isSignUp ? 'signin' : 'signup')
                  setError('')
                }}
              >
                {isSignUp ? t('account.alreadyHave') : t('account.createAccount')}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
