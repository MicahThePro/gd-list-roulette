import { useEffect, useRef } from 'react'
import { CHANGELOG, LATEST_VERSION } from '../data/changelog'
import { playableVersions, versionUrl } from '../data/versions'
import { useTranslate } from '../i18n/useTranslate.js'

/**
 * The site history dialog. Opened from the main menu, and closable with Escape,
 * a click on the backdrop, or the close button.
 */
export default function ChangelogDialog({ isOpen, onClose }) {
  const { t } = useTranslate()
  const closeRef = useRef(null)

  useEffect(() => {
    if (!isOpen) return undefined

    // Escape cancels, as expected of a dialog.
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)

    // Move focus into the dialog so keyboard and screen reader users land
    // inside it rather than staying back on the trigger button.
    closeRef.current?.focus()

    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  if (!isOpen) return null

  return (
    <div className="modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="modal changelog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="changelog-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="changelog-head">
          <div>
            <p className="eyebrow">{t('changelog.eyebrow')}</p>
            <h2 id="changelog-title">{t('changelog.title', { version: LATEST_VERSION })}</h2>
          </div>
          <button
            ref={closeRef}
            type="button"
            className="secondary-button changelog-close"
            onClick={onClose}
          >
            {t('common.close')}
          </button>
        </div>

        <div className="changelog-list">
          {CHANGELOG.map((release, index) => {
            /* Only a version with a frozen build gets a link. The current one has
               none on purpose: it is the page you are already on, so a link to it
               would be a button that reloads what is in front of you, and it would
               be a second copy to keep current. An old version with no build --
               because it was never built, or the folder was deleted -- says so
               rather than offering a link to nothing. */
            const isLive = index === 0
            const hasBuild = playableVersions.includes(release.version)
            const oldVersionUrl = hasBuild ? versionUrl(release.version) : null

            return (
              <section key={release.id} className="changelog-entry">
                <div className="changelog-entry-head">
                  <span className="changelog-version">{release.version}</span>
                  {isLive && <span className="changelog-new">{t('changelog.new')}</span>}
                  {!isLive && hasBuild && (
                    <a
                      className="changelog-play"
                      href={oldVersionUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {t('changelog.play')}
                    </a>
                  )}
                  {!isLive && !hasBuild && (
                    <span className="changelog-play changelog-play-missing">{t('changelog.notAvailable')}</span>
                  )}
                </div>
                <h3>{release.title}</h3>
                <p className="changelog-summary">{release.summary}</p>
                <ul>
                  {release.changes.map((change) => (
                    <li key={change}>{change}</li>
                  ))}
                </ul>
                {oldVersionUrl && (
                  <p className="changelog-play-note">
                    {t('changelog.playNote', { version: release.version })}
                  </p>
                )}
              </section>
            )
          })}
        </div>

        <p className="changelog-foot">
          {t('changelog.foot')}
        </p>
      </div>
    </div>
  )
}
