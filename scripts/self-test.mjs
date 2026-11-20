/**
 * Offline checks for the industry-pack work. No network, no host, no model:
 * everything here is the pure part (packs, matchers, scoring, prompts, files).
 *
 *   node scripts/self-test.mjs
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'

import {
  createMatchers,
  DEFAULT_INDUSTRY,
  isDefaultIndustry,
  loadIndustry,
  normalizeIndustry,
  saveIndustry,
} from '../src/industry.js'
import { normalizeConfig } from '../src/config.js'
import { scoreTweet } from '../src/score.js'
import { buildSystemPrompt } from '../src/editor.js'
import { buildClusterPrompt } from '../src/questions.js'

let failures = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.log(`FAIL ${name}\n     ${error?.message ?? error}`)
  }
}

const hits = (regex, text) => (regex ? [...text.matchAll(regex)].map((match) => match[0]) : [])

const AI_POST = 'DeepSeek released V4 today: 1.3M tokens of context window, zero-shot reasoning benchmarks above the previous model, weights open source on GitHub.'
const BEAUTY_POST = '花西子新品口红上手实测：三个色号在黄皮上的显色差异，含成分表和上嘴对比，SPF 值也标了。'

const BEAUTY_PACK = {
  id: 'custom',
  label: '美妆行业',
  keywords: ['口红', '粉底', '成分', '色号', '妆效', 'skincare', 'serum', 'makeup', 'spf', '遮瑕'],
  brands: ['花西子', 'perfect diary', 'y.s.l'],
  accounts: 'makeupbymario\n花西子,1\nsephora,3',
  hn: { enabled: false, queries: '' },
  questionSeeds: ['上脸效果', '成分与致敏', '持妆时长'],
}

const tweet = (text) => ({
  id: 't1',
  text,
  lang: 'zh',
  createdAt: new Date().toISOString(),
  isRetweet: false,
  sensitive: false,
  hasLink: true,
  hasMedia: false,
  metrics: { like: 800, retweet: 90, reply: 120, quote: 30 },
  metricsPartial: false,
  author: { handle: 'tester', name: 'Tester', followers: 90000, verified: false },
  conversationId: 'c1',
  url: 'https://x.com/tester/status/1',
})

check('AI pack matches AI vocabulary and not beauty vocabulary', () => {
  const matchers = createMatchers(DEFAULT_INDUSTRY)
  const aiHits = hits(matchers.relevance, AI_POST).map((term) => term.toLowerCase())
  assert.ok(aiHits.length >= 4, `AI post should hit several keywords, got ${JSON.stringify(aiHits)}`)
  assert.ok(aiHits.includes('reasoning') && aiHits.includes('open source'), `missing expected hits: ${JSON.stringify(aiHits)}`)
  assert.equal(hits(matchers.relevance, BEAUTY_POST).length, 0, 'beauty post must not look on-topic to the AI pack')
  assert.deepEqual(hits(matchers.brand, 'GPT-5 is out').map((term) => term.toLowerCase()), ['gpt-5'])
  assert.deepEqual(hits(matchers.brand, 'GPT is a company'), [], 'a bare brand is not a checkable term')
})

check('a custom pack flips relevance, including CJK keywords', () => {
  const pack = normalizeIndustry(BEAUTY_PACK)
  const matchers = createMatchers(pack)
  assert.ok(hits(matchers.relevance, BEAUTY_POST).length >= 3)
  assert.equal(hits(matchers.relevance, AI_POST).length, 0)
  assert.deepEqual(hits(matchers.brand, '花西子又出了一个系列').map((term) => term), ['花西子'])
  assert.deepEqual(hits(matchers.brand, 'Y.S.L 1966 上嘴').map((term) => term.toLowerCase()), ['y.s.l 1966'])
})

check('custom pack keeps only the accounts it was given, and parses tiers', () => {
  const pack = normalizeIndustry(BEAUTY_PACK)
  assert.deepEqual(pack.accounts.map((account) => `${account.handle}:${account.tier}`), ['makeupbymario:2', '花西子:1', 'sephora:3'])
  assert.equal(isDefaultIndustry(pack), false)
  assert.equal(pack.hn.enabled, false, 'empty HN queries must disable the source')
})

check('an empty custom pack does not silently fall back to the AI accounts', () => {
  const pack = normalizeIndustry({ id: 'custom', label: '空行业', keywords: ['x'] })
  assert.equal(pack.accounts.length, 0)
  assert.equal(isDefaultIndustry(pack), false)
})

check('relevance actually changes the score, not just the label', () => {
  const state = { terms: {}, seen: [] }
  const account = { handle: 'tester', tier: 2, label: 'Tester' }
  const aiMatchers = createMatchers(DEFAULT_INDUSTRY)
  const beautyMatchers = createMatchers(normalizeIndustry(BEAUTY_PACK))
  const now = Date.now()
  const aiScored = scoreTweet(tweet(AI_POST), account, { state, baselineEngagement: 300, now, matchers: aiMatchers })
  const beautyScored = scoreTweet(tweet(BEAUTY_POST), account, { state, baselineEngagement: 300, now, matchers: beautyMatchers })
  const aiAsBeauty = scoreTweet(tweet(AI_POST), account, { state: { terms: {} }, baselineEngagement: 300, now, matchers: beautyMatchers })
  assert.ok(aiScored.parts.relevance > 0.4, `AI post under AI pack should be relevant, got ${aiScored.parts.relevance}`)
  assert.ok(beautyScored.parts.relevance > 0.5, `beauty post under beauty pack should be relevant, got ${beautyScored.parts.relevance}`)
  // Relevance carries a tier bonus, so "no keyword hit" is the tier baseline,
  // not zero. The point is that the pack decides the difference.
  assert.equal(aiAsBeauty.parts.relevance, 0.12, 'no keyword hit leaves only the tier-2 baseline')
  assert.ok(aiScored.parts.relevance - aiAsBeauty.parts.relevance > 0.3, 'the AI pack must lift that post well above the baseline')
})

check('both prompts follow the pack label', () => {
  const pack = normalizeIndustry(BEAUTY_PACK)
  const editor = buildSystemPrompt(pack)
  const cluster = buildClusterPrompt(pack)
  assert.match(editor, /美妆行业/)
  assert.match(editor, /美妆行业雷达/)
  assert.doesNotMatch(editor, /AI 雷达/)
  assert.match(cluster, /美妆行业/)
  assert.match(cluster, /上脸效果/)
  assert.doesNotMatch(cluster, /白科闪点/)
  const generic = buildClusterPrompt({ label: '宠物行业', questionSeeds: [] })
  assert.match(generic, /宠物行业/)
  assert.match(generic, /具体可复现的困难/)
})

check('the pack round-trips through disk and config picks it up', () => {
  const dir = mkdtempSync(join(tmpdir(), 'radar-test-'))
  try {
    const pack = normalizeIndustry(BEAUTY_PACK)
    saveIndustry({ dataDir: dir }, pack)
    const loaded = loadIndustry({ dataDir: dir })
    assert.equal(loaded.label, '美妆行业')
    assert.equal(loaded.accounts.length, 3)
    assert.deepEqual(loaded.keywords, pack.keywords)
    const config = normalizeConfig({ dataDir: dir })
    assert.equal(config.industryLabel, '美妆行业')
    assert.equal(config.accounts.length, 3)
    assert.equal(config.hn, false, 'HN off in the pack must mean off in the config')
    assert.equal(config.matchers.relevance.test('口红'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

check('a profile that spells out accounts still wins over the stored pack', () => {
  const dir = mkdtempSync(join(tmpdir(), 'radar-test-'))
  try {
    saveIndustry({ dataDir: dir }, normalizeIndustry(BEAUTY_PACK))
    const config = normalizeConfig({ dataDir: dir, accounts: ['@only_this_one'], hnQueries: ['alpha query'] })
    assert.deepEqual(config.accounts.map((account) => account.handle), ['only_this_one'])
    assert.deepEqual(config.hnQueries, ['alpha query'])
    assert.equal(config.hn, true, 'an explicit hnQueries keeps HN on')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
