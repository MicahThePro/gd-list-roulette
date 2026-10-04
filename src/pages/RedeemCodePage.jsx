import { useState } from 'react'
import { redeemLoginCode } from '../services/adminService'
import { useTranslate } from '../i18n/useTranslate.js'

/* The username the panel put in the link, read once as the initial value rather
   than in an effect. It never changes afterwards -- it is what the page was opened
   with -- so there is nothing to subscribe to and nothing to re-read. */
const usernameFromLink = () => {
  if (typeof window === 'undefined') return ''
  return new URLSearchParams(window.location.search).get('username')?.trim() ?? ''
}

/**
 * Signs this browser in as a player, using a one-time code from the admin panel.
 *
 * A moderation tool, so it is a page of its own rather than something tucked
 * into a menu. It says plainly what this does, because the code is the whole
 * credential and no password is involved: a moderator who uses one is signed in
 * as that player until they sign out, and the code stops working the moment it
 * is used.
 *
 * Username plus code, rather than the code alone. It matches what the form on the
 * home screen asks for, so a moderator is typing the two things they already
 * have in front of them, and it means a code pasted into the wrong account's row
 * is refused instead of quietly signing in as somebody else.
 *
 * The username arrives in the link as ?username=, because the panel built that
 * link on the account it had open and already had the exact string -- whereas the
 * person using the page has to read it off a screen and type it, and 1, l and I
 * are the same glyph in most fonts at small sizes. The check stays the guard it
 * is, but a name that arrives already correct is a name that cannot be misread.
 * A hand-typed name still works, and a copy button is offered so the panel's own
 * text can be pasted rather than read.
 */
export default function RedeemCodePage({ onExit, onRedeemed }) {
  const { t } = useTranslate()
  const [username, setUsername] = useState(usernameFromLink)
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [isWorking, setIsWorking] = useState(false)
  const [hasCopied, setHasCopied] = useState(false)

  const handleCopyUsername = async () => {
    try {
      await navigator.clipboard?.writeText(username.trim())
      setHasCopied(true)
    } catch {
      setError(t('redeem.copyFailed'))
    }
  }

  const canSubmit = username.trim().length >= 3 && code.trim().length > 0 && !isWorking

  const handleSubmit = async (event) => {
    event.preventDefault()
    if (!canSubmit) {
      return
    }

    setIsWorking(true)
    setError('')
    try {
      const user = await redeemLoginCode({ username: username.trim(), code })
      onRedeemed?.(user)
    } catch (caught) {
      setError(caught?.message ?? t('redeem.codeFailed'))
    } finally {
      setIsWorking(false)
    }
  }

  return (
    <main className="page-shell admin-page">
      <section className="panel admin-gate">
        <p className="eyebrow">{t('redeem.eyebrow')}</p>
        <h2>{t('redeem.title')}</h2>
        <form onSubmit={handleSubmit}>
          <p className="settings-hint">
            {t('redeem.hint')}
          </p>

          <label className="admin-note">
            {t('redeem.username')}
            <input
              type="text"
              value={username}
              onChange={(event) => {
                setUsername(event.target.value)
                setHasCopied(false)
                setError('')
              }}
              placeholder={t('redeem.usernamePlaceholder')}
              autoComplete="off"
              spellCheck="false"
            />
          </label>

          {username.trim().length >= 3 && (
            <div className="action-row">
              <button type="button" className="secondary-button" onClick={handleCopyUsername}>
                {hasCopied ? t('redeem.copied') : t('redeem.copyUsername')}
              </button>
              <span className="settings-hint">
                {t('redeem.copyHint')}
              </span>
            </div>
          )}

          <label className="admin-note">
            {t('redeem.loginCode')}
            <input
              type="text"
              value={code}
              onChange={(event) => {
                // Uppercased as it is typed, so the alphabet stays unambiguous
                // and a lower-case paste cannot be rejected for being lower case.
                setCode(event.target.value.toUpperCase())
                setError('')
              }}
              placeholder="ABCDE FGHJ KLMNP"
              autoFocus
              autoComplete="off"
              spellCheck="false"
            />
          </label>

          {error && <div className="validation-message">{error}</div>}

          <div className="action-row">
            <button type="submit" className="primary-button" disabled={!canSubmit}>
              {isWorking ? t('redeem.signingIn') : t('redeem.signInAs')}
            </button>
            <button type="button" className="secondary-button" onClick={onExit}>
              {t('common.cancel')}
            </button>
          </div>
        </form>
      </section>
    </main>
  )
}
