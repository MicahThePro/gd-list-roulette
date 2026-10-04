import { useEffect, useState } from 'react'
import { PING_INTERVAL_MS, pingWorker } from '../services/pingService.js'
import { useTranslate } from '../i18n/useTranslate.js'

/**
 * The signal symbol beside the site title.
 *
 * Three bars, filling in order, coloured by what the Worker actually did:
 *   good  all three lit, green  -- the Worker answered quickly
 *   slow  the first two lit, amber -- the Worker answered, but late
 *   none  one bar, red -- no answer at all
 *
 * What it measures is the round trip to the Worker and nothing else. The pages
 * themselves come from GitHub Pages, a different origin with its own CDN, so a
 * site that loads perfectly while this is red is the expected case, not a
 * contradiction -- that is what the tooltip says.
 *
 * The unknown state is drawn as one dimmed bar rather than red: on the first
 * paint nothing has been asked yet, and painting that as "no connection" would
 * claim something the page does not know.
 */

const BARS = [1, 2, 3]

const STATE_FILL = { good: 3, slow: 2, none: 1 }

const WorkerSignal = () => {
  const { t } = useTranslate()
  // The initial detail is translated on each render rather than stored, so it is
  // already right on the very first paint in whatever language is chosen.
  const [result, setResult] = useState({ status: 'unknown', ms: null, detail: '' })

  useEffect(() => {
    /* The controller is kept for the whole mount, so a ping in flight is
     * abandoned when the component goes away rather than landing in a state
     * that is no longer on screen -- and a fresh controller each round would
     * leave the previous one un-aborted. */
    const controller = new AbortController()
    let cancelled = false

    /* Guards against stacking.
     *
     * The interval fires on a timer, not on the previous round finishing, so on
     * a link that takes longer than the interval each tick would land on top of
     * the request still in flight. Those pile up, and the pile is what makes a
     * bad connection look worse than it is -- the browser's own connection pool
     * starts queuing behind the backlog. Dropping a tick that arrives early means
     * a slow link is measured once a round instead of once a second, which is
     * both honest about the latency and kind to the Worker. */
    let inFlight = false

    const measure = async () => {
      if (inFlight) return
      inFlight = true

      try {
        const next = await pingWorker({ signal: controller.signal })
        if (!cancelled) setResult(next)
      } catch (error) {
        // Only an abort reaches here; a failed ping is a state, not a throw.
        if (!cancelled && error?.name !== 'AbortError') {
          setResult({ status: 'none', ms: null, detail: t('signal.unreachable') })
        }
      } finally {
        inFlight = false
      }
    }

    measure()
    const timer = setInterval(measure, PING_INTERVAL_MS)

    /* Back from a locked screen or another tab, the last number can be minutes
     * old. Ask again straight away rather than showing a stale reading for up to
     * another interval. */
    const onVisible = () => {
      if (document.visibilityState === 'visible') measure()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      controller.abort()
    }
  }, [t])

  const fill = STATE_FILL[result.status] ?? 0

  const label =
    result.status === 'unknown'
      ? t('signal.checking')
      : result.status === 'none'
        ? t('signal.noConnection', { detail: result.detail || t('signal.unreachable') })
        : `${t('signal.connected', { ms: result.ms })}${result.status === 'slow' ? t('signal.slow') : ''}`

  return (
    <span className={`worker-signal worker-signal-${result.status}`} title={label} aria-label={label} role="img">
      <span className="worker-signal-bars">
        {BARS.map((bar) => (
          <span key={bar} className={bar <= fill ? 'lit' : ''} style={{ height: `${bar * 5 + 3}px` }} />
        ))}
      </span>
      <span className="worker-signal-text">
        {result.status === 'none' ? t('signal.offline') : result.status === 'unknown' ? '...' : `${result.ms} ms`}
      </span>
    </span>
  )
}

export default WorkerSignal