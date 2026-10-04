/**
 * The video link a player submits.
 *
 * The site does not host the video. A player records their run however they
 * like, puts it somewhere they already have, and pastes the link. Nothing is
 * uploaded, so there is no storage to pay for and no size limit to hit.
 *
 * Only the shape of the link is checked here. The Worker checks it again, and
 * the decision about whether a video actually shows a full run is a person's.
 */

// The hosts a Geometry Dash player is most likely to already have an account
// on. These are suggestions in the form, not a whitelist: any https link is
// accepted, because a whitelist would quietly refuse a legitimate video
// hosted somewhere nobody thought to list.
import { translate } from '../i18n/i18n.js'

export const SUGGESTED_HOSTS = [
  {
    name: 'Google Drive',
    key: 'submit.host.drive',
  },
  {
    name: 'YouTube',
    key: 'submit.host.youtube',
  },
  {
    name: 'Discord',
    key: 'submit.host.discord',
  },
  {
    name: 'OneDrive',
    key: 'submit.host.onedrive',
  },
  {
    name: 'Google Photos',
    key: 'submit.host.photos',
  },
]

export const CONTAINERS = ['mp4', 'mov', 'avi', 'mkv', 'webm']

/* Only webm and mp4 play inline in a browser. The rest are accepted, since a
   player may have whatever their recorder produced, and the review screen says
   the link has to be opened elsewhere rather than showing a dead player. */
export const PLAYABLE = new Set(['webm', 'mp4'])

/**
 * Checks a pasted link and returns a usable one.
 *
 * Only http and https are allowed. A `javascript:` or `data:` URL is refused
 * rather than normalised, because a moderator clicks this link, and a link that
 * runs script is worse than no link at all.
 */
export const normalizeVideoUrl = (value) => {
  const raw = String(value ?? '').trim()
  if (!raw) {
    return { ok: false, error: translate('video.pasteTheLink') }
  }

  // A bare "drive.google.com/..." is the most common paste, and it is not a URL
  // on its own, so the scheme is added rather than telling the user off.
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`

  let parsed
  try {
    parsed = new URL(withScheme)
  } catch {
    return { ok: false, error: translate('video.notALinkYet') }
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: translate('video.httpOnly') }
  }

  if (!parsed.hostname.includes('.')) {
    return { ok: false, error: translate('video.incomplete') }
  }

  return { ok: true, url: parsed.toString() }
}

export const normalizeContainer = (value) => {
  const cleaned = String(value ?? '').toLowerCase().replace(/^\./, '')
  return CONTAINERS.includes(cleaned) ? cleaned : null
}

/** A short label for the host, so a moderator sees where a link points. */
export const getHostLabel = (value) => {
  try {
    return new URL(value).hostname.replace(/^www\./, '')
  } catch {
    return translate('video.unknownHost')
  }
}
