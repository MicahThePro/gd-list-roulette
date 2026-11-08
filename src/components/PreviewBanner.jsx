import { endPreviewSession } from '../services/adminService'
import { useTranslate } from '../i18n/useTranslate.js'

/**
 * The preview banner.
 *
 * A moderator signed in as somebody else is looking at an account that is not
 * theirs, and everything on screen could be mistaken for their own -- a run
 * history, a settings page, a leaderboard with their name on it. So the whole
 * window is outlined in orange and the bar says who is being previewed and how to
 * get out of it.
 *
 * Fixed to the edges of the viewport and above everything, because the point is
 * that it cannot be scrolled past or covered by the panel. It is not a dismissible
 * notice: the only way to make it go away is to end the preview, which is what the
 * button does.
 */
export default function PreviewBanner({ username, onEnded }) {
  const { t } = useTranslate()

  if (!username) {
    return null
  }

  const handleEnd = async () => {
    await endPreviewSession()
    onEnded?.()
  }

  return (
    <>
      <div className="preview-outline" aria-hidden="true" />
      <div className="preview-banner" role="status">
        <span className="preview-dot" aria-hidden="true" />
        <strong>{t('preview.previewing', { username })}</strong>
        <span className="preview-note">
          {t('preview.note')}
        </span>
        <button type="button" className="preview-exit" onClick={handleEnd}>
          {t('preview.end')}
        </button>
      </div>
    </>
  )
}
