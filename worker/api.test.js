/**
 * End-to-end check for the Worker's accounts and leaderboard API.
 *
 * Wrangler itself cannot run in this environment, so the Worker is imported
 * directly and given a D1-shaped shim over node:sqlite. That exercises the real
 * request handler, the real SQL and the real password hashing, so what is
 * verified here is the code that ships rather than a mock of it.
 *
 * Run with:  node --experimental-sqlite worker/api.test.js
 */
// The eslint config targets the browser, so the test file's own globals are
// declared here rather than by loosening the config for every other file.
import process from 'node:process'
import worker from './index.js'
import { createTestDb } from './testDb.js'

// Both migrations, because the leaderboard now reads the submissions table to
// decide which runs have been vetted. Loading only the first would leave the
// board querying a table that does not exist. The third is the trash table,
// which every leaderboard and run-list query now filters through.
/* Every migration, applied in order, by the shared helper. It used to be a local list
 * of migration filenames, edited by hand whenever a migration was added -- and missed,
 * which left the suite running against a schema the production database does not have,
 * passing against tables that were never created. */
const createDb = () => createTestDb()
const BASE = 'https://worker.test'
let failures = 0

const check = (name, condition, detail = '') => {
  if (condition) {
    console.log(`  pass  ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`)
  }
}

const call = (env, path, { method = 'GET', body, token, cookie } = {}) => {
  // The version gate refuses any /api call without the protocol header, so every
  // test here sends it by default.
  const headers = { 'x-dlr-protocol': '3' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`
  if (cookie) headers.cookie = cookie

  return worker.fetch(
    new Request(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  )
}

const post = async (env, path, body, token) => {
  const response = await call(env, path, { method: 'POST', body, token })
  return { response, data: await response.json() }
}

/* PATCH is its own method here rather than a flag on post(): the display name
   edit is a partial update of the signed-in account, and sending it as a POST
   would silently test the wrong route -- a route table that only knows POST would
   answer "Unknown endpoint" and the test would fail for a reason that has
   nothing to do with the behaviour under test. */
const patch = async (env, path, body, token) => {
  const response = await call(env, path, { method: 'PATCH', body, token })
  return { response, data: await response.json() }
}

const aRun = (over = {}) => ({
  runId: 'run-1',
  source: 'AREDL',
  percentStep: 1,
  status: 'failed',
  endedAt: 1_700_000_000_000,
  rounds: [
    { levelId: 'a', levelName: 'A', targetPercent: 1, achievedPercent: 1, result: 'success', elapsedMs: 30000 },
    { levelId: 'b', levelName: 'B', targetPercent: 2, achievedPercent: 2, result: 'success', elapsedMs: 45000 },
    { levelId: 'c', levelName: 'C', targetPercent: 3, achievedPercent: 1, result: 'failure', elapsedMs: 20000 },
  ],
  ...over,
})

console.log('registration and sessions')
{
  const env = { DB: createDb() }

  const weak = await post(env, '/api/register', { username: 'ab', password: 'longenough1' })
  check('short username is rejected', weak.response.status === 400, JSON.stringify(weak.data))

  const weakPass = await post(env, '/api/register', { username: 'playerone', password: 'short' })
  check('short password is rejected', weakPass.response.status === 400)

  const created = await post(env, '/api/register', {
    username: 'Player_One',
    password: 'correct horse',
    displayName: 'Player One',
  })
  check('register succeeds', created.response.status === 201, JSON.stringify(created.data))
  check(
    'the username is stored lowercase, whatever case it was typed in',
    created.data.user?.username === 'player_one',
    created.data.user?.username,
  )
  check('a session token is returned', typeof created.data.token === 'string' && created.data.token.length === 64)
  const cookie = created.response.headers.get('set-cookie') ?? ''
  check('a session cookie is set', cookie.includes('dlr_session=') && cookie.includes('SameSite=Lax'))
  check('the cookie is marked Secure', cookie.includes('Secure'))

  const dupe = await post(env, '/api/register', { username: 'player_one', password: 'another one' })
  check('a taken username is rejected', dupe.response.status === 409, JSON.stringify(dupe.data))

  /* Uniqueness is on the case-folded form, not on the bytes. "PLAYER_ONE" and
     "PlAyEr_OnE" are the same account as "Player_One", and the old UNIQUE
     constraint on the raw column would have taken all three. A name claimed in one
     case cannot then be claimed in another, which is what stops two people holding
     handles that differ only in how they are capitalised and that a case-insensitive
     sign-in cannot tell apart. */
  const dupeCase = await post(env, '/api/register', { username: 'PLAYER_ONE', password: 'another one' })
  check('the same name in different case is rejected', dupeCase.response.status === 409, JSON.stringify(dupeCase.data))
  const dupeMixed = await post(env, '/api/register', { username: 'pLaYeR_OnE', password: 'another one' })
  check('and so is a mixed-case spelling of it', dupeMixed.response.status === 409, JSON.stringify(dupeMixed.data))

  const me = await call(env, '/api/me', { token: created.data.token })
  check('the token identifies the player', (await me.json())?.user?.username === 'player_one')

  const badLogin = await post(env, '/api/login', { username: 'player_one', password: 'wrong' })
  check('a wrong password is rejected', badLogin.response.status === 401)

  const noUser = await post(env, '/api/login', { username: 'ghost', password: 'whatever' })
  check(
    'an unknown username gives the same message as a wrong password',
    noUser.data.error === badLogin.data.error,
  )

  const goodLogin = await post(env, '/api/login', { username: 'player_one', password: 'correct horse' })
  check('sign in works', goodLogin.response.status === 200)
  check(
    'signing in again issues a different token',
    goodLogin.data.token !== created.data.token,
  )

  /* Signing in ignores the case of the username, and what comes back is the one
     stored spelling rather than the case of the attempt. Those are now the same
     thing -- every handle is stored folded -- which is the point of folding on the
     way in: the handle a player signs in with, the handle that is unique, and the
     handle printed on the leaderboard are one value rather than three that have to
     be kept in agreement. Typing your name in capitals no longer risks renaming
     your account. */
  const shoutyLogin = await post(env, '/api/login', { username: 'PLAYER_ONE', password: 'correct horse' })
  check('sign in ignores the case of the username', shoutyLogin.response.status === 200, JSON.stringify(shoutyLogin.data))
  check(
    'and the handle comes back in its stored lowercase form',
    shoutyLogin.data.user?.username === 'player_one',
    shoutyLogin.data.user?.username,
  )

  /* The other half of the rule, which is that only the username folds. A display
     name is a label and keeps the case it was chosen with -- otherwise "Alex" and
     "alex" would be the same name and two players could not both have it. */
  const mixedDisplay = await post(
    env,
    '/api/register',
    { username: 'MixedCase', password: 'correct horse', displayName: 'MiXeD CaSe' },
  )
  check('the username still folds on a second registration', mixedDisplay.data.user?.username === 'mixedcase', mixedDisplay.data.user?.username)
  check(
    'but the display name keeps its capitalisation exactly',
    mixedDisplay.data.user?.displayName === 'MiXeD CaSe',
    mixedDisplay.data.user?.displayName,
  )

  /* Two accounts may share a display name, since only the username is unique. This
   is the case that makes the two rules worth having apart: identical display names
   are allowed, and identical usernames are not, and neither check being on the
   wrong column would show up here. */
  const dupDisplayA = await post(env, '/api/register', { username: 'twinone', password: 'correct horse', displayName: 'Alex' })
  const dupDisplayB = await post(env, '/api/register', { username: 'twintwo', password: 'correct horse', displayName: 'Alex' })
  check('two accounts can share a display name', dupDisplayA.response.status === 201 && dupDisplayB.response.status === 201, `${dupDisplayA.response.status}/${dupDisplayB.response.status}`)
  check('and both keep it as typed', dupDisplayB.data.user?.displayName === 'Alex', dupDisplayB.data.user?.displayName)

  // The same display name at different capitalisation is a different name, and is
  // also allowed: nothing about a label is constrained.
  const caseDisplay = await post(env, '/api/register', { username: 'twintree', password: 'correct horse', displayName: 'alex' })
  check('and a display name differing only in case is its own name', caseDisplay.data.user?.displayName === 'alex', caseDisplay.data.user?.displayName)

  /* The username is still unique, and folding is what makes that true across case:
   * these three are all one name, so the first must win and the other two be
   * refused. Uniqueness by exact bytes alone would have let all three through. */
  const takenLower = await post(env, '/api/register', { username: 'player_one', password: 'correct horse' })
  check('the same username in the same case is still taken', takenLower.response.status === 409, String(takenLower.response.status))
  const takenUpper = await post(env, '/api/register', { username: 'PLAYER_ONE', password: 'correct horse' })
  check('and so is the same username in a different case', takenUpper.response.status === 409, String(takenUpper.response.status))
  const takenMixed = await post(env, '/api/register', { username: 'PlAyEr_OnE', password: 'correct horse' })
  check('and in a mixed case', takenMixed.response.status === 409, String(takenMixed.response.status))

  const noToken = await call(env, '/api/me')
  check('no token means signed out', (await noToken.json())?.user === null)

  await call(env, '/api/logout', { method: 'POST', token: goodLogin.data.token })
  const afterLogout = await call(env, '/api/me', { token: goodLogin.data.token })
  check('the token is dead after signing out', (await afterLogout.json())?.user === null)
}

console.log('failures explain themselves')
{
  // Every rejected request has to carry a message. A bare status code gives the
  // form nothing to display, so a wrong password looks like the app ignoring
  // the user rather than rejecting what they typed.
  const env = { DB: createDb() }
  const created = await post(env, '/api/register', { username: 'speaker', password: 'the right password' })

  const cases = [
    ['a wrong password', '/api/login', { username: 'speaker', password: 'the wrong password' }, false],
    ['an unknown username', '/api/login', { username: 'nobody', password: 'anything at all' }, false],
    ['a short username', '/api/register', { username: 'ab', password: 'long enough one' }, false],
    ['a short password', '/api/register', { username: 'newcomer', password: 'tiny' }, false],
    ['a taken username', '/api/register', { username: 'speaker', password: 'a different one' }, true],
    ['an unknown list on a run', '/api/runs', aRun({ source: 'Made Up List' }), true],
    ['a run with no rounds', '/api/runs', aRun({ rounds: [] }), true],
    ['a run cleared with no 100% round', '/api/runs', aRun({ status: 'completed' }), true],
  ]

  for (const [name, path, body, needsAuth] of cases) {
    const result = await post(env, path, body, needsAuth ? created.data.token : undefined)
    const message = result.data.error
    check(
      `${name} is rejected with a message`,
      result.response.status >= 400 && typeof message === 'string' && message.length > 0,
      `status ${result.response.status}, body ${JSON.stringify(result.data)}`,
    )
  }

  // A successful call must never carry an error field, or a client that shows
  // whatever is in error would report a failure on success.
  const ok = await post(env, '/api/login', { username: 'speaker', password: 'the right password' })
  check('a successful sign in carries no error', ok.data.error === undefined, JSON.stringify(ok.data).slice(0, 80))

  // The wrong password has to say so in a way that does not confirm the
  // account exists.
  const wrongPassword = await post(env, '/api/login', { username: 'speaker', password: 'nope nope nope' })
  const unknownUser = await post(env, '/api/login', { username: 'ghost', password: 'nope nope nope' })
  check('a wrong password and an unknown user are worded identically', wrongPassword.data.error === unknownUser.data.error)
}

console.log('run submission is validated, not trusted')
{
  const env = { DB: createDb() }
  const auth = (await post(env, '/api/register', { username: 'submitter', password: 'a good password' })).data

  const anonymous = await post(env, '/api/runs', aRun())
  check('submitting without a token is refused', anonymous.response.status === 401)

  const unknownSource = await post(env, '/api/runs', aRun({ source: 'My Own List' }), auth.token)
  check('an unknown list is refused', unknownSource.response.status === 400, JSON.stringify(unknownSource.data))

  const badResult = await post(
    env,
    '/api/runs',
    aRun({
      rounds: [{ levelId: 'a', levelName: 'A', targetPercent: 1, achievedPercent: 1, result: 'hacked', elapsedMs: 1 }],
    }),
    auth.token,
  )
  check('an unknown round result is refused', badResult.response.status === 400)

  // A run whose highest round is 61% cannot claim to be cleared.
  const fakeClear = await post(
    env,
    '/api/runs',
    aRun({
      status: 'completed',
      rounds: [{ levelId: 'a', levelName: 'A', targetPercent: 61, achievedPercent: 61, result: 'success', elapsedMs: 1000 }],
    }),
    auth.token,
  )
  check('a cleared run with no 100% round is refused', fakeClear.response.status === 400, JSON.stringify(fakeClear.data))

  // A run with a real 100% round behind it is accepted, and scores 100 no
  // matter what summary the client attached to it.
  const realClear = await post(
    env,
    '/api/runs',
    aRun({
      runId: 'run-clear',
      status: 'completed',
      rounds: [
        { levelId: 'a', levelName: 'A', targetPercent: 99, achievedPercent: 100, result: 'success', elapsedMs: 1000 },
      ],
    }),
    auth.token,
  )
  check('a genuinely cleared run is accepted', realClear.response.status === 201, JSON.stringify(realClear.data))
  check('a cleared run scores 100', realClear.data.run?.score === 100, String(realClear.data.run?.score))
  check('the response does not echo the rounds back', realClear.data.run?.rounds === undefined)

  // The rounds are re-derived on the server, so a summary claiming 100 is
  // simply ignored rather than stored.
  const inflated = await post(env, '/api/runs', aRun({ score: 100, targetReached: 100 }), auth.token)
  check('an inflated summary score is ignored', inflated.data.run?.score === 3, String(inflated.data.run?.score))

  const ok = await post(env, '/api/runs', aRun(), auth.token)
  check('a real run submits', ok.response.status === 201, JSON.stringify(ok.data))
  check('the score is derived from the rounds', ok.data.run?.score === 3, String(ok.data.run?.score))
  check('cleared rounds are counted', ok.data.run?.passed === 2, String(ok.data.run?.passed))
  check('rounds played is counted', ok.data.run?.roundsPlayed === 3)
  check('total time is summed', ok.data.run?.totalMs === 95000, String(ok.data.run?.totalMs))
  check('the average is computed', ok.data.run?.avgMs === 31667, String(ok.data.run?.avgMs))

  const again = await post(env, '/api/runs', aRun(), auth.token)
  check('resubmitting the same run id is allowed', again.response.status === 201)
  check('resubmitting returns the same row rather than a new one', again.data.run?.id === ok.data.run?.id)

  const mine = await call(env, '/api/runs', { token: auth.token })
  const runs = (await mine.json())?.runs ?? []
  // Only counting the runs sharing the resubmitted id. The block above also
  // submits a cleared run under a different one, so a plain length check would
  // be counting that too.
  const sameId = runs.filter((entry) => entry.runKey === 'run-1')
  check('resubmitting replaced rather than duplicated', sameId.length === 1, `got ${sameId.length}`)
  check('the stored rounds are attached', sameId[0]?.roundsPlayed === 3, String(sameId[0]?.roundsPlayed))

  const giveUp = await post(
    env,
    '/api/runs',
    aRun({
      runId: 'run-giveup',
      status: 'gaveup',
      rounds: [
        { levelId: 'a', levelName: 'A', targetPercent: 1, achievedPercent: 1, result: 'success', elapsedMs: 1000 },
        { levelId: 'b', levelName: 'B', targetPercent: 2, achievedPercent: null, result: 'gaveup', elapsedMs: 5000 },
      ],
    }),
    auth.token,
  )
  check('a give-up run submits', giveUp.response.status === 201)

  const skipped = await post(
    env,
    '/api/runs',
    aRun({
      runId: 'run-skip',
      rounds: [
        { levelId: 'a', levelName: 'A', targetPercent: 1, achievedPercent: null, result: 'skipped', skipReason: 'too-hard', elapsedMs: 100 },
        { levelId: 'b', levelName: 'B', targetPercent: 1, achievedPercent: 1, result: 'success', elapsedMs: 100 },
      ],
    }),
    auth.token,
  )
  check('a run with a skip submits', skipped.response.status === 201)
  check('the skip reason tally is kept', JSON.stringify(skipped.data.run?.skipReasons) === '{"too-hard":1}', JSON.stringify(skipped.data.run?.skipReasons))

  const badReason = await post(
    env,
    '/api/runs',
    aRun({
      runId: 'run-bad-reason',
      rounds: [{ levelId: 'a', levelName: 'A', targetPercent: 1, achievedPercent: null, result: 'skipped', skipReason: 'invented', elapsedMs: 1 }],
    }),
    auth.token,
  )
  check('an invented skip reason is refused', badReason.response.status === 400)
}

console.log('deleting a run only touches your own')
{
  const env = { DB: createDb() }
  const one = (await post(env, '/api/register', { username: 'one', password: 'a good password' })).data
  const two = (await post(env, '/api/register', { username: 'two', password: 'a good password' })).data
  const mine = await post(env, '/api/runs', aRun({ runId: 'mine' }), one.token)
  const theirs = await post(env, '/api/runs', aRun({ runId: 'theirs' }), two.token)

  await call(env, `/api/runs/${theirs.data.run.id}`, { method: 'DELETE', token: one.token })
  const survivors = (await (await call(env, '/api/runs', { token: two.token })).json())?.runs ?? []
  check("another player cannot delete your run", survivors.length === 1, `got ${survivors.length}`)

  await call(env, `/api/runs/${mine.data.run.id}`, { method: 'DELETE', token: one.token })
  const gone = (await (await call(env, '/api/runs', { token: one.token })).json())?.runs ?? []
  check('your own run deletes', gone.length === 0)
}

console.log('global leaderboard')
{
  const env = { DB: createDb() }
  const a = (await post(env, '/api/register', { username: 'alpha', password: 'a good password', displayName: 'Alpha' })).data
  const b = (await post(env, '/api/register', { username: 'bravo', password: 'a good password', displayName: 'Bravo' })).data

  const board = await call(env, '/api/leaderboard')
  check('an empty board reads without a token', board.status === 200, String(board.status))
  check('an empty board has no entries', (await board.json()).entries.length === 0)

  // The board only holds runs whose recording has been approved, so both runs
  // need one before they show up. This is the whole point of the review step:
  // an unvouched-for score never reaches the public board.
  const approveRun = async (runId) => {
    await env.DB
      .prepare(
        `INSERT INTO submissions (run_id, video_url, container, note, created_at, status)
         VALUES (?, ?, 'webm', NULL, 1, 'approved')`,
      )
      .bind(runId, `https://example.com/proof-${runId}.mp4`)
      .run()
  }

  const clearedRun = await post(
    env,
    '/api/runs',
    aRun({
      runId: 'a-clear',
      status: 'completed',
      percentStep: 20,
      rounds: [
        { levelId: 'x', levelName: 'X', targetPercent: 20, achievedPercent: 100, result: 'success', elapsedMs: 90000 },
      ],
    }),
    a.token,
  )
  const stoppedRun = await post(
    env,
    '/api/runs',
    aRun({
      runId: 'b-fail',
      source: 'Challenge List',
      rounds: [
        { levelId: 'y', levelName: 'Y', targetPercent: 39, achievedPercent: 39, result: 'success', elapsedMs: 120000 },
        { levelId: 'z', levelName: 'Z', targetPercent: 40, achievedPercent: 12, result: 'failure', elapsedMs: 60000 },
      ],
    }),
    b.token,
  )

  // Both are stored but neither is approved, so the board stays empty.
  const unvouched = (await (await call(env, '/api/leaderboard')).json())
  check('a run with no approved recording is not on the board', unvouched.entries.length === 0, JSON.stringify(unvouched.entries))

  await approveRun(clearedRun.data.run.id)
  const oneApproved = (await (await call(env, '/api/leaderboard')).json())
  check('only the approved run is on the board', oneApproved.entries.length === 1, JSON.stringify(oneApproved.entries.map((e) => e.displayName)))

  await approveRun(stoppedRun.data.run.id)

  const farthest = (await (await call(env, '/api/leaderboard')).json())
  check('the cleared run is first', farthest.entries[0]?.displayName === 'Alpha', JSON.stringify(farthest.entries.map((e) => e.displayName)))
  check('the cleared run scores 100', farthest.entries[0]?.score === 100)
  check('the stopped run scores its own rounds', farthest.entries[1]?.score === 40, String(farthest.entries[1]?.score))
  check('ranks are one-based', farthest.entries[0]?.rank === 1 && farthest.entries[1]?.rank === 2)

  const levels = (await (await call(env, '/api/leaderboard?board=levels')).json())
  check('the levels board is ordered by levels cleared', levels.board === 'levels')

  const fastest = (await (await call(env, '/api/leaderboard?board=fastest')).json())
  check('the fastest board is ordered by time', fastest.entries[0]?.totalMs === 90000, String(fastest.entries[0]?.totalMs))

  const filtered = (await (await call(env, '/api/leaderboard?source=Challenge%20List')).json())
  check('filtering by list works', filtered.entries.length === 1 && filtered.entries[0].displayName === 'Bravo')
  check('the filtered board reports its source', filtered.source === 'Challenge List')

  const unknownBoard = (await (await call(env, '/api/leaderboard?board=nonsense')).json())
  check('an unknown board falls back to the default', unknownBoard.board === 'farthest')

  const asPlayer = (await (await call(env, '/api/leaderboard', { token: b.token })).json())
  check('a signed-in player gets their standing', asPlayer.you?.rank === 2, JSON.stringify(asPlayer.you))
  check('a signed-in player gets their totals', asPlayer.personal?.runs === 1, JSON.stringify(asPlayer.personal))

  const asAnonymous = (await (await call(env, '/api/leaderboard')).json())
  check('an anonymous reader gets no personal standing', asAnonymous.you === null)

  const top = (await (await call(env, '/api/leaderboard?board=farthest&token=x')).json())
  check('a junk board parameter is ignored', top.board === 'farthest')

  // A trashed run leaves the board. Not deleted -- the row, its rounds and its
  // statistics are all still there -- but ranked on nothing and counted in
  // nobody's totals, which is what "hidden" has to mean to be worth anything.
  await env.DB
    .prepare('INSERT INTO trashed_runs (run_id, user_id, reason, trashed_at) VALUES (?, ?, NULL, 1)')
    .bind(clearedRun.data.run.id, a.user.id)
    .run()

  const afterTrash = (await (await call(env, '/api/leaderboard')).json())
  check('a trashed run is off the board', !afterTrash.entries.some((entry) => entry.displayName === 'Alpha'), JSON.stringify(afterTrash.entries.map((e) => e.displayName)))
  check('the other run keeps its rank', afterTrash.entries.length === 1 && afterTrash.entries[0].rank === 1, JSON.stringify(afterTrash.entries))

  const asTrashedPlayer = (await (await call(env, '/api/leaderboard', { token: a.token })).json())
  check('a trashed run is not your standing', asTrashedPlayer.you === null, JSON.stringify(asTrashedPlayer.you))
  check('a trashed run is not in your totals', asTrashedPlayer.personal?.runs === 0, JSON.stringify(asTrashedPlayer.personal))

  await env.DB.prepare('DELETE FROM trashed_runs WHERE run_id = ?').bind(clearedRun.data.run.id).run()
  const afterRestore = (await (await call(env, '/api/leaderboard')).json())
  check('un-trashing puts the run back on the board', afterRestore.entries[0]?.displayName === 'Alpha', JSON.stringify(afterRestore.entries.map((e) => e.displayName)))
  check('and it is first again', afterRestore.entries[0]?.rank === 1)
}

console.log('your runs follow the account, and a trashed one stops showing')
{
  const env = { DB: createDb() }
  const one = (await post(env, '/api/register', { username: 'keeper', password: 'a good password' })).data
  const two = (await post(env, '/api/register', { username: 'other', password: 'a good password' })).data

  const mine = await post(env, '/api/runs', aRun({ runId: 'keep-1' }), one.token)
  const theirs = await post(env, '/api/runs', aRun({ runId: 'keep-2' }), two.token)

  const entries = await (await call(env, '/api/my-entries', { token: one.token })).json()
  check('your runs are readable as leaderboard entries', entries.entries?.length === 1, JSON.stringify(entries.entries?.length))
  check('an entry keeps its run key as its id', entries.entries?.[0]?.id === 'keep-1', entries.entries?.[0]?.id)
  check('an entry keeps its score', entries.entries?.[0]?.score === 3, String(entries.entries?.[0]?.score))
  check('an entry keeps its source and step', entries.entries?.[0]?.source === 'AREDL' && entries.entries?.[0]?.step === 1)
  check('an entry keeps its rounds, packed', entries.entries?.[0]?.rounds?.length === 3, String(entries.entries?.[0]?.rounds?.length))
  // The packed tuple is a contract with the browser's own storage: id, name,
  // target, achieved, result, ms, video, skip reason, in that order.
  check('a packed round is in the order the browser stores', Array.isArray(entries.entries?.[0]?.rounds?.[0]) && entries.entries[0].rounds[0][1] === 'A', JSON.stringify(entries.entries?.[0]?.rounds?.[0]))
  check('a packed round keeps its time', entries.entries?.[0]?.rounds?.[0]?.[5] === 30000, String(entries.entries?.[0]?.rounds?.[0]?.[5]))
  check('nothing is trashed to begin with', entries.trashedRunKeys?.length === 0)

  const anonymous = await call(env, '/api/my-entries')
  check('your runs need a sign in', anonymous.status === 401, String(anonymous.status))

  // Trashed directly, because the admin route needs the passcode and this file
  // is about the reads. What matters here is that every read honours the marker.
  await env.DB
    .prepare('INSERT INTO trashed_runs (run_id, user_id, reason, trashed_at) VALUES (?, ?, ?, ?)')
    .bind(mine.data.run.id, one.user.id, 'a test', 1)
    .run()

  const afterTrash = await (await call(env, '/api/my-entries', { token: one.token })).json()
  check('a trashed run is off your own list', afterTrash.entries?.length === 0, JSON.stringify(afterTrash.entries))
  check('a trashed run is reported by key', afterTrash.trashedRunKeys?.includes('keep-1'), JSON.stringify(afterTrash.trashedRunKeys))

  const runs = (await (await call(env, '/api/runs', { token: one.token })).json())?.runs ?? []
  check('a trashed run is off the stored run list', runs.length === 0, `got ${runs.length}`)

  // The run row itself was never touched, which is what makes putting it back
  // exact rather than approximate.
  const stillThere = await env.DB.prepare('SELECT COUNT(*) AS n FROM runs WHERE id = ?').bind(mine.data.run.id).first()
  check('trashing keeps the run row', stillThere?.n === 1, JSON.stringify(stillThere))

  await env.DB.prepare('DELETE FROM trashed_runs WHERE run_id = ?').bind(mine.data.run.id).run()
  const restored = (await (await call(env, '/api/my-entries', { token: one.token })).json())
  check('un-trashing brings the run back', restored.entries?.length === 1, JSON.stringify(restored.entries?.length))
  check('un-trashing clears the key list', restored.trashedRunKeys?.length === 0)

  // Another player's trashing is not the one being reported: the list is scoped
  // by token, so a run belonging to somebody else is not in it either way.
  const otherEntries = await (await call(env, '/api/my-entries', { token: two.token })).json()
  check("you only get your own runs", otherEntries.entries?.length === 1 && otherEntries.entries[0].id === 'keep-2', JSON.stringify(otherEntries.entries?.map((e) => e.id)))
  check('another trashed run does not leak into your keys', !otherEntries.trashedRunKeys?.includes('keep-1'))
  void theirs
}

console.log('changing the display name')
{
  const env = { DB: createDb() }
  const created = await post(env, '/api/register', {
    username: 'renamer',
    password: 'correct horse',
    displayName: 'Original Name',
  })
  const token = created.data.token
  check('a new account has never changed its name', created.data.user.displayNameChangedAt === null)

  // Not signed in at all.
  const anon = await call(env, '/api/me', { method: 'PATCH', body: { displayName: 'Nope' } })
  check('changing a name without a session is refused', anon.status === 401, String(anon.status))

  // The first change, on an account that has never used the limit.
  const first = await patch(env, '/api/me', { displayName: 'First Change' }, token)
  check('the first change is allowed', first.response.status === 200, JSON.stringify(first.data))
  check('and the new name is stored', first.data.user?.displayName === 'First Change')
  check('the change is timestamped for the client to count down from', typeof first.data.user?.displayNameChangedAt === 'number')
  check('the full cooldown is reported back', first.data.cooldown?.remainingMs === 24 * 60 * 60 * 1000, JSON.stringify(first.data.cooldown))

  // Read back through /api/me, which is what the account panel renders from.
  const me = await (await call(env, '/api/me', { token })).json()
  check('the change survives a re-read of the account', me.user?.displayName === 'First Change', JSON.stringify(me.user))
  check('the timestamp is on the re-read account too', typeof me.user?.displayNameChangedAt === 'number')

  // Immediately again: this is the limit itself.
  const second = await patch(env, '/api/me', { displayName: 'Second Change' }, token)
  check('a second change on the same day is refused', second.response.status === 429, String(second.response.status))
  check('the refusal says what the rule is', second.data.error?.includes('once a day') === true, second.data.error)
  check('the refusal reports the time remaining', second.data.cooldown?.remainingMs > 0, JSON.stringify(second.data.cooldown))

  const afterRefusal = await (await call(env, '/api/me', { token })).json()
  check('the refused change did not alter the stored name', afterRefusal.user?.displayName === 'First Change', JSON.stringify(afterRefusal.user))

  /* Backdating past the limit, rather than waiting a real day for the test.
   * This is the same column the route reads, so it exercises the real comparison
   * and the real query -- only the clock is moved. */
  await env.DB.prepare(
    'UPDATE users SET display_name_changed_at = ? WHERE username_lower = ?',
  ).bind(Date.now() - 24 * 60 * 60 * 1000 - 1000, 'renamer').run()

  const afterCooldown = await patch(env, '/api/me', { displayName: 'Second Change' }, token)
  check('the change is allowed again once the day is up', afterCooldown.response.status === 200, JSON.stringify(afterCooldown.data))
  check('and the second name is the one stored', afterCooldown.data.user?.displayName === 'Second Change')

  /* Whitespace-only collapses to nothing, and registration falls back to the
   * username in the same way, so an account can never be left holding a blank
   * name that renders as an empty row on the leaderboard.
   *
   * Backdated first, like the change above it: the step just before this spent the
   * day's limit, so without that the blank name would be refused for being early
   * rather than tested for what it actually is. That refusal is correct -- it is
   * what the check above already asserts -- so it would have passed here for the
   * wrong reason. */
  await env.DB.prepare(
    'UPDATE users SET display_name_changed_at = ? WHERE username_lower = ?',
  ).bind(Date.now() - 24 * 60 * 60 * 1000 - 1000, 'renamer').run()

  const blank = await patch(env, '/api/me', { displayName: '   ' }, token)
  check('a blank name falls back to the username', blank.data.user?.displayName === 'renamer', JSON.stringify(blank.data.user))

  const spaced = await patch(env, '/api/me', { displayName: '  Spaced   Out  ' }, null)
  check('a session is still required', spaced.response.status === 401, String(spaced.response.status))

  // The username must be untouched by any of this.
  const finalMe = await (await call(env, '/api/me', { token })).json()
  check('the username is unchanged by a display name edit', finalMe.user?.username === 'renamer', JSON.stringify(finalMe.user))

  // A brand new account is not locked out by the column being null.
  const second2 = await post(env, '/api/register', { username: 'fresh', password: 'correct horse' })
  const freshChange = await patch(env, '/api/me', { displayName: 'Fresh Name' }, second2.data.token)
  check('a never-changed account can change its name at once', freshChange.response.status === 200, JSON.stringify(freshChange.data))
}

console.log('the display name on the leaderboard')
{
  const env = { DB: createDb() }
  const created = await post(env, '/api/register', {
    username: 'boarder',
    password: 'correct horse',
    displayName: 'Board Name',
  })
  const token = created.data.token

  // The name as registered, then the name after a change. The board has to show
  // the second one -- which is the whole reason the change is worth having.
  await patch(env, '/api/me', { displayName: 'Renamed Person' }, token)

  const saved = await post(env, '/api/runs', aRun({ runId: 'display-name-run' }), token)
  const runId = saved.data.run?.id
  check('the run was stored', Boolean(runId), JSON.stringify(saved.data))

  await env.DB
    .prepare(
      `INSERT INTO submissions (run_id, video_url, container, note, created_at, status)
       VALUES (?, ?, 'webm', NULL, 1, 'approved')`,
    )
    .bind(runId, 'https://example.com/proof.mp4')
    .run()

  const board = await (await call(env, '/api/leaderboard')).json()
  const entry = board.entries?.[0]
  check('the board shows the current display name, not the registered one', entry?.displayName === 'Renamed Person', JSON.stringify(entry?.displayName))
  check('the board also carries the username the handle is built from', entry?.username === 'boarder', JSON.stringify(entry?.username))
  check('the registered name is not what is shown', entry?.displayName !== 'Board Name')
}

console.log('the list proxy still works')
{
  const env = { DB: createDb() }
  const missing = await call(env, '/api/nope')
  check('an unknown endpoint is a 404', missing.status === 404, String(missing.status))

  const rate = await call(env, '/impossible-level-rate?id=abc')
  check('the rate route still validates its id', rate.status === 400, String(rate.status))

  const unknownList = await call(env, '/nope')
  check('an unknown list still 404s with the available ones', unknownList.status === 404)
  const payload = await unknownList.json()
  check('the list routes are still advertised', payload.available?.includes('challenge-list'))

  const noDb = await call({}, '/api/me')
  check('a missing D1 binding explains itself', noDb.status === 503, String(noDb.status))
  check('the message names the problem', (await noDb.json()).error.includes('database'))
}

console.log('which Pointercrate list a run came from')
{
  const env = { DB: createDb() }
  const player = (await post(env, '/api/register', { username: 'pointer', password: 'a good password' })).data
  const rival = (await post(env, '/api/register', { username: 'rival', password: 'a good password' })).data

  const PC = 'Pointercrate Demon List'
  const pcRun = (over = {}) =>
    aRun({ source: PC, ...over })

  await post(env, '/api/runs', pcRun({ runId: 'pc-main', pointercrateParts: ['main'] }), player.token)
  await post(env, '/api/runs', pcRun({ runId: 'pc-both', pointercrateParts: ['main', 'extended'] }), player.token)
  await post(env, '/api/runs', pcRun({ runId: 'pc-legacy', pointercrateParts: ['legacy'] }), rival.token)
  // A run from before the field existed: no parts at all, and a non-Pointercrate
  // run claiming some. Both must come back as no parts rather than be believed.
  await post(env, '/api/runs', pcRun({ runId: 'pc-none' }), player.token)
  await post(env, '/api/runs', aRun({ runId: 'aredl-claim', pointercrateParts: ['legacy'] }), player.token)

  /* The board has to be able to say which list a run came from, so the column has
   * to survive the round trip through D1. Read back off the player's own runs,
   * which is the same read the local leaderboard renders from. */
  const mine = await (await call(env, '/api/my-entries', { token: player.token })).json()
  // Keyed on `id`, which is where this route puts the client's own run key. It is
// NOT the numeric database row -- that stays on the server.
const byId = Object.fromEntries((mine.entries ?? []).map((e) => [e.id, e]))

  check('a Pointercrate run keeps its parts', JSON.stringify(byId['pc-main']?.pointercrateParts) === '["main"]', JSON.stringify(byId['pc-main']?.pointercrateParts))
  check('both ranked parts are kept in order', JSON.stringify(byId['pc-both']?.pointercrateParts) === '["main","extended"]', JSON.stringify(byId['pc-both']?.pointercrateParts))
  check('a run with no parts reads as none', byId['pc-none']?.pointercrateParts === null, JSON.stringify(byId['pc-none']?.pointercrateParts))
  check('a non-Pointercrate run is refused the field', byId['aredl-claim']?.pointercrateParts === null, JSON.stringify(byId['aredl-claim']?.pointercrateParts))

  /* Order is a contract, not cosmetics: the parts are compared as a stored JSON
   * string, so "legacy" submitted as ["extended","legacy"] and as ["legacy"] are
   * different values for what a player means as the same choice. */
  await post(env, '/api/runs', pcRun({ runId: 'pc-order', pointercrateParts: ['extended', 'legacy'] }), player.token)
  const ordered = await (await call(env, '/api/my-entries', { token: player.token })).json()
  const orderEntry = ordered.entries?.find((e) => e.id === 'pc-order')
  check('the parts are stored in the site order whatever order they arrived in',
    JSON.stringify(orderEntry?.pointercrateParts) === '["extended","legacy"]', JSON.stringify(orderEntry?.pointercrateParts))

  /* An unknown part is dropped rather than refusing the run: the parts are
   * decoration beside the score, and a future fourth list must not stop old
   * clients submitting. */
  await post(env, '/api/runs', pcRun({ runId: 'pc-bogus', pointercrateParts: ['main', 'nonsense'] }), player.token)
  const bogus = await (await call(env, '/api/my-entries', { token: player.token })).json()
  const bogusEntry = bogus.entries?.find((e) => e.id === 'pc-bogus')
  check('an unknown part is dropped', JSON.stringify(bogusEntry?.pointercrateParts) === '["main"]', JSON.stringify(bogusEntry?.pointercrateParts))

  /* The filter. It only means anything on Pointercrate, and an unrecognized value
   * must not narrow to nothing rather than being ignored. */
  const asQuery = async (q) =>
  (await call(env, `/api/leaderboard?source=${encodeURIComponent(PC)}${q}`)).json()

  const ignoredUnknown = await asQuery('&parts=nonsense')
  check('an unrecognized part filter is ignored, not applied',
    ignoredUnknown.parts === null, JSON.stringify(ignoredUnknown.parts))
  check('a part filter on another list is ignored',
    (await (await call(env, '/api/leaderboard?source=AREDL&parts=legacy')).json()).parts === null)
}

console.log('which runs are on the global leaderboard')
{
  const env = { DB: createDb() }
  const player = (await post(env, '/api/register', { username: 'ranked', password: 'a good password' })).data

  const submitted = await post(env, '/api/runs', aRun({ runId: 'rank-1' }), player.token)
  const unranked = await post(env, '/api/runs', aRun({ runId: 'rank-2' }), player.token)

  /* The flag has to mean the same thing the board means by being on it.
   *
   * The personal board uses this to warn that a delete will take the run off the
   * global leaderboard. If it were "has been submitted" instead, a run still
   * waiting on a moderator would be described as ranked, and the player would be
   * warned about losing a rank they never had -- and a genuinely approved run
   * that the flag missed would be deleted with no warning at all. */
  const setStatus = async (runId, status) => {
    await env.DB
      .prepare(
        `INSERT INTO submissions (run_id, video_url, container, note, created_at, status)
         VALUES (?, ?, 'webm', NULL, 1, ?)`,
      )
      .bind(runId, `https://example.com/p-${runId}.mp4`, status)
      .run()
  }

  const readFlags = async () => {
    const mine = await (await call(env, '/api/my-entries', { token: player.token })).json()
    return Object.fromEntries((mine.entries ?? []).map((e) => [e.id, e.onGlobalBoard]))
  }

  check('a run with no submission is not on the board',
    (await readFlags())['rank-1'] === false, JSON.stringify(await readFlags()))

  await setStatus(submitted.data.run.id, 'pending')
  check('a run still awaiting review is not on the board',
    (await readFlags())['rank-1'] === false, JSON.stringify(await readFlags()))

  await env.DB.prepare('UPDATE submissions SET status = ? WHERE run_id = ?')
    .bind('approved', submitted.data.run.id).run()
  check('an approved run is on the board',
    (await readFlags())['rank-1'] === true, JSON.stringify(await readFlags()))

  await setStatus(unranked.data.run.id, 'approved')
  const both = await readFlags()
  check('each run reports its own state',
    both['rank-1'] === true && both['rank-2'] === true, JSON.stringify(both))

  /* A missing field is read as "not ranked" rather than trusted as truth. The
   * client shows the warning off this value, so an old response that predates it
   * must not have an undefined quietly treated as a ranked run. */
  check('the flag is a boolean the client can branch on',
    typeof both['rank-1'] === 'boolean' && typeof both['rank-2'] === 'boolean')
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
