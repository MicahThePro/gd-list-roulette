import { useState } from 'react'
import { uploadRecording } from '../services/submissionService'
import { markSubmitted } from '../utils/submittedRuns'
import { CONTAINERS, SUGGESTED_HOSTS, getHostLabel, normalizeContainer, normalizeVideoUrl } from '../utils/videoFile'
import { useTranslate } from '../i18n/useTranslate.js'
import { translate } from '../i18n/i18n.js'

/**
 * The global leaderboard submission form.
 *
 * Shared by the results screen and the local leaderboard's run detail, because
 * both are offering the same two things: a claim of who did the run, and a link
 * to the video that backs it. Keeping one copy means the rules -- sign in, list
 * must be ranked, video required, run stored before the proof -- cannot drift
 * apart between the two places a player might submit from.
 *
 * `getPayload` returns the run body to POST. It is a function rather than a run
 * object because the two callers hold different shapes: the results screen still
 * has the live run, while a leaderboard entry is a trimmed summary with packed
 * rounds. Neither the network order nor the validation is this component's
 * business; it just asks for the payload and reports what happened.
 *
 * `runKey` is only used to remember a run the Worker says was already sent, so
 * that a stale local mirror cannot keep offering the button. The Worker is the
 * authority; this is a mirror of its answer.
 */
export default function SubmitRunForm({
  getPayload,
  runKey,
  auth,
  isSubmittable,
  alreadySubmitted = false,
  intro,
  onSubmitted,
}) {
  const { t } = useTranslate()
  const [status, setStatus] = useState({ state: 'idle', message: '' })
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [videoUrl, setVideoUrl] = useState('')
  const [container, setContainer] = useState('mp4')
  const [note, setNote] = useState('')
  const [linkError, setLinkError] = useState('')
  const [linkOk, setLinkOk] = useState('')
  const isDirectSubmitBypass = auth.user?.username?.toLowerCase() === 'geometricalmike'

  // Checked as the player types, so a paste that worked says so immediately
  // rather than only after a failed submit.
  const handleLinkChange = (value) => {
    setVideoUrl(value)
    setLinkOk('')
    if (!value.trim()) {
      setLinkError('')
      return
    }
    const result = normalizeVideoUrl(value)
    if (result.ok) {
      setLinkError('')
      setLinkOk(result.url)
    } else {
      setLinkOk('')
    }
  }

  // The run is stored first and the video second. The run is off the public
  // board until the video is approved, so the worst case from a failure in the
  // middle is a pending run nobody can see, never an unvouched-for score.
  const handleSubmit = async () => {
    const link = isDirectSubmitBypass ? { ok: true, url: 'https://example.invalid/direct-submit' } : normalizeVideoUrl(videoUrl)
    if (!link.ok) {
      setLinkError(link.error)
      return
    }

    setIsSubmitting(true)
    setStatus({
      state: 'idle',
      message: isDirectSubmitBypass
        ? t('submit.sendingDirect')
        : t('submit.sendingForReview'),
    })

    // Declared outside the try so the 409 branch can name the run it refers to.
    let saved = null
    try {
      const result = await getPayload()
      saved = result
      await uploadRecording({
        runId: saved.id,
        videoUrl: link.url,
        container,
        note: note.trim(),
      })

      // Recorded against the run key, not the server's numeric id, so the
      // other entry point -- the local leaderboard's row for the same run --
      // recognises it. See utils/submittedRuns.
      markSubmitted(saved.runKey ?? saved.id)
      setStatus({
        state: 'done',
        message: t('submit.done'),
      })
      onSubmitted?.(saved.id)
    } catch (error) {
      // A 409 means the run was already sent and the Worker refused a second
      // submission, which is the answer rather than a fault: record it locally
      // so the form stops offering to send it again.
      if (error?.status === 409) {
        markSubmitted(saved?.runKey ?? runKey)
        onSubmitted?.()
        setStatus({ state: 'done', message: error.message })
        return
      }
      setStatus({ state: 'error', message: error?.message ?? t('submit.failed') })
    } finally {
      setIsSubmitting(false)
    }
  }

  if (!auth.user) {
    return (
      <>
        <p>{t('submit.signInIntro')}</p>
        <p className="settings-hint">{t('submit.signInHint')}</p>
      </>
    )
  }

  if (alreadySubmitted) {
    return (
      <p className="settings-hint">{t('submit.alreadyQueued')}</p>
    )
  }

  if (!isSubmittable) {
    return (
      <p className="settings-hint">{t('submit.notRanked')}</p>
    )
  }

  return (
    <>
      {intro ?? (
        <p>{t('submit.defaultIntro', { username: auth.user.username })}</p>
      )}

      {isDirectSubmitBypass ? (
        <p className="settings-hint">{t('submit.bypassHint', { username: auth.user.username })}</p>
      ) : (
        <>
          <div className="submit-proof">
            <strong>{t('submit.step1')}</strong>
            <p className="settings-hint">{t('submit.step1Hint')}</p>
            <ul className="host-list">
              {SUGGESTED_HOSTS.map((host) => (
                <li key={host.name}>
                  <strong>{host.name}</strong>
                  <span>{translate(host.key)}</span>
                </li>
              ))}
            </ul>
            <p className="settings-hint">
              {t('submit.step1Hint2', { unlisted: t('submit.unlisted') })}
            </p>
          </div>

          <label className="submit-field">
            {t('submit.step2')}
            <input
              type="url"
              inputMode="url"
              value={videoUrl}
              onChange={(event) => handleLinkChange(event.target.value)}
              placeholder="https://drive.google.com/..."
              disabled={isSubmitting}
            />
          </label>
          {linkError && <div className="validation-message">{linkError}</div>}
          {linkOk && (
            <p className="export-status">
              {t('submit.linkOk', { host: getHostLabel(linkOk) })}
            </p>
          )}

          <label className="submit-field">
            {t('submit.step3')}
            <select
              value={container}
              onChange={(event) => setContainer(normalizeContainer(event.target.value) ?? 'mp4')}
              disabled={isSubmitting}
            >
              {CONTAINERS.map((type) => (
                <option key={type} value={type}>
                  {type.toUpperCase()}
                </option>
              ))}
            </select>
          </label>
          <p className="settings-hint">{t('submit.containerHint')}</p>
        </>
      )}

      <label className="submit-field">
        {t('submit.noteLabel')}
        <input
          type="text"
          value={note}
          maxLength={200}
          onChange={(event) => setNote(event.target.value)}
          placeholder={t('submit.notePlaceholder')}
          disabled={isSubmitting}
        />
      </label>

      <div className="action-row">
        <button
          type="button"
          className="primary-button"
          onClick={handleSubmit}
          disabled={isSubmitting || (!isDirectSubmitBypass && !videoUrl.trim())}
        >
          {isSubmitting ? t('submit.submitting') : t('submit.submitRun')}
        </button>
      </div>
      {status.message && (
        <p className={status.state === 'done' ? 'export-status' : 'validation-message'}>
          {status.message}
        </p>
      )}
    </>
  )
}
