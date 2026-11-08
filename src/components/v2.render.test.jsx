/**
 * Renders the new v2 components to HTML and asserts on the markup.
 *
 * A browser is not available in every environment this runs in, and react-dom
 * works on the server. Rendering the real components with the real props is
 * what proves they mount, throw no error, and produce the elements they are
 * supposed to, rather than merely that the file parses.
 *
 * Run with: node --experimental-vm-modules src/components/v2.render.test.js
 */
import { renderToStaticMarkup } from 'react-dom/server'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { parse } from '@babel/parser'
import process from 'node:process'
import AccountDialog from './AccountDialog.jsx'
import ChangelogDialog from './ChangelogDialog.jsx'
import GlobalLeaderboard from './GlobalLeaderboard.jsx'
import Leaderboard from './Leaderboard.jsx'
import PreviewBanner from './PreviewBanner.jsx'
import ResultsPage from '../pages/ResultsPage.jsx'
import RoulettePage from '../pages/RoulettePage.jsx'
import HomePage from '../pages/HomePage.jsx'
import SettingsDialog from './SettingsDialog.jsx'
import { censorText, isCensoring, setCensoring } from '../utils/censor.js'
import { isPlayable, versionUrl, PLAYABLE_VERSIONS } from '../data/versions.js'
import { CHANGELOG, LATEST_VERSION } from '../data/changelog.js'

let failures = 0

/* Walks every node of a Babel AST. Written out rather than pulled in, because
 * @babel/traverse is CommonJS and does not survive Vite's SSR interop. */
function visitNodes(node, visit) {
  if (node == null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const child of node) visitNodes(child, visit)
    return
  }
  if (typeof node.type === 'string') visit(node)
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue
    visitNodes(node[key], visit)
  }
}

/* Every .jsx under src/, so a check can be a rule over the whole app rather than an
 * assertion about one screen. Test files are left out: they are full of deliberate
 * counter-examples that would trip the rule. */
function listJsxFiles(importMetaUrl) {
  const root = fileURLToPath(new URL('..', importMetaUrl))
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsx'))
    .filter((entry) => !entry.name.endsWith('.test.jsx'))
    /* `entry.parentPath` is already absolute in this node, so it is used on its own
     * rather than joined onto root -- which would produce a doubled absolute path. */
    .map((entry) => (entry.parentPath ? join(entry.parentPath, entry.name) : join(root, entry.name)))
}

const relativeName = (file) => file.slice(file.indexOf('/src/') + 1)

const check = (name, condition, detail = '') => {
  if (condition) {
    console.log(`  pass  ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`)
  }
}

const signedOut = {
  user: null,
  isRestoring: false,
  isBusy: false,
  error: '',
  setError: () => {},
  signIn: async () => ({ ok: true }),
  signUp: async () => ({ ok: true }),
  signOut: async () => {},
}

const signedIn = {
  ...signedOut,
  user: { id: 1, username: 'player_one', displayName: 'Player One' },
}

console.log('AccountDialog')
{
  const closed = renderToStaticMarkup(<AccountDialog isOpen={false} onClose={() => {}} auth={signedOut} />)
  check('a closed dialog renders nothing', closed === '', closed.slice(0, 80))

  const signInHtml = renderToStaticMarkup(<AccountDialog isOpen onClose={() => {}} auth={signedOut} />)
  check('the sign in form renders', signInHtml.includes('Username') && signInHtml.includes('Password'))
  check('the dialog is labelled for screen readers', signInHtml.includes('aria-modal="true"'))
  check('the dialog gets its own width, not the settings one', signInHtml.includes('account-dialog') && !signInHtml.includes('settings-dialog'))
  check('the password field is masked', signInHtml.includes('type="password"'))
  // react-dom renders the attribute camelCased, so the check matches that.
  check('the password field is not autofilled as a new one', signInHtml.includes('autoComplete="current-password"'))
  check('the dialog is an inline form so Enter submits', signInHtml.includes('<form'))
  check('sign up is offered from the sign in form', signInHtml.includes('Create an account'))
  check('the display name field is hidden before choosing sign up', !signInHtml.includes('Display name'))

  const signingUp = renderToStaticMarkup(
    <AccountDialog isOpen onClose={() => {}} auth={{ ...signedOut, }} mode="signup" />,
  )
  check('the default mode is still sign in', !signingUp.includes('Display name'))

  /* The sign-up form has to state both name rules, because they pull in opposite
   * directions and neither is obvious from the fields: a username folds and is
   * unique, a display name keeps its case and is not.

   * The rules cannot be reached through the component's `mode`, which is internal
   * state the dialog only flips from its own "Create an account" button -- a static
   * render never clicks it. Asserting on a `mode` prop would therefore pass against
   * a form that can never actually show the text. What is asserted instead is the
   * text itself, read out of the source, which is the part that would go stale: the
   * sentence a player reads is the claim being made, and a reworded rule that drops
   * one half of it should fail here. */
  const dialogSource = readFileSync(new URL('./AccountDialog.jsx', import.meta.url), 'utf8')
  // Matched against the source with whitespace collapsed, because the sentence is
  // wrapped across lines in the JSX and a plain substring test would fail on a
  // rewrap rather than on a reword -- which is the change this is meant to catch.
  const dialogText = dialogSource.replace(/\s+/g, ' ')
  check('the sign-up form says the username is lowercase', /always lowercase/i.test(dialogText))
  check('the sign-up form says the display name keeps its capitalisation', /keeps the capitalisation/i.test(dialogText))
  check(
    'and says a display name is not unique',
    /another player can have the same display name as you/i.test(dialogText),
  )
  check(
    'and does not claim the username keeps the case it was typed in',
    !/Capitalisation is kept as you type it/.test(dialogText),
  )

  const accountHtml = renderToStaticMarkup(<AccountDialog isOpen onClose={() => {}} auth={signedIn} />)
  check('a signed in player sees their name', accountHtml.includes('Player One'))
  check('a signed in player sees their handle', accountHtml.includes('@player_one'))
  check('a signed in player gets a sign out button', accountHtml.includes('Sign out'))
  check('a signed in player is not asked to sign in again', !accountHtml.includes('type="password"'))

  /* The display name editor and its once-a-day limit.
   *
   * The interesting cases are the two the feature is actually about: an account
   * that has changed its name, and one that has not. They render differently and
   * in opposite directions, so a check on only one of them would pass with the
   * other broken. */
  const neverChanged = renderToStaticMarkup(
    <AccountDialog
      isOpen
      onClose={() => {}}
      auth={{
        ...signedIn,
        user: { ...signedIn.user, displayNameChangedAt: null },
        changeDisplayName: async () => ({ ok: true }),
      }}
    />,
  )
  check('an account that never changed its name can edit it', neverChanged.includes('Change display name'))
  check('the edit is not greyed out when the limit is unused', !neverChanged.includes('available again in'))
  check('and no countdown is shown', !neverChanged.includes('You can change your display name again in'))

  const justChanged = renderToStaticMarkup(
    <AccountDialog
      isOpen
      onClose={() => {}}
      auth={{
        ...signedIn,
        user: {
          ...signedIn.user,
          displayNameChangedAt: Date.now() - 60 * 60 * 1000,
        },
        changeDisplayName: async () => ({ ok: true }),
      }}
    />,
  )
  check('the edit is offered while the limit runs', justChanged.includes('Change display name'))
  check('the countdown sits where the edit was made', justChanged.includes('available again in'))
  check('the button is genuinely disabled, not merely ignored', /<button[^>]*disabled[^>]*>Change display name/.test(justChanged))
  check('the countdown is rendered as a live figure, not a placeholder', /available again in <strong>\d/.test(justChanged), justChanged.slice(justChanged.indexOf('available again in'), justChanged.indexOf('available again in') + 60))

  /* A limit that has just expired must read as open. Date.now() past the window is
   * the case a player hits when they leave the tab open across the deadline, and
   * it is the one that unlocks the field rather than greying it -- so a stale
   * "still locked" here would leave a player waiting out a day that is already up. */
  const limitExpired = renderToStaticMarkup(
    <AccountDialog
      isOpen
      onClose={() => {}}
      auth={{
        ...signedIn,
        user: {
          ...signedIn.user,
          displayNameChangedAt: Date.now() - 25 * 60 * 60 * 1000,
        },
        changeDisplayName: async () => ({ ok: true }),
      }}
    />,
  )
  check('the field is open again once the day is up', !limitExpired.includes('available again in'))
  check('and the button is enabled again', !/<button[^>]*disabled[^>]*>Change display name/.test(limitExpired))

  /* The handle under the name in the dialog, so the two are distinguishable at
   * the point of editing as well as on the leaderboard. */
  check('the display name and the handle are shown as two separate things', accountHtml.includes('account-handle') && accountHtml.includes('@player_one'))

  const restoring = renderToStaticMarkup(
    <AccountDialog isOpen onClose={() => {}} auth={{ ...signedOut, isRestoring: true }} />,
  )
  check('a restored session says so instead of flashing a form', restoring.includes('Checking your saved sign in'))

  // The results screen opens this same dialog with a run in hand. It no longer
  // asks whether to save that run: the run is why the dialog is open, so it is
  // saved to the account being signed in to. The wording says so, because saving
  // something on the player's account without saying so would be worse than asking
  // -- but a question they can decline is not a save either.
  const withoutRun = renderToStaticMarkup(<AccountDialog isOpen onClose={() => {}} auth={signedOut} />)
  check('with no run in hand nothing is promised about saving', !withoutRun.includes('saved to'))

  const withRun = renderToStaticMarkup(
    <AccountDialog isOpen onClose={() => {}} auth={signedOut} pendingRun={{ rounds: [] }} />,
  )
  check('with a run in hand the saving is stated', withRun.includes('is saved to'))
  check('and named against the account being typed', withRun.includes('<strong>@your account</strong>'))
  // The bug was a question the player could answer no to, and the run then living
  // only on the device. There is no control to untick at all.
  check('and there is no longer a question to answer about it', !withRun.includes('Put the run I just finished'))
  check('no checkbox is offered in its place', !withRun.includes('admin-remember'))
}

console.log('Previewing another account')
{
  /* The preview swaps three separate things -- the app's copy of the player, the
   * board on screen, and the local history -- and each of them used to be left
   * behind on its own, which is how a preview ended up showing one account's name
   * over another account's runs and then signing the moderator out at the end. */

  const previewing = {
    ...signedIn,
    user: { id: 2, username: 'lt4717', displayName: 'lt4717' },
    isPreviewing: true,
  }
  const html = renderToStaticMarkup(<AccountDialog isOpen onClose={() => {}} auth={previewing} />)
  check('the account on screen is the previewed one', html.includes('@lt4717'), html.slice(0, 200))
  check('and not the moderator\'s own account', !html.includes('@player_one'))

  const banner = renderToStaticMarkup(<PreviewBanner username="lt4717" onEnded={() => {}} />)
  check('the banner names who is being previewed', banner.includes('Previewing lt4717') && banner.includes('account'), banner.slice(0, 200))
  // The wording promises the moderator everything they do is done as the player.
  // That is only true if every screen reads the previewed account, which is exactly
  // what this string asserts and what the swap is for.
  check('and says their actions are the player\'s', banner.includes('Anything you do here is done as them'))

  // No preview, no banner: it is not a dismissible notice, so it must not render
  // when there is nothing to end.
  check('no preview renders no banner', renderToStaticMarkup(<PreviewBanner username={null} />) === '')
}

console.log('Changelog, and playing an old version')
{
  /* The changelog offers a frozen build of each old version. The two ways it can be
   * wrong are both worse than not offering the link at all: a link to a version that
   * was never built looks like a broken feature, and a link on the current version
   * is a button that reloads the page you are already on. */
  const closed = renderToStaticMarkup(<ChangelogDialog isOpen={false} onClose={() => {}} />)
  check('a closed changelog renders nothing', closed === '', closed.slice(0, 80))

  const dialog = renderToStaticMarkup(<ChangelogDialog isOpen onClose={() => {}} />)
  check('the current version is marked new', dialog.includes('New'))
  // The live version is already what you are looking at, so a button that reopens it
  // is worse than no button. It is the one entry with no link.
  check(
    'and never offers a link to itself',
    !dialog.includes(versionUrl(CHANGELOG[0].version)),
    versionUrl(CHANGELOG[0].version),
  )

  // Every release in the changelog up to the live one has a frozen build, so each
  // offers a link rather than saying it is unavailable. This is the whole point of
  // the feature: the list in versions.js and the built versions/ directory have to
  // stay in step, and a silent mismatch here would only ever be found by clicking.
  const missing = CHANGELOG.slice(1).filter((release) => !isPlayable(release.version))
  check(
    'every past release has a build to play',
    missing.length === 0,
    missing.map((release) => release.version).join(', '),
  )
  check('and no entry says it is unavailable', !dialog.includes('Not available'))
  check(
    'each playable release links to its own build',
    CHANGELOG.slice(1).every((release) => dialog.includes(versionUrl(release.version))),
  )

  // versionUrl is relative, so it survives the site living on a repository subpath.
  check(
    'a version URL is relative and ends in a slash',
    versionUrl('v1.9') === './versions/v1.9/' && versionUrl('v1.9').endsWith('/'),
    versionUrl('v1.9'),
  )
  check('a version nobody has tagged is not playable', !isPlayable('v0.1'))

  /* The two versions this update ships.
   *
   * Checked by name rather than by position, so the checks keep meaning something
   * after the next bump: they assert that the release named here is the live one
   * and that the one before it is playable, not merely that "the first entry" is
   * first. A changelog that grows is the normal case, and a test that only holds
   * while the list is the length it is today stops being a test. */
  check('v2.6 is the live version', CHANGELOG[0].version === 'v2.6', CHANGELOG[0].version)
  // Matched on the heading and the version alone rather than on the whole phrase,
  // because the apostrophe in "What's new" is a curly one in the component. Testing
  // the exact string would make this check fail over typography, and fixing it
  // would mean editing the check every time the apostrophe changed.
  check(
    'the heading names the live version',
    dialog.includes('What') && dialog.includes('new in v2.6'),
    LATEST_VERSION,
  )
  check('v2.5 is playable as the previous release', isPlayable('v2.5'))
  check('v2.5 has a play link', dialog.includes(versionUrl('v2.5')), versionUrl('v2.5'))

  check('v2.4 is in the changelog', CHANGELOG.some((release) => release.version === 'v2.4'))
  check('v2.4 is playable', isPlayable('v2.4'))
  check('and v2.4 has a play link', dialog.includes(versionUrl('v2.4')), versionUrl('v2.4'))

  check('v2.3 is in the changelog', CHANGELOG.some((release) => release.version === 'v2.3'))
  check('v2.3 is playable', isPlayable('v2.3'))
  check('and v2.3 has a play link', dialog.includes(versionUrl('v2.3')), versionUrl('v2.3'))

  /* The changelog is the only thing that says a build exists, so the claim and the
   * directory have to agree. This is the one check that needs the filesystem, and it
   * is here because the alternative is a link that 404s in production and passes
   * every other check. */
  check(
    'the v2.2 build is actually on disk',
    existsSync(new URL('../data/../../versions/v2.2/index.html', import.meta.url)),
    'versions/v2.2/index.html is missing',
  )

  /* Every release claims a build, so every claim has to resolve. A missing directory
   * is exactly the failure the "is written by hand" note in versions.js warns about. */
  const claimedButAbsent = PLAYABLE_VERSIONS.filter(
    (version) => !existsSync(new URL(`../data/../../versions/${version}/index.html`, import.meta.url)),
  )
  check(
    'every claimed build exists on disk',
    claimedButAbsent.length === 0,
    claimedButAbsent.join(', '),
  )
}

console.log('Leaderboard, with no import and no export')
{
  const anEntry = {
    id: '1700000000000-AREDL',
    at: 1700000000000,
    source: 'AREDL',
    step: 1,
    status: 'completed',
    score: 100,
    roundsPlayed: 2,
    passed: 2,
    skipped: 0,
    skipReasons: {},
    totalMs: 60000,
    avgMs: 30000,
    rounds: [
      ['a', 'Level A', 1, 100, 'success', 30000, null, null],
      ['b', 'Level B', 2, 100, 'success', 30000, null, null],
    ],
  }

  const props = { onDelete: () => {}, auth: signedOut }
  const withRuns = renderToStaticMarkup(<Leaderboard {...props} entries={[anEntry]} />)
  check('a run is listed', withRuns.includes('100%') && withRuns.includes('AREDL'))
  check('there is no export button', !withRuns.includes('Copy leaderboard code'))
  check('there is no import button', !withRuns.includes('Import leaderboard code'))
  check('and no dialog for one either', !withRuns.includes('DLRH1:'))
  /* No clear-all. It was the only control here that could destroy something
     permanently in one unconfirmed click, including a ranked run whose delete
     also takes the submission with it. Each run keeps its own delete. */
  check('there is no clear all button', !withRuns.includes('Clear all runs'))
  // With nothing on the board there is nothing to delete at all.
  const empty = renderToStaticMarkup(<Leaderboard {...props} entries={[]} />)
  // The empty message points at signing in rather than at a code that no longer
  // exists, because that is now how a run reaches another device.
  check('the empty message points at the account', empty.includes('sign in') && !empty.includes('leaderboard code'))

  /* Deleting a run that is on the global leaderboard.
   *
   * The delete cascade takes the submission with it, so the run leaves the public
   * board for good and cannot be resubmitted. That has to be said before the click
   * rather than discovered afterwards, and the warning is only for a ranked run --
   * putting it on every delete would only teach people to dismiss it. */
  const ranked = renderToStaticMarkup(
    <Leaderboard {...props} entries={[{ ...anEntry, id: 'ranked-1', onGlobalBoard: true }]} />,
  )
  check('the warning is not rendered until a ranked delete is asked for', !ranked.includes('Remove this run from the leaderboard'))
  check('a ranked run is not announced on the row itself', !ranked.includes('on the leaderboard'))

  /* An ordinary run gets no warning at all -- it is not ranked, so there is
     nothing to lose but the run itself, which the delete button already names. */
  check('an unranked run is not treated as ranked', !withRuns.includes('Remove this run from the leaderboard'))

  /* Every run on the board has to be reachable somewhere, or it is a run the
   * player can count, see the total of, and never find or remove. That happened
   * to a failed run: it was stored, counted in the badge and the "N of M runs
   * stored" line, and had no tab, so no row and no delete button. The counts are
   * the whole claim -- if the tabs do not add up to the total, one is unreachable.
   *
   * The three statuses below are the three summarizeRun can produce, so this is
   * the exact set that went missing, not a sample. */
  const everyStatus = ['completed', 'gaveup', 'failed']
  const withOneOfEach = everyStatus.map((status, index) => ({
    ...anEntry,
    id: `170000000${index}000-AREDL`,
    status,
  }))
  const allStatuses = renderToStaticMarkup(<Leaderboard {...props} entries={withOneOfEach} />)
  check('a board of every kind of run says how many it holds', allStatuses.includes('3 of 20 runs stored'), allStatuses.slice(0, 300))
  check('and has a tab for each', ['Succeeded', 'Gave up', 'Failed'].every((label) => allStatuses.includes(label)), allStatuses.slice(0, 300))
  // The tab badges are the other half of the same claim: they are what the player
  // reads to work out where a missing run went.
  const badgeCounts = [...allStatuses.matchAll(/lb-tab-count">(\d+)</g)].map((m) => Number(m[1]))
  check(
    'and the tab counts add up to the total',
    badgeCounts.reduce((sum, n) => sum + n, 0) === withOneOfEach.length,
    badgeCounts.join('+'),
  )

  // A status this version does not know about -- written by a newer one -- must
  // still be listed rather than counted into nothing.
  const withUnknown = renderToStaticMarkup(
    <Leaderboard {...props} entries={[...withOneOfEach, { ...anEntry, id: 'unknown-1', status: 'abandoned' }]} />,
  )
  check('a run with an unfamiliar status is not swallowed', withUnknown.includes('4 of 20 runs stored'), withUnknown.slice(0, 300))
  check('it gets a tab of its own so it can be found and deleted', withUnknown.includes('Other'), withUnknown.slice(0, 300))

  /* The two filter strips must not share one grid row.
   *
   * The Pointercrate part filter was added as a second `.lb-filters` child, and
   * the leaderboard's grid has exactly one `filters` area. Two children in one
   * named area are placed into the same cell, so the sort chips and the part
   * chips were painted on top of each other on the Gave up tab -- two sets of
   * buttons occupying the same pixels. Asserted here on the CSS rather than on
   * geometry, because this harness renders markup and never lays anything out:
   * what has to hold is that the two strips name two different areas. */
  const css = readFileSync(new URL('../App.css', import.meta.url), 'utf8')
  const areas = css.match(/grid-template-areas:\s*([^;]+);/g)?.join('\n') ?? ''
  check('the leaderboard grid gives each filter strip its own row', /'filters'\s*\n\s*'partfilters'/.test(areas), areas)
  check('and the part strip is placed in the second one', /\.lb-part-filters\s*\{[^}]*grid-area:\s*partfilters/s.test(css))
  // Both strips rendering at once is the case that overlapped, so it is built:
  // a Pointercrate run gives the part filter something to offer.
  const withPointercrate = renderToStaticMarkup(
    <Leaderboard
      {...props}
      entries={[
        { ...anEntry, id: 'pc-1', source: 'Pointercrate Demon List', status: 'gaveup', pointercrateParts: ['legacy'] },
        { ...anEntry, id: 'pc-2', source: 'Pointercrate Demon List', status: 'gaveup', pointercrateParts: ['main'] },
      ]}
    />,
  )
  check(
    'a board holding a Pointercrate run offers all three part buttons',
    ['Main list only', 'Extended list only', 'Legacy list only']
      .every((label) => withPointercrate.includes(label)),
    withPointercrate.slice(0, 300),
  )
  check(
    'and it uses its own class rather than the sort strip class',
    withPointercrate.includes('class="lb-part-filters"') && !withPointercrate.includes('class="lb-filters" lb-part'),
  )
}

console.log('GlobalLeaderboard')
{
  const html = renderToStaticMarkup(<GlobalLeaderboard user={null} />)
  check('the five boards are all offered', ['Farthest %', 'Most levels cleared', 'Fastest run', 'Fewest skips', 'Most recent']
    .every((label) => html.includes(label)), html.slice(0, 200))
  check('the farthest board is the default', html.includes('board-chip-active'))
  check('the list filter starts on all lists', html.includes('All lists'))
  check('every list this site plays is filterable', ['Pointercrate', 'AREDL', 'GSL', 'Challenge List', 'Impossible Levels']
    .every((label) => html.includes(label)))
  check('the board announces itself while loading', html.includes('Loading the global leaderboard'))
  check('the board is a labelled tablist', html.includes('aria-label="Leaderboard board"'))
  /* A row used to be a span with the personal board's button class, so the
   * pointer was real and the click was not. The name has to be a button that
   * opens that player's profile. */
  const globalSource = readFileSync(new URL('./GlobalLeaderboard.jsx', import.meta.url), 'utf8')
  check(
    'a global row opens that player\'s profile',
    /<button[\s\S]*?className="lb-main"[\s\S]*?onClick=\{\(\) => onOpenProfile\?\.\(entry\.username\)\}/.test(globalSource),
  )
  check(
    'a slower leaderboard response cannot paint over a newer filter',
    globalSource.includes('seq !== requestSeq.current'),
  )
  // The first paint is the loading state, since the board has not been read
  // yet. The empty message belongs to the render after the fetch comes back
  // with nothing, which a static render cannot reach.
  check('a board with no entries yet is not shown as empty', !html.includes('No runs on this board yet'))
  check('nobody is highlighted when signed out', !html.includes('lb-row-you'))
  // The page-level board tabs must not reuse .lb-tabs: that class is a grid
  // child of the leaderboard's own template, so on this page it stacked the
  // buttons and dropped them to the bottom of the panel.
  check('the board chips are not the page-level tabs', !html.includes('board-view-tab'))
  // The list filter has no visible text of its own, so it needs a label that
  // only a screen reader sees. .visually-hidden did not exist until v2, and
  // silently omitting it left the select unlabelled.
  check('the list filter has a screen reader label', html.includes('visually-hidden'))
  // .lb-empty belongs to the leaderboard's own grid. Reusing it here put the
  // message in a grid area that does not exist on this page, which is why it
  // drifted off to the right instead of sitting under the board.
  check('the empty message does not reuse the leaderboard grid class', !html.includes('lb-empty'))

  /* The Pointercrate part filter is chips, not a second dropdown.
   *
   * It was a <select>, and a native popup is not part of the document: any
   * re-render that changes the <option> list makes the browser drop the open
   * popup. This board re-reads itself every 30 seconds and again on every input
   * change, so the list menu closed under the player's cursor and the next
   * click merely reopened it -- the dropdown looked broken. The chips are the
   * same buttons the personal board uses, and cannot be closed by a re-render. */
  check('there is only one dropdown, the list filter', (html.match(/<select/g) ?? []).length === 1, `${(html.match(/<select/g) ?? []).length} selects`)
  check('and no part dropdown is offered at all', !html.includes('All Pointercrate lists'))

  const boardHtml = renderToStaticMarkup(
    <div className="panel board-page">
      <header className="board-page-bar">
        <h2>Leaderboards</h2>
      </header>
      <div className="board-body">
        <div className="board-view-tabs">
          <button type="button" className="board-view-tab board-view-tab-active">Your runs</button>
          <button type="button" className="board-view-tab">Global</button>
        </div>
      </div>
    </div>,
  )
  // .board-page is a three row grid. The tab strip must not be a direct child
  // of it, because a fourth child is auto-placed into the minmax(0, 1fr) row
  // and stretches to fill the whole panel, which is what made the two buttons
  // tower over the page. Wrapped in .board-body, the row count stays at three.
  const directChildren = boardHtml.match(/<section class="panel board-page">([\s\S]*?)<\/header>[\s\S]*?<\/section>/)?.[1] ?? ''
  check('the tab strip is not a direct child of the three row grid', !/<div class="board-view-tabs">/.test(directChildren))
  check('the tab strip sits inside the list row', boardHtml.includes('<div class="board-body">'))
}

console.log('Results, for a run played signed out')
{
  const aRun = {
    status: 'failed',
    startingPercent: 1,
    endingPercent: 2,
    skippedCount: 0,
    rounds: [],
    source: 'AREDL',
    currentTarget: 2,
  }
  const noop = () => {}
  const auth = {
    user: null,
    isRestoring: false,
    isBusy: false,
    error: '',
    setError: noop,
    signIn: async () => ({ ok: true }),
    signUp: async () => ({ ok: true }),
    signOut: async () => {},
  }
  const renderResults = (extra = {}) =>
    renderToStaticMarkup(
      <ResultsPage
        run={aRun}
        runKey="run-1"
        onRestart={noop}
        auth={auth}
        {...extra}
      />,
    )

  /* The signed out case is the one the whole rule is about, so it is asserted on
   * the words that would be a lie rather than on the words that are merely
   * different. These panels used to tell a signed out player their run was already
   * recorded on the device, which stopped being true the moment runs stopped saving
   * there -- a claim like that is the reason the copy was reworded at all. */
  const signedOut = renderResults()
  check('a signed out player is told to sign in to save', signedOut.includes('Sign in to save this run'))
  check(
    'and is not told the run is already saved somewhere',
    !signedOut.includes('already recorded on this device'),
    signedOut.includes('already recorded on this device') ? 'still claims the run is on the device' : '',
  )
  check('nor that it is saved in this browser', !signedOut.includes('already saved in this browser'))
  check('and is told plainly that it is not saved anywhere', signedOut.includes('not saved anywhere'))

  /* The prompt. It only appears once there is an account to attach the run to, so
   * the signed out render above must not contain it -- otherwise it would be
   * asking a question about an account that does not exist yet. */
  check('the keep-or-discard question is not shown before signing in', !signedOut.includes('Keep this run?'))

  /* Signing in mid-run is what raises the question, so the state has to be
   * reachable from the callback the account dialog reports through. The default
   * render has no way to drive that callback, so what is asserted here is that a
   * signed-in player with no decision pending gets the ordinary save offer rather
   * than the prompt -- i.e. the prompt is not simply always on. */
  const signedIn = renderResults({
    auth: { ...auth, user: { id: 1, username: 'player_one', displayName: 'Player One' } },
  })
  /* The offer is now the button alone, in the action row at the bottom rather
   * than inside its own panel. What is asserted is that the control is still
   * there and still names the account -- not that it sits in a box. */
  check('a run ended while already signed in gets the save button', signedIn.includes('Save run to @'))
  check('and is not asked a question it did not need asking', !signedIn.includes('Keep this run?'))
  check('the button names the account it saves to', signedIn.includes('Save run to @player_one'))
  /* The two ways out of the page both have to say what they do, since one of
   * them destroys the run and the other keeps it. "New run" did not. */
  check('the way out of the page says the run is discarded', signedIn.includes('Discard and go home'))
  check('and it is no longer the ambiguous bare "New run"', !signedIn.includes('New run'))

  const customRun = renderResults({
    run: { ...aRun, customRunId: 'custom-run-id' },
    auth: { ...auth, user: { id: 1, username: 'player_one', displayName: 'Player One' } },
  })
  check('custom results explain that they are not saved', customRun.includes('not saved to your run history'))
  check('custom results do not offer account saving', !customRun.includes('Save run to @'))
  check('custom results do not offer leaderboard submission', !customRun.includes('Global leaderboard'))

  /* Guard against the keep-or-discard ternary chain losing its expression braces.
   *
   * That panel is only reachable after a sign in mid-run, so no render above can
   * reach it -- but when the `{` is missing the ternaries parse as literal JSX
   * *text* rather than as an expression, and the page renders the page's own
   * source code to the player: conditionals, question and answer, all of it. No
   * exception is thrown, no existing check renders it, and it ships because the
   * broken build looks exactly as healthy as the working one.
   *
   * So the guard is on the AST, not on rendered output and not on a regex over
   * source lines: parse the file and fail on any JSXText child that still looks
   * like the expression it should have been. That catches the brace being lost
   * anywhere in the file, not just on the line it happened on. */
  const resultsSource = readFileSync(new URL('../pages/ResultsPage.jsx', import.meta.url), 'utf8')
  const leakedSource = []
  let parseError = ''
  try {
    visitNodes(parse(resultsSource, { sourceType: 'module', plugins: ['jsx'] }), (node) => {
      if (node.type !== 'JSXText') return
      const text = node.value.trim()
      if (text === '') return
      // Source that leaked into the DOM keeps the punctuation of code: a bare
      // `? (` chain, or a condition naming one of the component's state
      // variables. Rendered copy contains neither.
      if (/\?\s*\(/.test(text) || /\b(keepDecision|isSavedToAccount|isSubmitting)\b/.test(text)) {
        leakedSource.push(JSON.stringify(text))
      }
    })
  } catch (error) {
    // A brace can also be lost in a way that leaves the file unparseable. That is
    // a build error rather than a test result, so it is reported as a failure of
    // this check instead of crashing the whole run and hiding every other check.
    parseError = error?.message ?? String(error)
  }
  check(
    'the results page parses and no JSX expression has collapsed into literal text',
    leakedSource.length === 0 && parseError === '',
    [parseError, ...leakedSource].join(' | '),
  )
}

/* The profanity mask, and the player's opt-out from it.
 *
 * The mask used to be applied when a list was loaded, which meant the real name was
 * destroyed before anything could render it. A setting that unmasked words could
 * therefore never work for level names -- which is most of what a player reads. The
 * name is kept intact now and masked where it is shown, so these check both halves
 * of that: that the data survives, and that the screen respects the choice.
 *
 * `setCensoring` is restored after every check because the mask is module state
 * shared by the whole render, so a check that left it off would quietly disarm every
 * masking check after it. */
console.log('\nThe profanity mask')
{
  const NAME = 'Super Shitty Song'
  const run = {
    status: 'playing',
    currentTarget: 1,
    source: 'gsl',
    target: 1,
    rounds: [],
    currentLevel: { id: 'level-1', name: NAME, creator: 'someone' },
  }
  const renderRoulette = () =>
    renderToStaticMarkup(
      <RoulettePage
        run={run}
        gameRules={{ allowSkip: true }}
        onSkip={() => {}}
        onGiveUp={() => {}}
        onStartOver={() => {}}
      />,
    )

  setCensoring(true)
  check('the mask is on by default', isCensoring())
  check('and masks the word it is there for', censorText(NAME) === 'Super S****y Song', censorText(NAME))

  const maskedHtml = renderRoulette()
  check('a level name is masked on the page', maskedHtml.includes('S****y') && !maskedHtml.includes(NAME))
  check('an active run tells players to start recording before the first attempt', maskedHtml.includes('Start recording before your first attempt'))
  check('recording advice asks for continuous video showing attempts and results', maskedHtml.includes('one continuous video') && maskedHtml.includes('attempts and their results'))
  check('the active run has no copy-save-code control', !maskedHtml.includes('Copy save code'))
  /* Give up used to be `onClick={onGiveUp}`. The click event arrived as the
   * next screen, the app stored that object, and every screen failed to match,
   * so the page collapsed to the header and the run never reached results. */
  const rouletteSource = readFileSync(new URL('../pages/RoulettePage.jsx', import.meta.url), 'utf8')
  check('give up does not forward the click event', rouletteSource.includes('onClick={() => onGiveUp()}'))
  const appSource = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8')
  check(
    'give up ignores anything that is not a screen name',
    /const destination = Object\.values\(SCREEN\)\.includes\(nextScreen\) \? nextScreen : SCREEN\.RESULTS/.test(appSource),
  )
  const customHtml = renderToStaticMarkup(
    <RoulettePage
      run={{ ...run, customRunId: 'custom-run-id' }}
      gameRules={{ allowSkip: true }}
      onSkip={() => {}}
      onGiveUp={() => {}}
      onStartOver={() => {}}
    />,
  )
  check('custom runs do not show leaderboard recording advice', !customHtml.includes('Start recording before your first attempt'))

  setCensoring(false)
  check('switching it off reaches the mask itself', !isCensoring())
  check('and the word comes back', censorText(NAME) === NAME, censorText(NAME))
  const shownHtml = renderRoulette()
  check('the level name is really shown when opted out', shownHtml.includes(NAME))
  check('and nothing is left starred', !/S\*+y/i.test(shownHtml))

  /* The data has to survive the load for any of the above to mean anything: the
   * mask used to be applied as each list was loaded, which overwrote the real name
   * before anything could render it, so a player who opted out could never see it.
   *
   * Asserted on the source rather than by calling fetchList, because that needs the
   * network and a test that quietly skips itself when the network is gone is not a
   * test. What matters is that the load path does not touch the name at all, which
   * is a property of the file rather than of any one response. */
  const listSource = readFileSync(new URL('../services/listService.js', import.meta.url), 'utf8')
  const loadPath = listSource.slice(
    listSource.indexOf('const censorLevels'),
    listSource.indexOf('export const fetchList'),
  )
  check(
    'the list loader does not rewrite the level name',
    !/censorText\s*\(/.test(loadPath),
    loadPath.slice(0, 200),
  )
  /* And the components that show a level name must still mask it themselves, since
   * nothing does it for them now. Checked by rendering rather than by reading, so a
   * name that stops being masked on screen fails here even if this file never
   * changes again. */
  check('masking still happens where the name is read', maskedHtml.includes('S****y'))
  setCensoring(true)
  check('the mask is restored for the checks that follow', isCensoring())
}

/* The opt-out itself, in the settings dialog.
 *
 * Checked as rendered markup because the whole of this feature is a checkbox and
 * the text around it: a player who cannot tell what the box does, or who turns it on
 * without being warned, has still not been given the choice. */
console.log('\nThe uncensored-names setting')
{
  const common = {
    isOpen: true,
    onClose: () => {},
    percentStep: 1,
    percentStepDraft: '1',
    onDraftChange: () => {},
    onCommit: () => {},
    estimatedRounds: 100,
    allowSkip: false,
    onAllowSkipChange: () => {},
    levelTimeLimitDraft: '',
    onLevelTimeLimitDraftChange: () => {},
    onCommitLevelTimeLimit: () => {},
    totalTimeLimitDraft: '',
    onTotalTimeLimitDraftChange: () => {},
    onCommitTotalTimeLimit: () => {},
  }
  const maskedHtml = renderToStaticMarkup(<SettingsDialog {...common} isMasked onIsMaskedChange={() => {}} />)
  const shownHtml = renderToStaticMarkup(<SettingsDialog {...common} isMasked={false} onIsMaskedChange={() => {}} />)

  check('the setting is offered in settings', maskedHtml.includes('Show uncensored level names'))
  check('it explains that it is off by default', /off is the default/i.test(maskedHtml))
  /* The box is "show uncensored", so off-by-default has to mean unchecked. Asserting
   * the absence of the attribute rather than counting checked boxes elsewhere in the
   * dialog, since Allow skipping is a checkbox too and is on in this render. */
  const censorRow = maskedHtml.slice(maskedHtml.indexOf('Show uncensored level names') - 400)
  check(
    'and it starts unchecked, so words stay masked',
    /type="checkbox"/.test(censorRow) && !/type="checkbox" checked/.test(censorRow),
  )
  check('the box is checked once the player opts in', /type="checkbox" checked/.test(
    shownHtml.slice(shownHtml.indexOf('Show uncensored level names') - 400),
  ))
  check('no warning is shown while the mask is on', !maskedHtml.includes('Uncensored names are on'))
  check('the player is warned once they switch it off', shownHtml.includes('Uncensored names are on'))
  check('and told it may contain profanity', /profanity/i.test(shownHtml))
  /* Asserted as "warns without rambling" rather than on any one wording. The copy
   * here is deliberately one line, because a warning long enough to need reading
   * carefully stops being read as a warning -- so the thing to protect is its
   * length, not its phrasing. */
  const warningEl = shownHtml.match(/<p class="settings-censor-warning">([\s\S]*?)<\/p>/)
  check(
    'the warning stays short',
    warningEl !== null
      && warningEl[1].split(/\s+/).filter(Boolean).length <= 30,
    warningEl ? warningEl[1].split(/\s+/).filter(Boolean).length + ' words' : 'no warning element',
  )
}

/* Settings focus.
 *
 * Opening the dialog used to focus the percentage field, and the effect that did it
 * depended on `onCommit`, which is a new function on every render of the page above.
 * So every commit from any field re-ran the effect and pulled focus back to the
 * percentage box -- which is why clicking out of a text box threw the caret into it.
 *
 * Focus is a runtime behaviour and cannot be asserted on rendered markup, so what is
 * checked here is the two things that can be: that the dialog is the focus container
 * rather than one of its fields, and that nothing focuses a field on open.
 */
console.log('\nSettings focus')
{
  const common = {
    isOpen: true,
    onClose: () => {},
    percentStep: 1,
    percentStepDraft: '1',
    onDraftChange: () => {},
    onCommit: () => {},
    estimatedRounds: 100,
    allowSkip: false,
    onAllowSkipChange: () => {},
    levelTimeLimitDraft: '',
    onLevelTimeLimitDraftChange: () => {},
    onCommitLevelTimeLimit: () => {},
    totalTimeLimitDraft: '',
    onTotalTimeLimitDraftChange: () => {},
    onCommitTotalTimeLimit: () => {},
    isMasked: true,
    onIsMaskedChange: () => {},
  }
  const html = renderToStaticMarkup(<SettingsDialog {...common} />)

  /* tabIndex -1 on the dialog itself. Without it the container cannot take focus,
   * so Tab would escape the dialog on the first press -- which is the other half of
   * what the old field-focusing call was covering up. */
  check(
    'the dialog is the focus container',
    /class="modal settings-dialog"[^>]*tabindex="-1"/.test(html),
    html.slice(html.indexOf('settings-dialog'), html.indexOf('settings-dialog') + 120),
  )
  check('it is labelled for screen readers', html.includes('aria-labelledby="settings-title"'))

  /* The regression itself, read off the source: on open, nothing may focus a form
   * field. The container's own focus() is the point, so `dialog` is the one name
   * allowed through -- any other ref is a control, and a control being focused is
   * the bug. */
  const settingsSource = readFileSync(new URL('./SettingsDialog.jsx', import.meta.url), 'utf8')
  const focusesAField = [...settingsSource.matchAll(/(\w+)Ref\.current\?\.focus\(\)/g)]
    .map((match) => match[1])
    .filter((name) => name !== 'dialog')
  check(
    'opening the dialog focuses no form field',
    focusesAField.length === 0,
    focusesAField.join(', '),
  )
  check(
    'and the dialog container is what takes focus instead',
    /dialogRef\.current\?\.focus\(\)/.test(settingsSource),
  )
}

console.log('\nThe list dropdown')
{
  const options = (masked) => {
    setCensoring(masked)
    const html = renderToStaticMarkup(
      <HomePage
        onStart={() => {}}
        history={{}}
        gameRules={{}}
        auth={{ user: null }}
        isMasked={masked}
        onIsMaskedChange={() => {}}
      />,
    )
    if (masked) {
      check(
        'the home screen no longer offers run save-code loading',
        !html.includes('GDLRS1') && !html.includes('Saved run code') && !html.includes('Load run'),
      )
    }
    const select = html.split('<select')[1]?.split('</select>')[0] ?? ''
    setCensoring(true)
    return [...select.matchAll(/<option[^>]*value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/g)].map(
      (match) => ({ value: match[1], label: match[2].replace(/<[^>]+>/g, '').trim() }),
    )
  }

  const masked = options(true)
  const unmasked = options(false)

  const aredl = masked.find((option) => option.value === 'aredl')
  check('AREDL is spelled out in the dropdown', aredl?.label === 'All Rated Extreme Demons List (AREDL)', aredl?.label)

  const gslMasked = masked.find((option) => option.value === 'gsl')
  const gslShown = unmasked.find((option) => option.value === 'gsl')
  check('GSL is masked while the mask is on', gslMasked?.label === 'Global S****y List', gslMasked?.label)
  check('and spelled out once the player opts out', gslShown?.label === 'Global Shitty List', gslShown?.label)

  /* The label is display only. If it ever leaks into what a run is stamped with, an
   * AREDL run stops matching the value the Worker accepts -- which is the drift
   * sourceNames.test.js guards against. So each option must carry a value that is the
   * raw source id and nothing else, which is what the loaders and the submission check
   * match on. Asserted against the ids themselves rather than against "has no spaces",
   * since one of them legitimately does. */
  const expectedIds = ['pointercrate', 'aredl', 'gsl', 'challengelist', 'impossiblelevels']
  check(
    'the option values are still the raw source ids',
    JSON.stringify(masked.map((option) => option.value)) === JSON.stringify(expectedIds),
    JSON.stringify(masked.map((o) => `${o.value}=${o.label}`)),
  )
  check('every list is still offered', masked.length === 5, `${masked.length} options`)
}

/* The run's own source chip.
 *
 * A `run.source` rendered without `censorText` is invisible to the existing checks:
 * it is a page nobody tests, a single word in a badge, and it still looks correct.
 * That is exactly how "Global Shitty List" sat unstarred next to a level name that
 * was starred, in the same screenshot, until somebody noticed.
 *
 * So this is checked as a rule over the whole of src/ rather than as one more
 * assertion about one screen: any JSX expression that renders a `.source` must pass
 * it through the mask. A source name reaching the page raw is a bug wherever it
 * appears, and there are enough of them that finding them one at a time is how the
 * last one stayed broken. */
console.log('\nSource names are masked wherever they render')
{
  const offenders = []
  for (const file of listJsxFiles(import.meta.url)) {
    const source = readFileSync(file, 'utf8')
    for (const match of source.matchAll(/\{([^{}\n]*\.source)\}/g)) {
      if (!match[1].includes('censorText')) {
        const line = source.slice(0, match.index).split('\n').length
        offenders.push(`${relativeName(file)}:${line} {${match[1]}}`)
      }
    }
  }
  check(
    'no source name is rendered without the mask',
    offenders.length === 0,
    offenders.join(' | '),
  )
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
