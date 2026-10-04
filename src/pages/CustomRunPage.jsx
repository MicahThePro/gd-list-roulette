import { useEffect, useState } from 'react'
import { getCustomRun, getCustomRunLevel } from '../services/customRunService'
import { censorText } from '../utils/censor'
import { useTranslate } from '../i18n/useTranslate.js'

const formatLimit = (milliseconds, offLabel, t) =>
  milliseconds > 0 ? t('common.minutes', { count: Number((milliseconds / 60_000).toFixed(1)) }) : offLabel

export default function CustomRunPage({ id, onStart, onBack }) {
  const { t } = useTranslate()
  const [loadedRun, setLoadedRun] = useState({ id: null, definition: null, error: '', isLoading: true })
  const { definition, error, isLoading } =
    loadedRun.id === id
      ? loadedRun
      : { definition: null, error: '', isLoading: true }
  const [isStarting, setIsStarting] = useState(false)

  useEffect(() => {
    let active = true
    getCustomRun(id)
      .then((result) => {
        if (active) setLoadedRun({ id, definition: result, error: '', isLoading: false })
      })
      .catch((loadError) => {
        if (active) {
          setLoadedRun({
            id,
            definition: null,
            error: loadError?.message ?? t('custom.loadFailed'),
            isLoading: false,
          })
        }
      })
    return () => {
      active = false
    }
  }, [id, t])

  const start = async () => {
    if (!definition || isStarting) return
    setIsStarting(true)
    try {
      const { level } = await getCustomRunLevel(id, 1)
      onStart(definition, level)
    } catch (startError) {
      setLoadedRun((current) => ({
        ...current,
        id,
        error: startError?.message ?? t('custom.startFailed'),
      }))
    } finally {
      setIsStarting(false)
    }
  }

  if (isLoading) {
    return (
      <main className="page-shell">
        <section className="panel custom-run-landing"><p>{t('custom.loading')}</p></section>
      </main>
    )
  }

  return (
    <main className="page-shell">
      <section className="panel custom-run-landing">
        <p className="eyebrow">{t('custom.eyebrow')}</p>
        <h1>{censorText(definition?.source ?? t('custom.title'))}</h1>
        {error && <p className="validation-message" role="alert">{error}</p>}
        {definition && (
          <>
            <p className="lead">
              {t('custom.createdBy', {
                creator: censorText(definition.creator.displayName),
                username: definition.creator.username,
                count: definition.levelCount,
              })}
            </p>
            <div className="custom-run-rules-summary">
              <div><span>{t('custom.percentIncrement')}</span><strong>+{definition.percentStep}%</strong></div>
              <div>
                <span>{t('custom.allowSkipping')}</span>
                <strong>{definition.allowSkip ? t('common.yes') : t('common.no')}</strong>
              </div>
              <div>
                <span>{t('custom.timePerLevel')}</span>
                <strong>{formatLimit(definition.levelTimeLimitMs, t('common.off'), t)}</strong>
              </div>
              <div>
                <span>{t('custom.totalRunLimit')}</span>
                <strong>{formatLimit(definition.totalTimeLimitMs, t('common.off'), t)}</strong>
              </div>
            </div>
            <p className="settings-note">
              {t('custom.rulesNote')}
            </p>
            <div className="action-row">
              <button type="button" className="primary-button" onClick={start} disabled={isStarting}>
                {isStarting ? t('custom.starting') : t('custom.start')}
              </button>
              <button type="button" className="secondary-button" onClick={onBack}>
                {t('custom.backHome')}
              </button>
            </div>
          </>
        )}
        {!definition && !error && <p>{t('custom.notLoaded')}</p>}
      </section>
    </main>
  )
}
