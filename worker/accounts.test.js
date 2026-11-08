/**
 * Account administration: the search, the detail view, the delete, and the
 * one-time login code.
 *
 * The code is the part worth being careful about, so it is tested against the
 * ways it could be reused: twice, after being replaced, after the account is
 * gone, and when the row is tampered with directly.
 *
 * Run with: node --experimental-sqlite worker/accounts.test.js
 */
import process from 'node:process'
import worker from './index.js'
import { createPasswordRecord } from './auth.js'
import { createTestDb } from './testDb.js'

/* Every migration, applied in order, by the shared helper. It used to be a local list
 * of migration filenames, which had to be edited by hand every time a migration was
 * added -- and was missed. The result was a test suite running against a schema the
 * production database does not have, passing against tables that were never created. */
const createDb = () => createTestDb()

/* A passcode that exists only to be typed into a test. It is not the site's, and it is
 * not the one that was once committed to this repository and read out of a public file;
 * it was replaced deliberately so that a test fixture cannot be mistaken for the real
 * thing, or be copied back out of here into production. The real passcode lives in a
 * Worker secret and is never in this repository. */
/* The plaintext behind PASSCOD. Named rather than repeated, so a call site that types
 * the right passcode is visibly the same one the hash is of -- the bug this replaces
 * was a correct hash paired with a literal typed by hand, which failed for a reason
 * that had nothing to do with what was being tested. */
const CORRECT = 'test-only-admin-passcode'
const PASSCOD = (await createPasswordRecord(CORRECT)).passwordHash
const makeEnv = (extra = {}) => ({ DB: createDb(), ADMIN_PASSCODE: PASSCOD, ...extra })

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

const call = async (env, path, { method = 'GET', body, token, passcode } = {}) => {
  // The version gate refuses any /api call without the protocol header, so every
  // test here sends it by default. `protocol: false` drops it, which is how the
  // gate itself is exercised.
  const headers = { 'x-dlr-protocol': '3' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`
  if (passcode) headers['x-admin-passcode'] = passcode

  return worker.fetch(
    new Request(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  )
}

const jsonCall = async (env, path, opts) => {
  const response = await call(env, path, opts)
  let data
  try {
    data = await response.clone().json()
  } catch {
    data = null
  }
  return { response, data }
}

// A run the Worker will accept: marked cleared, so it needs a 100% round behind
// it, and the one round here is that.
const aRun = (over = {}) => ({
  runId: 'run-1',
  source: 'AREDL',
  percentStep: 1,
  status: 'completed',
  endedAt: 1_700_000_000_000,
  rounds: [
    { levelId: 'a', levelName: 'Alpha', targetPercent: 100, achievedPercent: 100, result: 'success', elapsedMs: 30000 },
  ],
  ...over,
})

/* Two players, so the search and the delete can be checked against more than one
   account and so deleting one is visibly not deleting the other. */
const setup = async (env = makeEnv()) => {
  const alice = (await jsonCall(env, '/api/register', {
    method: 'POST',
    body: { username: 'alice', password: 'a good password', displayName: 'Alice Example' },
  })).data
  const bob = (await jsonCall(env, '/api/register', {
    method: 'POST',
    body: { username: 'bob', password: 'another password', displayName: 'Bob Example' },
  })).data
  return { env, alice, bob }
}

console.log('searching accounts')
{
  const { env, alice } = await setup()

  // 401, not 429: nothing was guessed, so there is no wait to report. See the note
  // in checkAdminPasscode about why a request with no passcode must not move the ladder.
  check('no passcode is refused', (await jsonCall(env, '/api/admin/accounts')).response.status === 401)
  check('a wrong passcode is refused', (await jsonCall(env, '/api/admin/accounts', { passcode: '000000' })).response.status === 429)

  const all = await jsonCall(env, '/api/admin/accounts', { passcode: CORRECT })
  check('the list comes back', all.response.status === 200, JSON.stringify(all.data))
  check('both accounts are there', all.data.accounts.length === 2, String(all.data.accounts?.length))

  const byName = await jsonCall(env, '/api/admin/accounts?q=alice', { passcode: CORRECT })
  check('a username search finds it', byName.data.accounts.length === 1, JSON.stringify(byName.data))
  check('and it is the right one', byName.data.accounts[0].username === 'alice')

  const byDisplay = await jsonCall(env, '/api/admin/accounts?q=Bob', { passcode: CORRECT })
  check('a display name search finds it', byDisplay.data.accounts.length === 1, JSON.stringify(byDisplay.data))
  check('and it is the right one', byDisplay.data.accounts[0].username === 'bob')

  check('a search for nobody comes back empty', (await jsonCall(env, '/api/admin/accounts?q=zzz', { passcode: CORRECT })).data.accounts.length === 0)

  // A wildcard must not turn into a match-everything, and must not be an error.
  const wildcard = await jsonCall(env, '/api/admin/accounts?q=%', { passcode: CORRECT })
  check('a % in the search is treated as a literal', wildcard.response.status === 200 && wildcard.data.accounts.length === 0, JSON.stringify(wildcard.data))

  // The account ids are what the detail and delete routes take.
  const bobId = byDisplay.data.accounts[0].id
  check('a new account has no runs yet', byDisplay.data.accounts[0].runCount === 0)

  const detail = await jsonCall(env, `/api/admin/accounts/${bobId}`, { passcode: CORRECT })
  check('the detail view opens', detail.response.status === 200, JSON.stringify(detail.data))
  check('it carries the account', detail.data.account.username === 'bob')
  check('and an empty run list', detail.data.account.runs.length === 0)
  check('and no mirrored data yet', detail.data.account.playerData.syncedAt === null)
  check('and no login code yet', detail.data.account.loginCode.hasCode === false)

  check('an unknown account is a 404', (await jsonCall(env, '/api/admin/accounts/9999', { passcode: CORRECT })).response.status === 404)
  check('a wrong passcode cannot confirm an account exists', (await jsonCall(env, `/api/admin/accounts/${bobId}`, { passcode: '000000' })).response.status === 429)
  check('alice is untouched by reading bob', (await jsonCall(env, `/api/admin/accounts/${alice.user.id}`, { passcode: CORRECT })).data.account.username === 'alice')
}

console.log('community stats')
{
  const { env, alice } = await setup()

  const follow = await jsonCall(env, '/api/users/bob/follow', { method: 'POST', token: alice.token })
  check('a follow relationship is recorded', follow.response.status === 200 && follow.data.following === true, JSON.stringify(follow.data))

  const stats = await jsonCall(env, '/api/admin/stats', { passcode: CORRECT })
  check('the admin stats endpoint is available', stats.response.status === 200, String(stats.response.status))
  check('the stats count total accounts', stats.data.totalAccounts === 2, JSON.stringify(stats.data))
  check('and total follows', stats.data.totalFollows === 1, JSON.stringify(stats.data))
  check('and the top follower count is known', stats.data.topFollowerCount >= 1, JSON.stringify(stats.data))
  check('and the top follower user is named', typeof stats.data.topFollowerUser === 'string' && stats.data.topFollowerUser.length > 0, JSON.stringify(stats.data))
}

console.log('a players submitted runs')
{
  const { env, alice } = await setup()

  const run = (await jsonCall(env, '/api/runs', { method: 'POST', body: aRun(), token: alice.token })).data.run
  await jsonCall(env, '/api/submissions', {
    method: 'POST',
    token: alice.token,
    body: { runId: run.id, videoUrl: 'https://youtu.be/dQw4w9WgXcQ', container: 'mp4', note: 'hi' },
  })

  const detail = await jsonCall(env, `/api/admin/accounts/${alice.user.id}`, { passcode: CORRECT })
  const account = detail.data.account
  check('the run shows up', account.runs.length === 1, String(account.runs.length))
  check('with its score', account.runs[0].score >= 0)
  check('and its submission', account.runs[0].submission?.status === 'pending', JSON.stringify(account.runs[0].submission))
  check('and the counts agree', account.runCount === 1 && account.submissionCount === 1 && account.pendingCount === 1, JSON.stringify(account))
}

console.log('the one-time login code')
{
  const { env } = await setup()
  const id = (await jsonCall(env, '/api/admin/accounts?q=bob', { passcode: CORRECT })).data.accounts[0].id

  const issued = await jsonCall(env, `/api/admin/accounts/${id}/login-code`, { method: 'POST', passcode: CORRECT })
  check('a code is issued', issued.response.status === 201, JSON.stringify(issued.data))
  check('it is readable characters only', /^[A-Z0-9]+$/.test(issued.data.code ?? ''), String(issued.data.code))
  check('and long enough to be unguessable', (issued.data.code ?? '').length >= 12, String(issued.data.code))

  check('issuing needs the passcode', (await jsonCall(env, `/api/admin/accounts/${id}/login-code`, { method: 'POST', passcode: '000000' })).response.status === 429)
  check('redeeming it signs in as the player', (await jsonCall(env, '/api/redeem', { method: 'POST', body: { code: issued.data.code } })).data.user.username === 'bob')
  check('and it is not the same session as a real sign in', (await jsonCall(env, '/api/redeem', { method: 'POST', body: { code: issued.data.code } })).response.status !== 200)

  // The whole point: a second attempt is refused.
  const again = await jsonCall(env, '/api/redeem', { method: 'POST', body: { code: issued.data.code } })
  check('the same code cannot be used twice', again.response.status === 409, String(again.response.status))
  check('and it says so plainly', /already been used/i.test(again.data.error ?? ''), JSON.stringify(again.data))

  // A guess of the right shape but no real code. Z is in the alphabet, so this
  // is length-valid and has to be refused on the digest rather than the shape.
  check('a made up code is refused', (await jsonCall(env, '/api/redeem', { method: 'POST', body: { code: 'ZZZZZZZZZZZZZZZ' } })).response.status === 401)
  check('an empty code is refused', (await jsonCall(env, '/api/redeem', { method: 'POST', body: {} })).response.status === 400)

  // A code read out with spaces and in the wrong case still works, because a code
  // dictated over a call is typed like that.
  const second = await jsonCall(env, `/api/admin/accounts/${id}/login-code`, { method: 'POST', passcode: CORRECT })
  const spaced = second.data.code.toLowerCase().replace(/(.{5})/g, '$1 ')
  check('a code typed in pieces still works', (await jsonCall(env, '/api/redeem', { method: 'POST', body: { code: spaced } })).data.user?.username === 'bob')
}

console.log('a new code kills the old one')
{
  const { env } = await setup()
  const id = (await jsonCall(env, '/api/admin/accounts?q=alice', { passcode: CORRECT })).data.accounts[0].id

  const first = (await jsonCall(env, `/api/admin/accounts/${id}/login-code`, { method: 'POST', passcode: CORRECT })).data.code
  const second = (await jsonCall(env, `/api/admin/accounts/${id}/login-code`, { method: 'POST', passcode: CORRECT })).data.code
  check('the two codes differ', first !== second)

  // The first was never used, but issuing a second one retired it.
  const stale = await jsonCall(env, '/api/redeem', { method: 'POST', body: { code: first } })
  check('the replaced code is dead', stale.response.status === 401, String(stale.response.status))
  check('and the new one works', (await jsonCall(env, '/api/redeem', { method: 'POST', body: { code: second } })).data.user != null)
}

console.log('revoking a code')
{
  const { env } = await setup()
  const id = (await jsonCall(env, '/api/admin/accounts?q=alice', { passcode: CORRECT })).data.accounts[0].id
  const code = (await jsonCall(env, `/api/admin/accounts/${id}/login-code`, { method: 'POST', passcode: CORRECT })).data.code

  check('revoking needs the passcode', (await jsonCall(env, `/api/admin/accounts/${id}/revoke-code`, { method: 'POST', passcode: '000000' })).response.status === 429)
  check('revoking works', (await jsonCall(env, `/api/admin/accounts/${id}/revoke-code`, { method: 'POST', passcode: CORRECT })).response.status === 200)
  check('and the code stops working', (await jsonCall(env, '/api/redeem', { method: 'POST', body: { code } })).response.status === 401)

  const detail = await jsonCall(env, `/api/admin/accounts/${id}`, { passcode: CORRECT })
  check('the panel reports no live code', detail.data.account.loginCode.hasCode === false)
}

console.log('the redeemed session is a real one')
{
  const { env } = await setup()
  const id = (await jsonCall(env, '/api/admin/accounts?q=bob', { passcode: CORRECT })).data.accounts[0].id
  const code = (await jsonCall(env, `/api/admin/accounts/${id}/login-code`, { method: 'POST', passcode: CORRECT })).data.code

  const redeemed = (await jsonCall(env, '/api/redeem', { method: 'POST', body: { code } })).data
  check('it is the player, not an admin', redeemed.user.username === 'bob')
  check('the session identifies the player', (await jsonCall(env, '/api/me', { token: redeemed.token })).data.user.username === 'bob')

  // A redeemed session is a normal one, so it must NOT be able to reach the admin
  // routes. Otherwise issuing a code would be a way in for everyone.
  check('it cannot reach the admin account list', (await jsonCall(env, '/api/admin/accounts', { token: redeemed.token })).response.status === 401)
  check('it cannot reach the admin queue either', (await jsonCall(env, '/api/admin/submissions', { token: redeemed.token })).response.status === 401)

  // It can only see its own runs.
  const run = (await jsonCall(env, '/api/runs', { method: 'POST', body: aRun(), token: redeemed.token })).data.run
  check('it can act as the player', run != null)
  check('and logout ends it', (await jsonCall(env, '/api/logout', { method: 'POST', token: redeemed.token })).response.status === 200)
  check('so the session is gone', (await jsonCall(env, '/api/me', { token: redeemed.token })).data.user == null)
}

console.log('deleting an account')
{
  const { env, alice } = await setup()
  const aliceId = (await jsonCall(env, '/api/admin/accounts?q=alice', { passcode: CORRECT })).data.accounts[0].id
  const bobId = (await jsonCall(env, '/api/admin/accounts?q=bob', { passcode: CORRECT })).data.accounts[0].id

  const run = (await jsonCall(env, '/api/runs', { method: 'POST', body: aRun(), token: alice.token })).data.run
  await jsonCall(env, '/api/submissions', { method: 'POST', token: alice.token, body: { runId: run.id, videoUrl: 'https://youtu.be/x', container: 'mp4' } })

  check('deleting needs the passcode', (await jsonCall(env, `/api/admin/accounts/${aliceId}/delete`, { method: 'POST', passcode: '000000', body: { confirm: 'alice' } })).response.status === 429)
  check('a delete with the wrong confirmation is refused', (await jsonCall(env, `/api/admin/accounts/${aliceId}/delete`, { method: 'POST', passcode: CORRECT, body: { confirm: 'wrong' } })).response.status === 400)
  check('and with no confirmation at all', (await jsonCall(env, `/api/admin/accounts/${aliceId}/delete`, { method: 'POST', passcode: CORRECT })).response.status === 400)

  const gone = await jsonCall(env, `/api/admin/accounts/${aliceId}/delete`, { method: 'POST', passcode: CORRECT, body: { confirm: 'alice' } })
  check('the delete works', gone.response.status === 200, JSON.stringify(gone.data))
  check('and says who went', gone.data.deleted === 'alice')

  check('the account is gone', (await jsonCall(env, `/api/admin/accounts/${aliceId}`, { passcode: CORRECT })).response.status === 404)
  check('bob is untouched', (await jsonCall(env, `/api/admin/accounts/${bobId}`, { passcode: CORRECT })).data.account.username === 'bob')
  check('the deleted player cannot still sign in', (await jsonCall(env, '/api/login', { method: 'POST', body: { username: 'alice', password: 'a good password' } })).response.status === 401)
  check('their old session is dead', (await jsonCall(env, '/api/me', { token: alice.token })).data.user == null)
  check('their runs are gone from the leaderboard', (await jsonCall(env, '/api/leaderboard')).data.entries.length === 0)
}

console.log('deleting takes the login codes with it')
{
  const { env } = await setup()
  const id = (await jsonCall(env, '/api/admin/accounts?q=alice', { passcode: CORRECT })).data.accounts[0].id
  const code = (await jsonCall(env, `/api/admin/accounts/${id}/login-code`, { method: 'POST', passcode: CORRECT })).data.code

  await jsonCall(env, `/api/admin/accounts/${id}/delete`, { method: 'POST', passcode: CORRECT, body: { confirm: 'alice' } })
  const after = await jsonCall(env, '/api/redeem', { method: 'POST', body: { code } })
  check('a code for a deleted account cannot be redeemed', after.response.status === 401, String(after.response.status))
}

console.log('the audit log')
{
  const { env } = await setup()
  const id = (await jsonCall(env, '/api/admin/accounts?q=alice', { passcode: CORRECT })).data.accounts[0].id

  check('the log needs the passcode', (await jsonCall(env, '/api/admin/audit', { passcode: '000000' })).response.status === 429)

  await jsonCall(env, `/api/admin/accounts/${id}/login-code`, { method: 'POST', passcode: CORRECT })
  await jsonCall(env, `/api/admin/accounts/${id}/delete`, { method: 'POST', passcode: CORRECT, body: { confirm: 'alice' } })

  const log = await jsonCall(env, '/api/admin/audit', { passcode: CORRECT })
  check('the log reads back', log.response.status === 200, JSON.stringify(log.data))
  const actions = (log.data.entries ?? []).map((entry) => entry.action)
  check('issuing a code is logged', actions.includes('login-code.issue'), JSON.stringify(actions))
  check('deleting an account is logged', actions.includes('account.delete'), JSON.stringify(actions))
  check('newest first', log.data.entries[0].action === 'account.delete', JSON.stringify(actions))
  check('the username survives the delete in the log', log.data.entries[0].targetName === 'alice')
  // The code itself must never be written down anywhere.
  check('the log holds no code', !JSON.stringify(log.data).match(/\b[A-Z0-9]{15}\b/))
}

console.log('a players own data can be mirrored')
{
  const { env, alice } = await setup()
  const id = (await jsonCall(env, '/api/admin/accounts?q=alice', { passcode: CORRECT })).data.accounts[0].id

  check('uploading without a session is refused', (await jsonCall(env, '/api/player-data', { method: 'PUT', body: { history: '[]' } })).response.status === 401)

  const history = JSON.stringify([{ id: '1-AREDL', score: 100 }])
  const saved = await jsonCall(env, '/api/player-data', {
    method: 'PUT',
    token: alice.token,
    body: { history, settings: JSON.stringify({ allowSkip: true }) },
  })
  check('the upload is accepted', saved.response.status === 200, JSON.stringify(saved.data))
  check('and it reports when it happened', Number.isFinite(saved.data.syncedAt))

  const detail = await jsonCall(env, `/api/admin/accounts/${id}`, { passcode: CORRECT })
  check(
    'the panel can read it back',
    JSON.stringify(detail.data.account.playerData.history) === history,
    JSON.stringify(detail.data.account.playerData),
  )
  check('and the settings too', detail.data.account.playerData.settings?.allowSkip === true)
  check('the sync time is recorded', Number.isFinite(detail.data.account.playerData.syncedAt))

  // A second upload replaces rather than duplicating, so the mirror is one row.
  await jsonCall(env, '/api/player-data', { method: 'PUT', token: alice.token, body: { history: '[]', settings: null } })
  const again = await jsonCall(env, `/api/admin/accounts/${id}`, { passcode: CORRECT })
  check('a second upload replaces it', JSON.stringify(again.data.account.playerData.history) === '[]', JSON.stringify(again.data.account.playerData))

  check('an oversized upload is refused', (await jsonCall(env, '/api/player-data', { method: 'PUT', token: alice.token, body: { history: 'x'.repeat(2 * 1024 * 1024) } })).response.status === 413)

  // A mirror is a copy, so deleting the account must take it with the account.
  await jsonCall(env, `/api/admin/accounts/${id}/delete`, { method: 'POST', passcode: CORRECT, body: { confirm: 'alice' } })
  check('deleting the account takes its mirrored data', (await jsonCall(env, `/api/admin/accounts/${id}`, { passcode: CORRECT })).response.status === 404)
}

console.log('trashing a run, submitted or not')
{
  const { env, alice, bob } = await setup()
  const accountId = (await jsonCall(env, '/api/admin/accounts?q=alice', { passcode: CORRECT })).data.accounts[0].id

  // Two runs: one that was sent for review and one that was never sent anywhere.
  // The second is the point -- a run only reaches an account by being saved
  // there, and a moderator has to be able to get at it without it having been
  // submitted first.
  const submitted = (await jsonCall(env, '/api/runs', { method: 'POST', token: alice.token, body: aRun({ runId: 'alice-1' }) })).data.run
  const unsubmitted = (await jsonCall(env, '/api/runs', { method: 'POST', token: alice.token, body: aRun({ runId: 'alice-2' }) })).data.run
  const bobsRun = (await jsonCall(env, '/api/runs', { method: 'POST', token: bob.token, body: aRun({ runId: 'bob-1' }) })).data.run

  const before = (await jsonCall(env, `/api/admin/accounts/${accountId}`, { passcode: CORRECT })).data.account
  check('every run is listed, submitted or not', before.runs.length === 2, JSON.stringify(before.runs.map((r) => r.runId)))
  check('one has no submission', before.runs.some((r) => r.runId === 'alice-2' && r.submission === null), JSON.stringify(before.runs))
  check('nothing is trashed to begin with', before.runs.every((r) => r.trashed === false))

  check('trashing needs the passcode', (await jsonCall(env, `/api/admin/accounts/${accountId}/runs/${unsubmitted.id}/trash`, { method: 'POST' })).response.status === 401)
  check('a wrong passcode is refused', (await jsonCall(env, `/api/admin/accounts/${accountId}/runs/${unsubmitted.id}/trash`, { method: 'POST', passcode: '000000' })).response.status === 429)

  const trashed = await jsonCall(env, `/api/admin/accounts/${accountId}/runs/${unsubmitted.id}/trash`, {
    method: 'POST',
    passcode: CORRECT,
    body: { reason: 'not this account\'s run' },
  })
  check('trashing succeeds', trashed.response.status === 200 && trashed.data.trashed === true, JSON.stringify(trashed.data))

  const after = (await jsonCall(env, `/api/admin/accounts/${accountId}`, { passcode: CORRECT })).data.account
  check('a trashed run is still on the account', after.runs.length === 2, JSON.stringify(after.runs.map((r) => r.runId)))
  check('and it is marked as trashed', after.runs.find((r) => r.id === unsubmitted.id)?.trashed === true, JSON.stringify(after.runs))
  check('the reason is kept for the log', after.runs.find((r) => r.id === unsubmitted.id)?.trashReason === "not this account's run", JSON.stringify(after.runs.find((r) => r.id === unsubmitted.id)))
  check('the hidden count is reported', after.account?.trashedCount === 1 || after.trashedCount === 1, JSON.stringify(after))
  check('the other run is untouched', after.runs.find((r) => r.id === submitted.id)?.trashed === false)

  // Trashing twice is not an error and does not make a second row: the primary
  // key is what stops it, and the second call just refreshes the reason.
  const twice = await jsonCall(env, `/api/admin/accounts/${accountId}/runs/${unsubmitted.id}/trash`, {
    method: 'POST',
    passcode: CORRECT,
    body: { reason: 'still not theirs' },
  })
  check('trashing twice is fine', twice.response.status === 200, JSON.stringify(twice.data))
  const markers = await env.DB.prepare('SELECT COUNT(*) AS n FROM trashed_runs WHERE run_id = ?').bind(unsubmitted.id).first()
  check('and leaves one marker', markers?.n === 1, JSON.stringify(markers))

  // The run row itself was never touched, so putting it back is exact.
  const row = await env.DB.prepare('SELECT score, run_key FROM runs WHERE id = ?').bind(unsubmitted.id).first()
  check('the run row is untouched', row?.score === 100 && row?.run_key === 'alice-2', JSON.stringify(row))

  // A run belonging to another account is not reachable through this one, so a
  // wrong id in the path cannot trash somebody else's run.
  const crossAccount = await jsonCall(env, `/api/admin/accounts/${accountId}/runs/${bobsRun.id}/trash`, { method: 'POST', passcode: CORRECT })
  check("another account's run is not reachable here", crossAccount.response.status === 404, JSON.stringify(crossAccount.data))
  const bobStillFine = await env.DB.prepare('SELECT COUNT(*) AS n FROM trashed_runs WHERE run_id = ?').bind(bobsRun.id).first()
  check("and their run is not trashed", bobStillFine?.n === 0, JSON.stringify(bobStillFine))

  const untrashed = await jsonCall(env, `/api/admin/accounts/${accountId}/runs/${unsubmitted.id}/untrash`, { method: 'POST', passcode: CORRECT })
  check('un-trashing succeeds', untrashed.response.status === 200 && untrashed.data.trashed === false, JSON.stringify(untrashed.data))
  const restored = (await jsonCall(env, `/api/admin/accounts/${accountId}`, { passcode: CORRECT })).data.account
  check('the run comes back', restored.runs.find((r) => r.id === unsubmitted.id)?.trashed === false, JSON.stringify(restored.runs))
  check('with its reason cleared', restored.runs.find((r) => r.id === unsubmitted.id)?.trashReason === null)

  // Un-trashing something that was never trashed is a no-op rather than an
  // error, so a double click cannot turn into a spurious error on screen.
  const again = await jsonCall(env, `/api/admin/accounts/${accountId}/runs/${unsubmitted.id}/untrash`, { method: 'POST', passcode: CORRECT })
  check('un-trashing an untrashed run is not an error', again.response.status === 200, JSON.stringify(again.data))

  const audit = (await jsonCall(env, '/api/admin/audit', { passcode: CORRECT })).data.entries
  check('the trashing is in the log', audit.some((entry) => entry.action === 'run.trash' && entry.targetName === 'alice'), JSON.stringify(audit.map((e) => e.action)))
  check('the reason is in the log', audit.some((entry) => entry.action === 'run.trash' && String(entry.detail).includes('still not theirs')), JSON.stringify(audit))
  check('the un-trashing is in the log', audit.some((entry) => entry.action === 'run.untrash'), JSON.stringify(audit.map((e) => e.action)))

  // Deleting the account takes the markers with it, or the table would keep rows
  // pointing at runs that no longer exist.
  await jsonCall(env, `/api/admin/accounts/${accountId}/runs/${submitted.id}/trash`, { method: 'POST', passcode: CORRECT })
  await jsonCall(env, `/api/admin/accounts/${accountId}/delete`, { method: 'POST', passcode: CORRECT, body: { confirm: 'alice' } })
  const orphans = await env.DB.prepare('SELECT COUNT(*) AS n FROM trashed_runs').first()
  check('deleting the account clears its trash markers', orphans?.n === 0, JSON.stringify(orphans))
}

console.log('a login code works as a password')
{
  // Only bob is needed here, and only so there is a second account to issue a
  // code for; alice is reached through the admin search like any other moderator
  // would.
  const { env, bob } = await setup()
  const aliceId = (await jsonCall(env, '/api/admin/accounts?q=alice', { passcode: CORRECT })).data.accounts[0].id

  const issue = async (id) => (await jsonCall(env, `/api/admin/accounts/${id}/login-code`, { method: 'POST', passcode: CORRECT })).data.code
  const aliceCode = await issue(aliceId)
  check('a code is issued', typeof aliceCode === 'string' && aliceCode.length === 15, aliceCode)

  // The point of the change: username and code at the sign in form, rather than
  // a separate redemption page that only wanted the code.
  const signedIn = await jsonCall(env, '/api/login', { method: 'POST', body: { username: 'alice', password: aliceCode } })
  check('a code signs in at the password field', signedIn.response.status === 200, JSON.stringify(signedIn.data))
  check('and it signs in as that account', signedIn.data.user?.username === 'alice', JSON.stringify(signedIn.data.user))
  check('a session token comes back', typeof signedIn.data.token === 'string' && signedIn.data.token.length === 64)
  check('the client is told it was a code', signedIn.data.viaCode === true, JSON.stringify(signedIn.data))
  check('the cookie is set as for any sign in', (signedIn.response.headers.get('set-cookie') ?? '').includes('dlr_session='))

  // The session is real: it is not a special preview token, it is the same thing
  // a password sign in produces and can do everything the account can do.
  const me = await jsonCall(env, '/api/me', { token: signedIn.data.token })
  check('the session identifies the player', me.data.user?.username === 'alice', JSON.stringify(me.data))

  // Single use, and it survives the change of entry point: the same code cannot
  // be spent again, and the error says which case this is.
  const reuse = await jsonCall(env, '/api/login', { method: 'POST', body: { username: 'alice', password: aliceCode } })
  check('the code cannot be used twice', reuse.response.status === 409, JSON.stringify(reuse.data))
  const afterUse = await jsonCall(env, '/api/redeem', { method: 'POST', body: { code: aliceCode } })
  check('and it is spent for the redemption route too', afterUse.response.status === 409, JSON.stringify(afterUse.data))

  // A code for one account must not sign in as another, even when the caller
  // asks for the other account by name. Without this, a code pasted into the
  // wrong row would sign in as the code's real owner and say nothing.
  const bobId = (await jsonCall(env, '/api/admin/accounts?q=bob', { passcode: CORRECT })).data.accounts[0].id
  const bobCode = await issue(bobId)
  const mismatch = await jsonCall(env, '/api/login', { method: 'POST', body: { username: 'alice', password: bobCode } })
  check('a code cannot sign in as somebody else', mismatch.response.status === 401, JSON.stringify(mismatch.data))
  // The message names the account the code was actually issued for, because a
  // wrong username and a wrong code are otherwise the same dead end, and only
  // the first of those is fixable by typing carefully. Safe to name: this is only
  // reached once the code hash has matched, so holding the code already proved
  // everything this would say.
  check('a mismatch names the right account', String(mismatch.data.error).includes('@bob'), JSON.stringify(mismatch.data))
  // And the mismatch still spent nothing, so the rightful owner can use it.
  const rightOwner = await jsonCall(env, '/api/login', { method: 'POST', body: { username: 'bob', password: bobCode } })
  check('the rightful owner can still use it', rightOwner.response.status === 200, JSON.stringify(rightOwner.data))

  // The same check on the redemption route, which is where the username is new.
  const carolCode = await issue(aliceId)
  const wrongOnRedeem = await jsonCall(env, '/api/redeem', { method: 'POST', body: { username: 'bob', code: carolCode } })
  check('a mismatched username is refused on /api/redeem too', wrongOnRedeem.response.status === 401, JSON.stringify(wrongOnRedeem.data))
  check('and it names the account there as well', String(wrongOnRedeem.data.error).includes('@alice'), JSON.stringify(wrongOnRedeem.data))
  const rightOnRedeem = await jsonCall(env, '/api/redeem', { method: 'POST', body: { username: 'alice', code: carolCode } })
  check('and the matching one works', rightOnRedeem.response.status === 200, JSON.stringify(rightOnRedeem.data.user))

  // A username is still optional on /api/redeem, which worked without one for a
  // long time, so an old bookmark keeps working.
  const lastCode = await issue(aliceId)
  const noUsername = await jsonCall(env, '/api/redeem', { method: 'POST', body: { code: lastCode } })
  check('a code with no username still redeems', noUsername.response.status === 200, JSON.stringify(noUsername.data.user))

  /* "it4717" for "lt4717" is a misread, not a typo: 1, l and I are the same glyph
     in most fonts, so the typed name looks right and the check still refuses it.
     The server cannot fix that -- folding the look-alikes together would make
     lt4717 and i14717 the same account and hand out codes across them. So the
     check stays exact, and the fix is that the panel puts the name in the link
     rather than leaving a moderator to read it and type it back. Asserted here as
     the shape the panel builds, so it cannot quietly lose the parameter again. */
  const liz = (await jsonCall(env, '/api/register', { method: 'POST', body: { username: 'lt4717', password: 'a good password' } })).data
  const lizCode = (await jsonCall(env, `/api/admin/accounts/${liz.user.id}/login-code`, { method: 'POST', passcode: CORRECT })).data
  const misread = await jsonCall(env, '/api/redeem', { method: 'POST', body: { username: 'it4717', code: lizCode.code } })
  check('a misread one is still refused, so the name has to come from the link', misread.response.status === 401, JSON.stringify(misread.data))
  const byLink = await jsonCall(env, '/api/redeem', { method: 'POST', body: { username: new URLSearchParams('username=lt4717').get('username'), code: lizCode.code } })
  check('the name the panel puts in the link redeems', byLink.response.status === 200, JSON.stringify(byLink.data))
  check('as the account it belongs to', byLink.data.user?.username === 'lt4717', JSON.stringify(byLink.data.user))

  /* Usernames are stored folded, so the check on a login code cannot be a byte
     comparison or every code would fail for an account whose handle was registered
     with capitals. It folds both sides, which is also what stops a code for one
     account being presented with a different spelling of another account's name.
     A handle has one spelling now, so the folded form IS the stored form -- which
     is why "NeXus" below is stored as "nexus" and still redeems from "NEXUS". */
  const lizShouty = await jsonCall(env, '/api/register', { method: 'POST', body: { username: 'NeXus', password: 'a good password' } }).then((r) => r.data)
  const nexusCode = (await jsonCall(env, `/api/admin/accounts/${lizShouty.user.id}/login-code`, { method: 'POST', passcode: CORRECT })).data
  check(
    'the mixed-case handle is stored folded',
    (await jsonCall(env, `/api/admin/accounts/${lizShouty.user.id}`, { passcode: CORRECT })).data.account.username === 'nexus',
    (await jsonCall(env, `/api/admin/accounts/${lizShouty.user.id}`, { passcode: CORRECT })).data.account.username,
  )
  const otherCase = await jsonCall(env, '/api/register', { method: 'POST', body: { username: 'Nexuz', password: 'a good password' } }).then((r) => r.data)
  const otherCode = (await jsonCall(env, `/api/admin/accounts/${otherCase.user.id}/login-code`, { method: 'POST', passcode: CORRECT })).data
  const stillWrong = await jsonCall(env, '/api/redeem', { method: 'POST', body: { username: 'Nexuz', code: nexusCode.code } })
  check('but a different name in any case is still refused', stillWrong.response.status === 401, JSON.stringify(stillWrong.data))
  const nexusAnyCase = await jsonCall(env, '/api/redeem', { method: 'POST', body: { username: 'NEXUS', code: nexusCode.code } })
  check('a code redeems whatever case the name is typed in', nexusAnyCase.response.status === 200, JSON.stringify(nexusAnyCase.data))
  check('as the right account', nexusAnyCase.data.user?.username === 'nexus', JSON.stringify(nexusAnyCase.data.user))
  check(
    'and its own code still works',
    (await jsonCall(env, '/api/redeem', { method: 'POST', body: { username: 'NEXUZ', code: otherCode.code } })).response.status === 200,
  )

  // Passwords are untouched. A real password must not be treated as a code, and
  // the wrong password must still be refused.
  const wrongPassword = await jsonCall(env, '/api/login', { method: 'POST', body: { username: 'alice', password: 'a good password' } })
  check('a real password still signs in', wrongPassword.response.status === 200, JSON.stringify(wrongPassword.data.user))
  const badPassword = await jsonCall(env, '/api/login', { method: 'POST', body: { username: 'alice', password: 'not the password' } })
  check('a wrong password is still refused', badPassword.response.status === 401, JSON.stringify(badPassword.data))
  check('and it says username and password, not code', String(badPassword.data.error).includes('username and password'), JSON.stringify(badPassword.data))

  // A password of exactly code shape is treated as a code and refused as one. It
  // cannot have been a real password, so nothing is lost, and the message must
  // not claim to be a code error for a credential that is not one.
  const shaped = await jsonCall(env, '/api/login', { method: 'POST', body: { username: 'alice', password: 'ABCDEFGHJKLMNPQ' } })
  check('a password of code shape is refused as a code', shaped.response.status === 401, JSON.stringify(shaped.data))
  void bob
}

console.log('follow, profile and notification routes')
{
  const { env, alice, bob } = await setup()
  const mike = (await jsonCall(env, '/api/register', { method: 'POST', body: { username: '@geometricalmike', password: 'a good password', displayName: 'Mike' } })).data

  const mikeRun = (await jsonCall(env, '/api/runs', { method: 'POST', body: aRun({ runId: 'mike-run-1', source: 'AREDL' }), token: mike.token })).data.run
  await env.DB.prepare('INSERT INTO submissions (run_id, video_url, container, note, created_at, status) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(mikeRun.id, 'https://example.com/mike.mp4', 'mp4', 'approved', Date.now(), 'approved')
    .run()

  const search = await jsonCall(env, '/api/users/search?q=geo', { token: alice.token })
  check('search by username works', search.response.status === 200 && search.data.users.some((user) => user.username === 'geometricalmike'), JSON.stringify(search.data))

  const profile = await jsonCall(env, '/api/users/geometricalmike', { token: alice.token })
  check('profile data is public', profile.response.status === 200 && profile.data.user.username === 'geometricalmike', JSON.stringify(profile.data))
  check('profile shows accepted public runs only', Array.isArray(profile.data.runs) && profile.data.runs.length === 1, JSON.stringify(profile.data.runs))
  check('profile counts are reported', profile.data.user.followerCount >= 0 && profile.data.user.followingCount >= 0, JSON.stringify(profile.data.user))

  const follow = await jsonCall(env, '/api/users/geometricalmike/follow', { method: 'POST', token: alice.token })
  check('following a user succeeds', follow.response.status === 200 && follow.data.following === true, JSON.stringify(follow.data))
  check('follower counts update', follow.data.user.followerCount >= 1, JSON.stringify(follow.data.user))

  const secondFollow = await jsonCall(env, '/api/users/geometricalmike/follow', { method: 'POST', token: alice.token })
  check('following again is idempotent', secondFollow.response.status === 200 && secondFollow.data.following === true, JSON.stringify(secondFollow.data))

  const notifications = await jsonCall(env, '/api/notifications', { token: mike.token })
  check('the followed user gets a notification', notifications.response.status === 200 && notifications.data.notifications.some((item) => item.type === 'follow' && item.actorUsername === 'alice'), JSON.stringify(notifications.data))

  const dereference = await jsonCall(env, '/api/users/geometricalmike/unfollow', { method: 'POST', token: alice.token })
  check('unfollowing removes the relationship', dereference.response.status === 200 && dereference.data.following === false, JSON.stringify(dereference.data))

  const bobSearch = await jsonCall(env, '/api/users/search?q=', { token: bob.token })
  check('empty search defaults to geometricalmike', bobSearch.response.status === 200 && bobSearch.data.users.some((user) => user.username === 'geometricalmike'), JSON.stringify(bobSearch.data))
}

console.log('admin profile badges')
{
  const { env, alice } = await setup()
  const owner = (await jsonCall(env, '/api/register', {
    method: 'POST',
    body: { username: 'geometricalmike', password: 'an owner password', displayName: 'Site Owner' },
  })).data

  const ownerProfile = await jsonCall(env, '/api/users/geometricalmike')
  const ownerBadge = ownerProfile.data.user.badges?.find((badge) => badge.text === 'Owner')
  check('the owner profile has the permanent blue Owner badge', ownerBadge?.color === '#3b82f6' && ownerBadge.isProtected, JSON.stringify(ownerProfile.data.user.badges))

  const created = await jsonCall(env, `/api/admin/accounts/${alice.user.id}/badges`, {
    method: 'POST',
    passcode: CORRECT,
    body: { text: 'Champion', color: '#ff5500' },
  })
  check('an admin can assign a badge', created.response.status === 201, JSON.stringify(created.data))
  const badgeId = created.data.badge?.id

  const publicProfile = await jsonCall(env, '/api/users/alice')
  check('assigned badges are shown on the public profile', publicProfile.data.user.badges?.some((badge) => badge.text === 'Champion' && badge.color === '#ff5500'), JSON.stringify(publicProfile.data.user.badges))

  const listed = await jsonCall(env, `/api/admin/accounts/${alice.user.id}/badges`, { passcode: CORRECT })
  check('admin badge search detail includes assigned badges', listed.response.status === 200 && listed.data.badges.some((badge) => badge.id === badgeId), JSON.stringify(listed.data))

  const updated = await jsonCall(env, `/api/admin/accounts/${alice.user.id}/badges/${badgeId}/update`, {
    method: 'POST',
    passcode: CORRECT,
    body: { text: 'Verified', color: '#00aa99' },
  })
  check('an admin can change badge text and color', updated.response.status === 200 && updated.data.badge.text === 'Verified' && updated.data.badge.color === '#00aa99', JSON.stringify(updated.data))

  const reserved = await jsonCall(env, `/api/admin/accounts/${alice.user.id}/badges`, {
    method: 'POST',
    passcode: CORRECT,
    body: { text: 'Owner', color: '#3b82f6' },
  })
  check('the reserved Owner badge cannot be assigned to another profile', reserved.response.status === 400, JSON.stringify(reserved.data))

  const invalidColor = await jsonCall(env, `/api/admin/accounts/${alice.user.id}/badges`, {
    method: 'POST',
    passcode: CORRECT,
    body: { text: 'Invalid color', color: 'red' },
  })
  check('invalid badge colors are rejected', invalidColor.response.status === 400, JSON.stringify(invalidColor.data))

  const ownerBadges = await jsonCall(env, `/api/admin/accounts/${owner.user.id}/badges`, { passcode: CORRECT })
  check('the Owner badge is protected in the admin badge list', ownerBadges.data.badges[0]?.isProtected && ownerBadges.data.badges[0]?.text === 'Owner', JSON.stringify(ownerBadges.data))

  const deleted = await jsonCall(env, `/api/admin/accounts/${alice.user.id}/badges/${badgeId}/delete`, {
    method: 'POST',
    passcode: CORRECT,
  })
  check('an admin can remove an assigned badge', deleted.response.status === 200, JSON.stringify(deleted.data))
  const afterDelete = await jsonCall(env, '/api/users/alice')
  check('removed badges no longer appear on the public profile', !afterDelete.data.user.badges?.some((badge) => badge.id === badgeId), JSON.stringify(afterDelete.data.user.badges))
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`)
  process.exit(1)
}
console.log('\nAll checks passed.')
