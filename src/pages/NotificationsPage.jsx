import { useEffect, useState } from 'react'
import { fetchNotifications, markNotificationRead } from '../services/apiService'
import { useTranslate } from '../i18n/useTranslate.js'

export default function NotificationsPage({ viewer, onNotificationChange, onOpenProfile, onBack }) {
  const { t } = useTranslate()
  const [items, setItems] = useState([])
  const [error, setError] = useState('')

  const load = async () => {
    if (!viewer) return
    try {
      const result = await fetchNotifications()
      setItems(result.notifications ?? [])
      onNotificationChange?.()
    } catch (caught) {
      setError(caught?.message ?? t('notifications.loadFailed'))
    }
  }

  useEffect(() => {
    load()
  }, [viewer])

  const handleOpen = async (item) => {
    if (!item?.actorUsername) return
    if (!item.isRead) {
      try {
        await markNotificationRead(item.id)
        onNotificationChange?.()
      } catch {
        // ignore failed read marks, keep navigation working
      }
    }
    onOpenProfile?.(item.actorUsername)
  }

  return (
    <main className="page-shell">
      <section className="panel hero-panel hero-panel-wide">
        <header className="board-page-bar">
          <div>
            <p className="eyebrow">{t('notifications.eyebrow')}</p>
            <h2>{t('notifications.title')}</h2>
          </div>
          <button type="button" className="secondary-button" onClick={onBack}>
            {t('profile.backHome')}
          </button>
        </header>

        {!viewer && <p className="settings-note">{t('notifications.signIn')}</p>}
        {error && <div className="validation-message">{error}</div>}

        <div className="notification-list">
          {(items ?? []).length === 0 && viewer && (
            <p className="lb-empty">{t('notifications.none')}</p>
          )}
          {(items ?? []).map((item) => (
            <button
              key={item.id}
              type="button"
              className={item.isRead ? 'notification-item' : 'notification-item unread'}
              onClick={() => handleOpen(item)}
            >
              <strong>@{item.actorUsername}</strong>
              <span>{t('notifications.followedYou')}</span>
              <small>{new Date(item.createdAt).toLocaleString()}</small>
            </button>
          ))}
        </div>
      </section>
    </main>
  )
}
