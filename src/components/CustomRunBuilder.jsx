import { useEffect, useMemo, useState } from 'react'
import {
  fetchAredlListBounds,
  fetchChallengeListBounds,
  fetchGslListBounds,
  fetchImpossibleLevelsBounds,
  fetchAredlLevelDetails,
  fetchChallengeLevelDetails,
  fetchList,
  LIST_SOURCES,
} from '../services/listService'
import { createCustomRun } from '../services/customRunService'
import { censorText } from '../utils/censor'
import { useTranslate } from '../i18n/useTranslate.js'

const SOURCE_OPTIONS = [
  { id: 'pointercrate', name: LIST_SOURCES.POINTERCRATE },
  { id: 'aredl', name: LIST_SOURCES.AREDL },
  { id: 'gsl', name: LIST_SOURCES.GSL },
  { id: 'challengelist', name: LIST_SOURCES.CHALLENGE },
  { id: 'impossiblelevels', name: LIST_SOURCES.IMPOSSIBLE },
]

const boundsForSource = {
  aredl: fetchAredlListBounds,
  gsl: fetchGslListBounds,
  challengelist: fetchChallengeListBounds,
  impossiblelevels: fetchImpossibleLevelsBounds,
}

const loadSourceLevels = async (source) => {
  if (source === 'pointercrate') {
    return fetchList({
      source,
      pointercrateParts: ['main', 'extended', 'legacy'],
    })
  }

  const bounds = await boundsForSource[source]()
  return fetchList({ source, start: 1, end: bounds.end })
}

const sourceLabel = (source) =>
  SOURCE_OPTIONS.find((option) => option.id === source)?.name ?? source

const getShareUrl = (id) => {
  const url = new URL(import.meta.env.BASE_URL, window.location.origin)
  url.searchParams.set('custom', id)
  return url.href
}

export default function CustomRunBuilder({ user, onClose, onOpenRun }) {
  const { t } = useTranslate()
  const [source, setSource] = useState('pointercrate')
  const [sourceLevels, setSourceLevels] = useState([])
  const [isLoadingLevels, setIsLoadingLevels] = useState(true)
  const [sourceError, setSourceError] = useState('')
  const [rankDraft, setRankDraft] = useState('')
  const [previewDetails, setPreviewDetails] = useState(null)
  const [isLoadingPreview, setIsLoadingPreview] = useState(false)
  const [levels, setLevels] = useState([])
  const [percentStep, setPercentStep] = useState(1)
  const [allowSkip, setAllowSkip] = useState(false)
  const [levelTimeLimitMinutes, setLevelTimeLimitMinutes] = useState(0)
  const [totalTimeLimitMinutes, setTotalTimeLimitMinutes] = useState(0)
  const [isCreating, setIsCreating] = useState(false)
  const [createdUrl, setCreatedUrl] = useState('')
  const [message, setMessage] = useState('')
  const maximumLevels = Math.ceil(100 / percentStep)
  const availableRanks = useMemo(
    () => new Map(sourceLevels.map((level) => [Number(level.position), level])),
    [sourceLevels],
  )
  const selectedPreview = useMemo(() => {
    const rank = Number(rankDraft)
    return Number.isInteger(rank) && rank > 0 ? availableRanks.get(rank) ?? null : null
  }, [rankDraft, availableRanks])
  const preview =
    selectedPreview && previewDetails?.id === selectedPreview.id
      ? { ...selectedPreview, ...previewDetails.details }
      : selectedPreview

  useEffect(() => {
    let active = true
    loadSourceLevels(source)
      .then((result) => {
        if (active) setSourceLevels(result.levels)
      })
      .catch((error) => {
        if (active) setSourceError(error?.message ?? t('builder.loadListFailed'))
      })
      .finally(() => {
        if (active) setIsLoadingLevels(false)
      })
    return () => {
      active = false
    }
  }, [source, t])

  useEffect(() => {
    let active = true
    const selected = selectedPreview
    if (!selected) return undefined

    const shouldHydrateAredl =
      source === 'aredl' && (!selected.thumbnail || selected.creator === 'Unknown creator')
    const shouldHydrateChallenge =
      source === 'challengelist' && selected.listId != null && (!selected.thumbnail || selected.levelId == null)
    if (!shouldHydrateAredl && !shouldHydrateChallenge) return undefined

    const hydrate = async () => {
      try {
        if (shouldHydrateAredl) {
          const details = await fetchAredlLevelDetails(selected)
          if (active && details) setPreviewDetails({ id: selected.id, details })
        } else if (shouldHydrateChallenge) {
          const details = await fetchChallengeLevelDetails(selected.listId)
          if (!active) return
          const video = details?.video ?? selected.video
          setPreviewDetails({
            id: selected.id,
            details: {
              levelId: selected.levelId ?? details?.levelId,
              video,
              thumbnail: selected.thumbnail ?? (video ? `https://i.ytimg.com/vi/${video}/mqdefault.jpg` : null),
            },
          })
        }
      } catch (error) {
        if (active) setSourceError(error?.message ?? t('builder.loadDetailsFailed'))
      } finally {
        if (active) setIsLoadingPreview(false)
      }
    }

    hydrate()
    return () => {
      active = false
    }
  }, [selectedPreview, source, t])

  const addLevel = () => {
    if (!preview || levels.length >= maximumLevels) return
    setLevels((current) => [...current, preview])
    setRankDraft('')
    setPreviewDetails(null)
    setIsLoadingPreview(false)
  }

  const moveLevel = (index, direction) => {
    setLevels((current) => {
      const nextIndex = index + direction
      if (nextIndex < 0 || nextIndex >= current.length) return current
      const next = [...current]
      ;[next[index], next[nextIndex]] = [next[nextIndex], next[index]]
      return next
    })
  }

  const handleCreate = async () => {
    if (!levels.length || levels.length > maximumLevels || isCreating) return
    setIsCreating(true)
    setMessage('')
    try {
      const { id } = await createCustomRun({
        source: sourceLabel(source),
        percentStep,
        allowSkip,
        levelTimeLimitMs: levelTimeLimitMinutes * 60_000,
        totalTimeLimitMs: totalTimeLimitMinutes * 60_000,
        levels,
      })
      setCreatedUrl(getShareUrl(id))
    } catch (error) {
      setMessage(error?.message ?? t('builder.createFailed'))
    } finally {
      setIsCreating(false)
    }
  }

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(createdUrl)
      setMessage(t('builder.linkCopied'))
    } catch {
      setMessage(t('builder.copyFailed'))
    }
  }

  const stepChanged = (value) => {
    const parsed = Number(value)
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 100) return
    setPercentStep(parsed)
    setLevels((current) => current.slice(0, Math.ceil(100 / parsed)))
  }

  const changeSource = (nextSource) => {
    setSource(nextSource)
    setSourceLevels([])
    setLevels([])
    setRankDraft('')
    setPreviewDetails(null)
    setSourceError('')
    setIsLoadingLevels(true)
    setIsLoadingPreview(false)
  }

  const changeRank = (value) => {
    const rank = Number(value)
    const selected = Number.isInteger(rank) && rank > 0 ? availableRanks.get(rank) : null
    const needsDetails = selected && (
      (source === 'aredl' && (!selected.thumbnail || selected.creator === 'Unknown creator')) ||
      (source === 'challengelist' && selected.listId != null && (!selected.thumbnail || selected.levelId == null))
    )
    setRankDraft(value)
    setPreviewDetails(null)
    setSourceError('')
    setIsLoadingPreview(Boolean(needsDetails))
  }

  return (
    <div className="modal-backdrop custom-run-backdrop" role="presentation" onClick={onClose}>
      <section
        className="modal custom-run-builder"
        role="dialog"
        aria-modal="true"
        aria-labelledby="custom-run-builder-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="custom-run-builder-head">
          <div>
            <p className="eyebrow">{t('custom.eyebrow')}</p>
            <h2 id="custom-run-builder-title">{t('builder.title')}</h2>
            <p>{t('builder.signedInAs', { username: user.username })}</p>
          </div>
          <button type="button" className="secondary-button small-button" onClick={onClose}>
            {t('common.close')}
          </button>
        </header>

        {createdUrl ? (
          <div className="custom-run-share">
            <h3>{t('builder.ready')}</h3>
            <p>{t('builder.readyHint')}</p>
            <label>
              {t('builder.challengeLink')}
              <input readOnly value={createdUrl} onFocus={(event) => event.target.select()} />
            </label>
            {message && <p className="export-status" role="status">{message}</p>}
            <div className="action-row">
              <button type="button" className="primary-button" onClick={copyLink}>{t('builder.copyLink')}</button>
              <button type="button" className="secondary-button" onClick={() => onOpenRun(createdUrl)}>
                {t('builder.openChallenge')}
              </button>
            </div>
          </div>
        ) : (
          <div className="custom-run-builder-body">
            <div className="custom-run-columns">
              <div className="custom-run-editor">
                <label className="settings-field">
                  {t('builder.listSource')}
                  <select value={source} onChange={(event) => changeSource(event.target.value)}>
                    {SOURCE_OPTIONS.map((option) => (
                      <option key={option.id} value={option.id}>{censorText(option.name)}</option>
                    ))}
                  </select>
                </label>

                <div className="custom-run-rank-field">
                  <label className="settings-field" htmlFor="custom-run-rank">
                    {t('builder.addByRank')}
                    <input
                      id="custom-run-rank"
                      type="number"
                      min="1"
                      max={sourceLevels.reduce((max, level) => Math.max(max, Number(level.position) || 0), 0)}
                      value={rankDraft}
                      onChange={(event) => changeRank(event.target.value)}
                      disabled={isLoadingLevels}
                      placeholder={isLoadingLevels ? t('builder.loadingList') : t('builder.enterRank')}
                    />
                  </label>
                  {isLoadingLevels && <p className="settings-hint">{t('builder.loadingRanks')}</p>}
                  {sourceError && <p className="validation-message" role="alert">{sourceError}</p>}
                  {preview && (
                    <div className="custom-run-preview">
                      {preview.thumbnail ? (
                        <img src={preview.thumbnail} alt="" loading="lazy" />
                      ) : (
                        <div className="custom-run-preview-placeholder">{t('builder.thumbUnavailable')}</div>
                      )}
                      <div>
                        <strong>{censorText(preview.name)}</strong>
                        <span>{t('builder.byCreator', { creator: censorText(preview.creator || t('roulette.unknownCreator')) })}</span>
                        <small>
                          {t('builder.rankLine', {
                            position: preview.position,
                            levelId: preview.levelId ? t('builder.levelIdSuffix', { levelId: preview.levelId }) : '',
                          })}
                        </small>
                      </div>
                    </div>
                  )}
                  {isLoadingPreview && <p className="settings-hint">{t('builder.loadingDetails')}</p>}
                  {rankDraft && !preview && !isLoadingLevels && (
                    <p className="settings-hint">{t('builder.noLevelAtRank')}</p>
                  )}
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={addLevel}
                    disabled={!preview || isLoadingPreview || levels.length >= maximumLevels}
                  >
                    {t('builder.addLevel', { number: levels.length + 1 })}
                  </button>
                </div>

                <div className="custom-run-rules">
                  <h3>{t('builder.rulesHeading')}</h3>
                  <label className="settings-field">
                    {t('settings.percentIncrement')}
                    <input
                      type="number"
                      min="1"
                      max="100"
                      step="1"
                      value={percentStep}
                      onChange={(event) => stepChanged(event.target.value)}
                    />
                    <small>{t('builder.maxLevels', { count: maximumLevels })}</small>
                  </label>
                  <label className="settings-toggle-row">
                    <input type="checkbox" checked={allowSkip} onChange={(event) => setAllowSkip(event.target.checked)} />
                    <span><strong>{t('settings.allowSkipping')}</strong></span>
                  </label>
                  <label className="settings-field">
                    {t('builder.timeLimitPerLevel')}
                    <input type="number" min="0" max="10080" value={levelTimeLimitMinutes} onChange={(event) => setLevelTimeLimitMinutes(Number(event.target.value))} />
                  </label>
                  <label className="settings-field">
                    {t('builder.timeLimitTotal')}
                    <input type="number" min="0" max="10080" value={totalTimeLimitMinutes} onChange={(event) => setTotalTimeLimitMinutes(Number(event.target.value))} />
                  </label>
                </div>
              </div>

              <div className="custom-run-order">
                <div className="custom-run-order-head">
                  <div>
                    <h3>{t('builder.orderHeading')}</h3>
                    <p>{t('builder.levelsAdded', { count: levels.length, max: maximumLevels })}</p>
                  </div>
                </div>
                {levels.length ? (
                  <ol>
                    {levels.map((level, index) => (
                      <li key={`${level.id}-${index}`}>
                        <span>{index + 1}. {censorText(level.name)} <small>#{level.position}</small></span>
                        <div>
                          <button type="button" aria-label={t('builder.moveUp', { name: level.name })} disabled={index === 0} onClick={() => moveLevel(index, -1)}>↑</button>
                          <button type="button" aria-label={t('builder.moveDown', { name: level.name })} disabled={index === levels.length - 1} onClick={() => moveLevel(index, 1)}>↓</button>
                          <button type="button" aria-label={t('builder.remove', { name: level.name })} onClick={() => setLevels((current) => current.filter((_, itemIndex) => itemIndex !== index))}>×</button>
                        </div>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="settings-note">{t('builder.orderEmpty')}</p>
                )}
                <p className="settings-hint">
                  {t('builder.orderHint', { step: percentStep })}
                </p>
              </div>
            </div>

            {message && <p className="validation-message" role="alert">{message}</p>}
            <div className="action-row custom-run-builder-actions">
              <button type="button" className="secondary-button" onClick={onClose}>{t('common.cancel')}</button>
              <button
                type="button"
                className="primary-button"
                onClick={handleCreate}
                disabled={isCreating || levels.length === 0 || levels.length > maximumLevels}
              >
                {isCreating ? t('builder.creating') : t('builder.createLink')}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
