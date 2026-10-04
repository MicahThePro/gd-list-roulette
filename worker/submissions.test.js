/**
 * End-to-end checks for run submission and moderation.
 *
 * The proof is a link to a video on the player's own host, not an upload, so
 * there is no object storage anywhere in this. The real request handler, the
 * real SQL and the real passcode check all run; what is verified is the code
 * that ships.
 *
 * Run with: node --experimental-sqlite worker/submissions.test.js
 */
import process from 'node:process'
import worker from './index.js'
import { createPasswordRecord } from './auth.js'
import { createTestDb } from './testDb.js'

/* Every migration, applied in order, by the shared helper. It used to be a local list
 * of migration filenames, edited by hand whenever a migration was added -- and missed,
 * which left the suite running against a schema the production database does not have. */
const createDb = () => createTestDb()

/* A passcode that exists only to be typed into a test, deliberately not the one that
 * was once committed to this repository and read out of a public file. The real
 * passcode is a Worker secret and is never in this repository. */
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
  // test here sends it by default.
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

const aRun = (over = {}) => ({
  runId: 'run-1',
  source: 'AREDL',
  percentStep: 1,
  status: 'failed',
  endedAt: 1_700_000_000_000,
  rounds: [
    { levelId: 'a', levelName: 'Alpha', targetPercent: 1, achievedPercent: 1, result: 'success', elapsedMs: 30000 },
    { levelId: 'b', levelName: 'Beta', targetPercent: 2, achievedPercent: 2, result: 'success', elapsedMs: 40000 },
    { levelId: 'c', levelName: 'Gamma', targetPercent: 3, achievedPercent: 1, result: 'failure', elapsedMs: 20000 },
  ],
  ...over,
})

// A plausible proof: a share link to a video on someone else's host.
const proof = (over = {}) => ({
  videoUrl: 'https://drive.google.com/file/d/abc123/view',
  container: 'mp4',
  note: 'recorded with OBS',
  ...over,
})

const setup = async (env = makeEnv()) => {
  const auth = (await jsonCall(env, '/api/register', { method: 'POST', body: { username: 'player', password: 'a good password' } })).data
  const run = (await jsonCall(env, '/api/runs', { method: 'POST', body: aRun(), token: auth.token })).data.run
  return { env, token: auth.token, runId: run.id }
}

/* A fresh run for every case.
 *
 * A run may only ever be submitted once, so a block that checks several links
 * or several file types cannot reuse one run: the second attempt would be
 * refused as a duplicate rather than judged on its link. Each case needs its own
 * run to be testing what it means to test. */
const freshRun = async (env, token, suffix) => {
  const run = (
    await jsonCall(env, '/api/runs', {
      method: 'POST',
      body: aRun({ runId: `run-${suffix}` }),
      token,
    })
  ).data.run
  return run.id
}

const submit = (env, runId, body, token) =>
  jsonCall(env, '/api/submissions', { method: 'POST', body: { ...body, runId }, token })

console.log('the admin passcode')
{
  const { env } = await setup()

  check('no passcode is refused', (await jsonCall(env, '/api/admin/submissions')).response.status === 401)
  check('a wrong passcode is refused', (await jsonCall(env, '/api/admin/submissions', { passcode: '000000' })).response.status === 429)

  const wrong = await jsonCall(env, '/api/admin/submissions', { passcode: '000000' })
  check('a wrong passcode says so plainly', /passcode/i.test(wrong.data?.error ?? ''), JSON.stringify(wrong.data))

  const right = await jsonCall(env, '/api/admin/submissions', { passcode: CORRECT })
  check('the right passcode gets in', right.response.status === 200, JSON.stringify(right.data))
  check('the queue reads as an array', Array.isArray(right.data?.submissions))

  // A wrong passcode must not be able to tell whether a submission exists.
  const probe = await jsonCall(env, '/api/admin/submissions/999', { passcode: '000000' })
  check('a wrong passcode cannot confirm a submission exists', probe.response.status === 429)
}

console.log('the built-in passcode works with no setup')
console.log('the admin passcode secret')
{
  /* There is no built-in passcode any more, and that is the point.
   *
   * It used to be a hash in worker/admin.js whose plaintext sat in a test fixture in
   * this public repository, so anybody could read the passcode out of the source. A
   * fallback secret in committed code is not a secret. The panel now refuses until a
   * real Worker secret is set, and says so -- rather than reporting it as a wrong
   * passcode, which would send the owner looking in the wrong place. */
  const noSecret = { DB: createDb() }
  const unset = await jsonCall(noSecret, '/api/admin/submissions', { passcode: CORRECT })
  check('no secret set means no access', unset.response.status === 500, String(unset.response.status))
  check(
    'and it says the secret is unset rather than that the passcode is wrong',
    /ADMIN_PASSCODE is not set/.test(unset.data?.error ?? ''),
    JSON.stringify(unset.data),
  )
  check('and it does not echo the hash or the passcode', !/200000:/.test(unset.data?.error ?? ''))

  // Set it and the panel works, with no code change at all.
  const set = { ...noSecret, ADMIN_PASSCODE: (await createPasswordRecord('a different code')).passwordHash }
  check('a secret opens the panel', (await jsonCall(set, '/api/admin/submissions', { passcode: 'a different code' })).response.status === 200)
  check('and the wrong passcode is refused', (await jsonCall(set, '/api/admin/submissions', { passcode: CORRECT })).response.status === 429)
}

console.log('submitting a link')
{
  const { env, token, runId } = await setup()

  check('submitting without a session is refused', (await submit(env, runId, proof(), undefined)).response.status === 401)

  // Only http and https. A javascript: or data: URL is refused outright rather
  // than normalised, because a moderator clicks this link.
  for (const bad of [
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///etc/passwd',
    'ftp://example.com/video.mp4',
    'not a url at all',
    '',
  ]) {
    const id = await freshRun(env, token, `bad-${bad.slice(0, 8)}`)
    const result = await submit(env, id, proof({ videoUrl: bad }), token)
    check(`"${bad.slice(0, 24)}" is refused`, result.response.status === 400, String(result.response.status))
  }

  for (const good of [
    'https://drive.google.com/file/d/abc/view',
    'https://youtu.be/dQw4w9WgXcQ',
    'http://example.com/run.mp4',
  ]) {
    const id = await freshRun(env, token, `good-${good.slice(0, 10)}`)
    const result = await submit(env, id, proof({ videoUrl: good }), token)
    check(`"${good.slice(0, 30)}" is accepted`, result.response.status === 201, String(result.response.status))
  }

  for (const container of ['mp4', 'mov', 'avi', 'mkv', 'webm']) {
    const id = await freshRun(env, token, `c-${container}`)
    const result = await submit(env, id, proof({ container }), token)
    check(`a .${container} video is accepted`, result.response.status === 201, String(result.response.status))
  }

  const typeId = await freshRun(env, token, 'type')
  check('an unknown type is refused', (await submit(env, typeId, proof({ container: 'exe' }), token)).response.status === 400)

  check('a missing run id is refused', (await submit(env, 'not-a-number', proof(), token)).response.status === 400)
  check("somebody else's run cannot be submitted", (await submit(env, 99999, proof(), token)).response.status === 404)
}

console.log('special direct-submit username bypasses the video gate')
{
  const env = makeEnv()
  const auth = (await jsonCall(env, '/api/register', { method: 'POST', body: { username: '@geometricalmike', password: 'a good password' } })).data
  const run = (await jsonCall(env, '/api/runs', { method: 'POST', body: aRun({ runId: 'run-special-bypass' }), token: auth.token })).data.run

  const result = await submit(env, run.id, proof({ videoUrl: '', container: 'mp4' }), auth.token)
  check('the direct-submit username is accepted without a video', result.response.status === 201, String(result.response.status))
  check('and the submission is auto-approved', result.data.submission.status === 'approved', JSON.stringify(result.data))

  const board = (await jsonCall(env, '/api/leaderboard')).data
  check('and it lands on the public leaderboard immediately', board.entries.length > 0, JSON.stringify(board))
}

console.log('a run can only be submitted once')
{
  const { env, token, runId } = await setup()

  const first = await submit(env, runId, proof(), token)
  check('the first submission goes through', first.response.status === 201, JSON.stringify(first.data))

  // The client's own "already submitted" flag is a localStorage mirror, so it
  // can be forgotten by clearing site data. The server is what holds the line.
  const again = await submit(env, runId, proof(), token)
  check('a second submission of the same run is refused', again.response.status === 409, String(again.response.status))
  check('and it says it is already waiting', /already waiting/i.test(again.data?.error ?? ''), JSON.stringify(again.data))

  // Rejected is not a retry. A run that was turned down stays turned down, so
  // the queue cannot be refilled with copies of something already refused.
  const id = (await jsonCall(env, '/api/admin/submissions', { passcode: CORRECT })).data.submissions[0].id
  await jsonCall(env, `/api/admin/submissions/${id}/reject`, { method: 'POST', body: { note: 'nope' }, passcode: CORRECT })

  const afterReject = await submit(env, runId, proof(), token)
  check('a rejected run cannot be sent again', afterReject.response.status === 409, String(afterReject.response.status))
  check('and it says it was turned down', /turned down/i.test(afterReject.data?.error ?? ''), JSON.stringify(afterReject.data))

  await jsonCall(env, `/api/admin/submissions/${id}/approve`, { method: 'POST', body: { note: 'on reflection' }, passcode: CORRECT })
  const afterApprove = await submit(env, runId, proof(), token)
  check('an approved run cannot be sent again either', afterApprove.response.status === 409, String(afterApprove.response.status))
  check('and it says it is already on the board', /already on the global leaderboard/i.test(afterApprove.data?.error ?? ''), JSON.stringify(afterApprove.data))

  // One run, one row, however many times the request is repeated.
  const queue = await jsonCall(env, '/api/admin/submissions', { passcode: CORRECT })
  check('the run is in the queue exactly once', queue.data.submissions.length === 1, String(queue.data.submissions.length))

  // A different run is unaffected: the rule is per run, not per player.
  const other = await freshRun(env, token, 'other')
  check('a different run can still be submitted', (await submit(env, other, proof(), token)).response.status === 201)
}

console.log('the leaderboard only holds approved runs')
{
  const { env, token, runId } = await setup()

  const board = async () => (await jsonCall(env, '/api/leaderboard')).data

  check('a run with no proof is off the board', (await board()).entries.length === 0)

  await submit(env, runId, proof(), token)
  check('a pending run is still off the board', (await board()).entries.length === 0)

  const queue = await jsonCall(env, '/api/admin/submissions', { passcode: CORRECT })
  const submission = queue.data.submissions[0]
  check('the submission is in the queue', Boolean(submission), JSON.stringify(queue.data))
  check('the queue carries the player', submission.username === 'player')
  check('the queue carries the link for the moderator', submission.videoUrl === proof().videoUrl, submission.videoUrl)
  check("the queue carries the player's note", submission.note === 'recorded with OBS', submission.note)
  check('the queue carries the round list to check against', Array.isArray(submission.rounds) && submission.rounds.length === 3, String(submission.rounds?.length))
  check('the queue carries the score', submission.score === 3, String(submission.score))

  const pendingOnly = await jsonCall(env, '/api/admin/submissions?status=pending', { passcode: CORRECT })
  check('filtering by pending works', pendingOnly.data.submissions.length === 1)

  await jsonCall(env, `/api/admin/submissions/${submission.id}/approve`, { method: 'POST', body: { note: 'watched it, looks right' }, passcode: CORRECT })

  const after = (await board())
  check('an approved run goes on the board', after.entries.length === 1, JSON.stringify(after.entries))
  check('and it is the right one', after.entries[0].displayName === 'player')

  // A moderator changing their mind has to take the run back off.
  await jsonCall(env, `/api/admin/submissions/${submission.id}/reject`, { method: 'POST', body: { note: 'on reflection' }, passcode: CORRECT })
  check('a rejected run comes off the board', (await board()).entries.length === 0)
}

console.log('moderation actions')
{
  const { env, token, runId } = await setup()
  await submit(env, runId, proof(), token)

  const id = (await jsonCall(env, '/api/admin/submissions', { passcode: CORRECT })).data.submissions[0].id

  check('approving needs the passcode', (await jsonCall(env, `/api/admin/submissions/${id}/approve`, { method: 'POST', body: {} })).response.status === 401)
  check('approving nothing is a 404', (await jsonCall(env, '/api/admin/submissions/9999/approve', { method: 'POST', body: {}, passcode: CORRECT })).response.status === 404)

  const detail = await jsonCall(env, `/api/admin/submissions/${id}`, { passcode: CORRECT })
  check('one submission can be read on its own', detail.response.status === 200 && detail.data.submission.id === id, JSON.stringify(detail.data).slice(0, 80))

  // Deleting has to take the run with it, not just the submission.
  const fresh = await setup()
  await submit(fresh.env, fresh.runId, proof(), fresh.token)
  const freshId = (await jsonCall(fresh.env, '/api/admin/submissions', { passcode: CORRECT })).data.submissions[0].id

  await jsonCall(fresh.env, `/api/admin/submissions/${freshId}/delete`, { method: 'POST', body: {}, passcode: CORRECT })
  const gone = await jsonCall(fresh.env, '/api/admin/submissions', { passcode: CORRECT })
  check('deleting removes the submission', gone.data.submissions.length === 0, JSON.stringify(gone.data))
  check('deleting removes the run too', (await jsonCall(fresh.env, '/api/runs', { token: fresh.token })).data.runs.length === 0)
}

console.log('a player can see their own submissions')
{
  const { env, token, runId } = await setup()
  await submit(env, runId, proof(), token)

  const mine = await jsonCall(env, '/api/submissions/mine', { token })
  check('a player sees their own submission', mine.data.submissions.length === 1, JSON.stringify(mine.data))
  check('with its status', mine.data.submissions[0].status === 'pending')
  check('nobody else can', (await jsonCall(env, '/api/submissions/mine')).response.status === 401)
}

console.log('nothing is stored and nothing is fetched')
{
  const { env, runId } = await setup()

  // No R2 binding at all: the Worker must work with only a database, or every
  // deploy would depend on storage nobody is paying for.
  const noBucket = await jsonCall(env, '/api/submissions', {
    method: 'POST',
    body: { ...proof(), runId },
    token: (await jsonCall(env, '/api/login', { method: 'POST', body: { username: 'player', password: 'a good password' } })).data.token,
  })
  check('submitting works with no storage binding', noBucket.response.status === 201, JSON.stringify(noBucket.data))

  // The old video streaming route is gone rather than left failing.
  const old = await jsonCall(env, `/api/admin/submissions/1/video`, { passcode: CORRECT })
  check('the old video route no longer exists', old.response.status === 404, String(old.response.status))

  const unknown = await jsonCall(env, '/api/submissions/1/video', { passcode: CORRECT })
  check('and neither does a public one', unknown.response.status === 404, String(unknown.response.status))
}

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`)
process.exit(failures === 0 ? 0 : 1)
