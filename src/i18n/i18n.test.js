/**
 * The translation catalogues.
 *
 * These are the tests that make a missing translation a build failure rather than
 * a raw key on somebody's screen. There are three things worth catching and each
 * is a different mistake:
 *
 *   1. A key exists in English and not in another language. That renders as
 *      English inside an otherwise translated page, which reads as a bug rather
 *      than as an untranslated string.
 *   2. A key exists in another language and not in English. That key can never
 *      render at all, because English is the fallback -- so it is dead weight
 *      that looks like coverage.
 *   3. Two languages disagree about the placeholders in a value. The text is
 *      fine in both and it is still broken: `translate` fills what it finds, so a
 *      template with {rank} and a translation without it quietly drops the rank
 *      off the end of a sentence rather than showing an error.
 *
 * Run with `npm run worker:test`, which is where the other data-shape tests live.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import en from './locales/en.js'
import { TRANSLATIONS, DEFAULT_LANGUAGE, LANGUAGES, normalizeLanguage } from './i18n.js'

const englishKeys = Object.keys(en)

test('English is the default and is in the picker', () => {
  assert.equal(DEFAULT_LANGUAGE, 'en')
  assert.ok(TRANSLATIONS.en)
  assert.deepEqual(
    LANGUAGES.map((entry) => entry.id),
    ['en', 'es', 'zh', 'fr', 'hi'],
  )
})

test('every language offered has a catalogue', () => {
  for (const { id } of LANGUAGES) {
    assert.ok(TRANSLATIONS[id], `no catalogue for the offered language "${id}"`)
  }
})

test('no catalogue carries a key English does not define', () => {
  for (const [id, catalogue] of Object.entries(TRANSLATIONS)) {
    for (const key of Object.keys(catalogue)) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(en, key),
        `${id} defines "${key}", which English does not -- it can never render`,
      )
    }
  }
})

test('every language translates every English key', () => {
  for (const [id, catalogue] of Object.entries(TRANSLATIONS)) {
    const missing = englishKeys.filter(
      (key) => !Object.prototype.hasOwnProperty.call(catalogue, key),
    )
    assert.deepEqual(missing, [], `${id} is missing ${missing.length} key(s)`)
  }
})

test('no translation is left empty or untranslated', () => {
  /* A handful of values are the same in every language on purpose, and naming
     them here is better than loosening the rule: a separator and a proper noun
     are not English that failed to be translated, whereas "Too hard" appearing in
     the Hindi catalogue is. Anyone adding a genuinely untranslated string will
     have to add it to this list, and will have to justify it. */
  const IDENTICAL_BY_DESIGN = new Set([
    'roulette.skipReasonSeparator',
    'board.rowPointercrate',
    // "No" is the French and the English spelling, and picking the Spanish "No"
    // or the Hindi "नहीं" here would be a translation rather than a typo fix.
    'common.no',
    // The tab name of the worldwide board. Translated in the other three
    // languages; "Global" is the word French uses for it too.
    'home.global',
    // French spells these the same way English does, and picking a Spanish or
    // Hindi wording here would be a translation of a word that does not need one.
    'common.minutes', // minutes
    'topbar.notifications', // Notifications
    'notifications.title', // Notifications
    'home.eyebrowRuns', // Runs
    'results.source', // Source
    'global.personalRunsOne', // run
    'global.personalRunsMany', // runs
  ])

  for (const [id, catalogue] of Object.entries(TRANSLATIONS)) {
    if (id === 'en') continue
    const blank = englishKeys.filter((key) => !String(catalogue[key] ?? '').trim())
    assert.deepEqual(blank, [], `${id} has blank text for ${blank.length} key(s)`)

    /* A translation byte-identical to the English is almost always a copy-paste
       that was never actually translated. */
    const copied = englishKeys.filter(
      (key) => !IDENTICAL_BY_DESIGN.has(key) && catalogue[key] === en[key],
    )
    assert.deepEqual(copied, [], `${id} still has English text for ${copied.join(', ')}`)
  }
})

/** Every {placeholder} a value uses, in order. */
const placeholdersOf = (value) => [...String(value).matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort()

test('every language agrees on the placeholders in a value', () => {
  for (const key of englishKeys) {
    const expected = placeholdersOf(en[key])
    for (const [id, catalogue] of Object.entries(TRANSLATIONS)) {
      assert.deepEqual(
        placeholdersOf(catalogue[key]),
        expected,
        `${id} disagrees with English about the placeholders in "${key}"`,
      )
    }
  }
})

test('a language tag resolves to a language the site has', () => {
  // The cases a browser actually reports. `language` and `languages` both hand
  // back tagged values, so a tagged value has to resolve rather than be refused.
  assert.equal(normalizeLanguage('es'), 'es')
  assert.equal(normalizeLanguage('es-MX'), 'es')
  assert.equal(normalizeLanguage('zh-Hans'), 'zh')
  assert.equal(normalizeLanguage('fr-CA'), 'fr')
  assert.equal(normalizeLanguage('hi-IN'), 'hi')
  assert.equal(normalizeLanguage('EN'), 'en')
})

test('an unknown or missing language falls back to English', () => {
  assert.equal(normalizeLanguage('kl'), 'en')
  assert.equal(normalizeLanguage('pt-BR'), 'en')
  assert.equal(normalizeLanguage(''), 'en')
  assert.equal(normalizeLanguage(null), 'en')
  assert.equal(normalizeLanguage(undefined), 'en')
  assert.equal(normalizeLanguage({}), 'en')
})

test('the language names are written in their own language', () => {
  /* A player who cannot read the current one still has to find theirs, so the
     picker is the one place on the page that must not be translated into the
     language it is offering. */
  assert.deepEqual(
    LANGUAGES.map((entry) => entry.name),
    ['English', 'Español', '中文', 'Français', 'हिन्दी'],
  )
})
