/** Durable state for AI Radar: fetched timelines, dedupe ledger, seen terms, current digest. */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const STATE_VERSION = 1
const SEEN_LIMIT = 4000
const TERM_TTL_MS = 14 * 24 * 60 * 60 * 1000
const CACHED_TWEETS_PER_ACCOUNT = 16

export function resolveDataDir(config) {
  if (config.dataDir) return config.dataDir
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim().length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'storages', 'ai-radar')
}

export function resolveStatePath(config) {
  return join(resolveDataDir(config), 'state.json')
}

const emptyState = () => ({
  version: STATE_VERSION,
  lastRefreshAt: null,
  digest: [],
  lastSummary: null,
  seen: [],
  terms: {},
  accounts: {},
  questionPool: [],
  questionClusters: [],
  questionOverall: '',
  questionsAt: null,
  questionError: null,
  questionPosts: {},
})

export function loadState(config) {
  const path = resolveStatePath(config)
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return emptyState()
  }
  if (!parsed || typeof parsed !== 'object' || parsed.version !== STATE_VERSION) return emptyState()
  return {
    version: STATE_VERSION,
    lastRefreshAt: typeof parsed.lastRefreshAt === 'string' ? parsed.lastRefreshAt : null,
    digest: Array.isArray(parsed.digest) ? parsed.digest : [],
    lastSummary: parsed.lastSummary && typeof parsed.lastSummary === 'object' ? parsed.lastSummary : null,
    seen: Array.isArray(parsed.seen) ? parsed.seen.filter((id) => typeof id === 'string') : [],
    terms: parsed.terms && typeof parsed.terms === 'object' ? parsed.terms : {},
    accounts: parsed.accounts && typeof parsed.accounts === 'object' ? parsed.accounts : {},
    questionPool: Array.isArray(parsed.questionPool) ? parsed.questionPool : [],
    questionClusters: Array.isArray(parsed.questionClusters) ? parsed.questionClusters : [],
    questionOverall: typeof parsed.questionOverall === 'string' ? parsed.questionOverall : '',
    questionsAt: typeof parsed.questionsAt === 'string' ? parsed.questionsAt : null,
    questionError: typeof parsed.questionError === 'string' ? parsed.questionError : null,
    questionPosts: parsed.questionPosts && typeof parsed.questionPosts === 'object' ? parsed.questionPosts : {},
  }
}

export function saveState(config, state) {
  const path = resolveStatePath(config)
  mkdirSync(dirname(path), { recursive: true })
  const temp = `${path}.tmp`
  writeFileSync(temp, `${JSON.stringify(state, null, 0)}\n`, 'utf8')
  renameSync(temp, path)
}

export function pruneState(state, now = Date.now()) {
  if (state.questionPool.length > 1500) state.questionPool = state.questionPool.slice(-1500)
  for (const [rootId, at] of Object.entries(state.questionPosts)) {
    const parsed = Date.parse(at ?? '')
    if (!Number.isFinite(parsed) || now - parsed > 30 * 24 * 60 * 60 * 1000) delete state.questionPosts[rootId]
  }
  if (state.seen.length > SEEN_LIMIT) state.seen = state.seen.slice(-SEEN_LIMIT)
  const kept = {}
  for (const [term, firstSeen] of Object.entries(state.terms)) {
    const at = Date.parse(firstSeen)
    if (Number.isFinite(at) && now - at <= TERM_TTL_MS) kept[term] = firstSeen
  }
  state.terms = kept
  for (const [handle, entry] of Object.entries(state.accounts)) {
    if (!entry || !Array.isArray(entry.tweets)) {
      delete state.accounts[handle]
      continue
    }
    if (entry.tweets.length > CACHED_TWEETS_PER_ACCOUNT) entry.tweets = entry.tweets.slice(0, CACHED_TWEETS_PER_ACCOUNT)
  }
  return state
}

export function markSeen(state, ids) {
  if (ids.length === 0) return
  const known = new Set(state.seen)
  for (const id of ids) {
    if (known.has(id)) continue
    known.add(id)
    state.seen.push(id)
  }
}
