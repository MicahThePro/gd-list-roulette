import { LANGUAGES, setLanguage } from '../i18n/i18n.js'
import { useTranslate } from '../i18n/useTranslate.js'

/**
 * The language picker, at the bottom of the home screen.
 *
 * Buttons rather than a dropdown, for the reason the Pointercrate part filters
 * are buttons: a native <select> popup lives outside the document, so any
 * re-render that changes its options drops it. That is survivable on a form, but
 * this control is what the player clicks immediately after choosing a language,
 * and a menu that closes itself under the cursor is a menu they will not trust
 * twice. Five options also fits on one line at every phone width.
 *
 * Each label is written in its own language, so a player who cannot read the
 * current one can still find theirs. `lang` on each button is not decoration: it
 * is what lets a screen reader pronounce the name correctly while the page
 * around it is in another language.
 *
 * The hint under the row says what does not change, because "translate the site"
 * reads as "translate everything" and the level names a player spends the run
 * looking at are somebody's own words.
 */
export default function LanguagePicker() {
  const { language, t } = useTranslate()

  return (
    <div className="language-picker">
      <span className="language-picker-label" id="language-picker-label">
        {t('language.label')}
      </span>
      <div
        className="language-picker-options"
        role="group"
        aria-labelledby="language-picker-label"
      >
        {LANGUAGES.map((entry) => (
          <button
            key={entry.id}
            type="button"
            lang={entry.id}
            className={
              language === entry.id ? 'language-button language-button-active' : 'language-button'
            }
            aria-pressed={language === entry.id}
            onClick={() => setLanguage(entry.id)}
          >
            {entry.name}
          </button>
        ))}
      </div>
      <small className="language-picker-hint">{t('language.hint')}</small>
    </div>
  )
}
