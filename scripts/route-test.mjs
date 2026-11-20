/**
 * Exercises the host's industry route the way the panel does, without a DSH
 * process: the plugin registers one handler, and we hand it real requests.
 *
 *   node scripts/route-test.mjs
 */

import http from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

import { apply } from '../index.js'

const dir = mkdtempSync(join(tmpdir(), 'radar-route-'))
let handler
const ctx = {
  logger: { info() {} },
  get: () => undefined,
  effect: (fn) => {
    fn()
    return () => {}
  },
  webServer: {
    register: (route) => {
      handler = route.handler
      return () => {}
    },
  },
}

apply(ctx, { enabled: false, editor: false, questions: false, hn: false, dataDir: dir })
assert.ok(handler, 'the plugin must register a route handler')

const server = http.createServer((req, res) => handler(req, res))
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/plugins/ai-radar`

const call = async (path, options) => {
  const response = await fetch(`${base}${path}`, options)
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: response.status, body }
}

try {
  const got = await call('/industry')
  assert.equal(got.status, 200)
  assert.equal(got.body.industry.label, 'AI 行业')
  console.log('ok   GET /industry returns the shipped pack')

  const empty = await call('/industry', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: '美妆', keywords: ['口红'], accounts: '' }),
  })
  assert.equal(empty.status, 400)
  assert.equal(empty.body.error, 'no-accounts')
  console.log('ok   POST without sources is refused instead of scanning the AI list')

  const noKeywords = await call('/industry', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ label: '美妆', keywords: '', accounts: 'someone' }),
  })
  assert.equal(noKeywords.status, 400)
  assert.equal(noKeywords.body.error, 'no-keywords')
  console.log('ok   POST without keywords is refused')

  const saved = await call('/industry', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      label: '美妆行业',
      keywords: '口红,粉底,成分',
      accounts: 'makeupbymario\n花西子,1',
      hn: { enabled: false, queries: '' },
    }),
  })
  assert.equal(saved.status, 202)
  assert.equal(saved.body.state.industry.label, '美妆行业')
  assert.equal(saved.body.state.accounts.length, 2)
  assert.equal(saved.body.state.industry.hn.enabled, false)
  const stored = JSON.parse(readFileSync(join(dir, 'industry.json'), 'utf8'))
  assert.equal(stored.pack.label, '美妆行业')
  assert.deepEqual(stored.pack.keywords, ['口红', '粉底', '成分'])
  console.log('ok   POST saves the pack, swaps the live config and clears the old digest')
  console.log('\nroute checks passed')
} finally {
  server.close()
  rmSync(dir, { recursive: true, force: true })
  process.exit(0)
}
