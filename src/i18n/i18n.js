/**
 * Which language the site is in, and the function that turns a key into text.
 *
 * Modelled on utils/censor.js rather than on React context, for the same reason
 * that file is module state: the mask is read by a plain function called from
 * inside JSX in components that are handed no settings at all, and threading a
 * prop to all of them would mean changing a dozen component signatures to serve
 * one string. A module-level store with a subscription list keeps the decision in
 * one place and lets every component reach it without being handed anything.
 *
 * What that costs is exactly what it costs there: flipping the language does not
 * re-render anything by itself, so subscribers are notified and the app re-renders
 * from the top. See the note in App.jsx on how that is wired.
 */
import en from './locales/en.js'
import es from './locales/es.js'
import zh from './locales/zh.js'
import fr from './locales/fr.js'
import hi from './locales/hi.js'

/** The catalogues, keyed by the id stored in the cookie. */
export const TRANSLATIONS = { en, es, zh, fr, hi }

/** The language the site ships in. */
export const DEFAULT_LANGUAGE = 'en'

/**
 * The picker, in the order it is offered.
 *
 * `name` is written in that language on purpose: a player who cannot read the
 * current language still has to find their own in the list, and "Español" or
 * "हिन्दी" is the one label on the page they are guaranteed to recognise.
 */
export const LANGUAGES = [
  { id: 'en', name: 'English' },
  { id: 'es', name: 'Español' },
  { id: 'zh', name: '中文' },
  { id: 'fr', name: 'Français' },
  { id: 'hi', name: 'हिन्दी' },
]

const isKnown = (id) => Object.prototype.hasOwnProperty.call(TRANSLATIONS, id)

/** Turns anything into a language id this site can actually render. */
export const normalizeLanguage = (value) => {
  const raw = String(value ?? '').trim().toLowerCase()
  if (!raw) return DEFAULT_LANGUAGE
  // The cookie can only ever hold one of these, so the base language of a tagged
  // value ("es-MX", "zh-Hans") is taken rather than refusing it. A browser that
  // reports "fr-CA" wants French.
  const base = raw.split(/[-_]/)[0]
  return isKnown(raw) ? raw : isKnown(base) ? base : DEFAULT_LANGUAGE
}

/** Where the choice is kept. Its own cookie, like every other preference here. */
export const LANGUAGE_STORAGE_KEY = 'demon-roulette-language'
const ONE_YEAR_IN_SECONDS = 60 * 60 * 24 * 365

const readStored = () => {
  if (typeof document === 'undefined') return null
  const match = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${encodeURIComponent(LANGUAGE_STORAGE_KEY)}=`))
  return match ? decodeURIComponent(match.slice(LANGUAGE_STORAGE_KEY.length + 2)) : null
}

const writeStored = (id) => {
  if (typeof document === 'undefined') return
  document.cookie = `${encodeURIComponent(LANGUAGE_STORAGE_KEY)}=${encodeURIComponent(id)}; path=/; max-age=${ONE_YEAR_IN_SECONDS}; samesite=lax`
}

/* The browser's own preference, asked only when nothing has been chosen here.
   `navigator.languages` first because it is the ordered list a reader actually
   has, and a site that only asks `language` gives the wrong answer to somebody
   whose second preference is the one they read. */
const readBrowser = () => {
  if (typeof navigator === 'undefined') return DEFAULT_LANGUAGE
  const candidates = [...(navigator.languages ?? []), navigator.language].filter(Boolean)
  for (const candidate of candidates) {
    const normalized = normalizeLanguage(candidate)
    // normalizeLanguage answers with the default for anything unrecognised, so
    // an unsupported first choice has to be skipped rather than accepted.
    if (normalized !== DEFAULT_LANGUAGE) return normalized
  }
  return DEFAULT_LANGUAGE
}

let current = normalizeLanguage(readStored() ?? readBrowser())
const listeners = new Set()

/** The language currently in use. */
export const getLanguage = () => current

/** Registers a callback for language changes and returns the unsubscribe function. */
export const subscribeToLanguage = (listener) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Switches the language and remembers it.
 *
 * Also sets `lang` on the root element. Screen readers use that to pick a
 * pronunciation rule, and a Spanish page announced with English phonetics is
 * not a translation, it is a worse version of the problem this whole feature
 * exists to solve.
 */
export const setLanguage = (value) => {
  const next = normalizeLanguage(value)
  if (next === current) {
    return current
  }
  current = next
  writeStored(next)
  if (typeof document !== 'undefined') {
    document.documentElement.lang = next
  }
  for (const listener of listeners) {
    listener(next)
  }
  return current
}

/* The attribute is applied at module load rather than only on a change: the very
   first paint is already in the chosen language, so leaving `lang` at the
   document default until somebody switches would mean the first thing a screen
   reader hears is wrong. */
if (typeof document !== 'undefined') {
  document.documentElement.lang = current
}

/** Replaces {name} with the matching value. A placeholder with no value is left
    alone rather than printed as "{name}", which would look like a bug to a reader
    and hide the sentence it sits in. */
const interpolate = (template, values) => {
  if (!values) return template
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(values, name) && values[name] != null
      ? String(values[name])
      : match,
  )
}

/**
 * The text for a key, in the current language.
 *
 * Falls back to English before it falls back to the key, so a translation that
 * has not caught up yet reads as slightly wrong English rather than as a broken
 * interface. The key itself is the last resort: visible, and impossible to miss,
 * which is what should happen if this is ever called with a key nobody defined.
 */
export const translate = (key, values) => {
  const catalogue = TRANSLATIONS[current] ?? en
  const template = catalogue[key] ?? en[key]
  if (typeof template !== 'string') {
    return key
  }
  return interpolate(template, values)
}
