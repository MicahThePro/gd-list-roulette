import process from 'node:process'
import worker from './index.js'
import { createTestDb } from './testDb.js'

const BASE = 'https://worker.test'
const env = { DB: createTestDb() }
let failures = 0

const check = (name, condition, detail = '') => {
  if (condition) {
    console.log(`  pass  ${name}`)
  } else {
    failures += 1
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`)
  }
}

const call = async (path, { method = 'GET', body, token } = {}) => {
  const headers = { 'x-dlr-protocol': '3' }
  if (body !== undefined) headers['content-type'] = 'application/json'
  if (token) headers.authorization = `Bearer ${token}`
  const response = await worker.fetch(
    new Request(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
  )
  return { response, data: await response.json() }
}

const level = {
  id: 'pointercrate-1',
  position: 1,
  name: 'First Demon',
  creator: 'Level Creator',
  permalink: 'https://pointercrate.com/demonlist/1/',
  thumbnail: 'https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg',
  video: 'abcdefghijk',
}

console.log('custom runs')
{
  const definition = {
    source: 'Pointercrate Demon List',
    percentStep: 5,
    allowSkip: true,
    levelTimeLimitMs: 60_000,
    totalTimeLimitMs: 300_000,
    levels: [level],
  }
  const signedOut = await call('/api/custom-runs', { method: 'POST', body: definition })
  check('signed-out creation is rejected', signedOut.response.status === 401)

  const registered = await call('/api/register', {
    method: 'POST',
    body: { username: 'custom_creator', password: 'long-enough-password', displayName: 'Creator' },
  })
  const token = registered.data.token
  check('creator account is available for authenticated creation', Boolean(token))

  const created = await call('/api/custom-runs', { method: 'POST', body: definition, token })
  check('signed-in creator can create a custom run', created.response.status === 201, JSON.stringify(created.data))
  const id = created.data.id

  const metadata = await call(`/api/custom-runs/${id}`)
  check('the share link returns public metadata', metadata.response.status === 200)
  check('metadata includes creator rules and level count', metadata.data.levelCount === 1 && metadata.data.percentStep === 5)
  check('metadata does not disclose the ordered levels', !Object.hasOwn(metadata.data, 'levels'))

  const first = await call(`/api/custom-runs/${id}/levels/1`)
  check('a player can request the first level without signing in', first.response.status === 200)
  check('the level endpoint returns only the requested ordered level', first.data.level?.name === level.name && !Object.hasOwn(first.data, 'levels'))

  const outOfRange = await call(`/api/custom-runs/${id}/levels/2`)
  check('an out-of-range level index is not found', outOfRange.response.status === 404)

  const tooManyLevels = await call('/api/custom-runs', {
    method: 'POST',
    token,
    body: { ...definition, percentStep: 5, levels: Array(21).fill(level) },
  })
  check('creation enforces the increment-based level cap', tooManyLevels.response.status === 400)

  const unsafeUrl = await call('/api/custom-runs', {
    method: 'POST',
    token,
    body: { ...definition, levels: [{ ...level, permalink: 'https://example.com/level/1' }] },
  })
  check('creation rejects level links outside the selected source', unsafeUrl.response.status === 400)
}

env.DB.close()
if (failures) process.exit(1)
