/**
 * The device ban notice, shown in place of the app.
 *
 * The Worker permanently bans an address after the admin passcode ladder runs out. That
 * ban is real and it is not about this flag: the record is in the Worker's own database,
 * so the device loses every API call from any browser, forever. Nothing here can undo
 * it, and nothing here is what makes it work.
 *
 * What this file does is stop a banned device loading a site it can no longer use, and
 * explain why. That is worth doing, and it is worth being precise about how little it
 * is worth: the pages are static files on GitHub Pages, a different origin from the
 * Worker, so a browser will keep fetching them whatever this says. Clearing storage or
 * opening a private window puts the pages back. The API stays closed either way.
 *
 * Rendered as an overlay rather than a redirect, because a redirect that can be undone
 * by clearing storage is the same thing as no redirect, and an overlay at least leaves
 * a visible record that this device is blocked.
 */
import { useEffect, useState } from 'react'
import { isLocallyBanned } from '../services/adminService'
import { useTranslate } from '../i18n/useTranslate.js'

export const BAN_STORAGE_KEY = 'demon-roulette-device-banned'

export function BannedNotice() {
  const { t } = useTranslate()
  const [banned, setBanned] = useState(() => isLocallyBanned())

  // Checked after the first render too, so a device that is banned while the tab is
  // open sees the notice without needing a reload. The check is local and cheap, and
  // it does not tell the client anything it does not already hold in storage.
  useEffect(() => {
    const onStorage = (event) => {
      if (event.key === BAN_STORAGE_KEY) {
        setBanned(isLocallyBanned())
      }
    }
    window.addEventListener('storage', onStorage)
    return () => window.removeEventListener('storage', onStorage)
  }, [])

  if (!banned) {
    return null
  }

  return (
    <div
      role="alert"
      style={{
        position: 'fixed',
        inset: '0',
        zIndex: 9999,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '2rem',
        background: '#0b0b12',
        color: '#f3f4f6',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <div style={{ maxWidth: '34rem', textAlign: 'center' }}>
        <h1 style={{ fontSize: '1.35rem', margin: '0 0 1rem' }}>{t('banned.title')}</h1>
        <p style={{ lineHeight: 1.6, margin: '0 0 1rem', color: '#d1d5db' }}>
          {t('banned.body')}
        </p>
        <p style={{ lineHeight: 1.6, margin: '0 0 1rem', color: '#9ca3af', fontSize: '0.9rem' }}>
          {t('banned.note')}
        </p>
      </div>
    </div>
  )
}