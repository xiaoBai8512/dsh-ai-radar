/** One refresh pass: gather, gate, score, select, remember. */

import { hardGate, median, scoreTweet } from './score.js'
import { delay, fetchProfileTweets, fetchTimeline } from './xs.js'
import { markSeen, pruneState } from './state.js'

const HOUR = 60 * 60 * 1000
const CACHED_PER_ACCOUNT = 16

const engagement = (tweet) =>
  tweet.metrics.like + 2 * tweet.metrics.retweet + 2 * tweet.metrics.reply + 2 * tweet.metrics.quote

const normalizeExcerpt = (text) => {
  const collapsed = text.replace(/\s+/g, ' ').trim()
  return collapsed.length > 320 ? `${collapsed.slice(0, 317)}…` : collapsed
}

const round = (value) => Math.round(value * 1000) / 1000

const newestTimestamp = (tweets) => {
  let newest = Number.NaN
  for (const tweet of tweets) {
    const at = Date.parse(tweet.createdAt ?? '')
    if (Number.isFinite(at) && (!Number.isFinite(newest) || at > newest)) newest = at
  }
  return newest
}

const staleLabel = (now, newest) => {
  if (!Number.isFinite(newest)) return 'stale (no timestamp)'
  const hours = Math.round((now - newest) / HOUR)
  return `stale (newest ${hours >= 48 ? `${Math.round(hours / 24)}d` : `${hours}h`} old)`
}

/** Keep the previous posts alongside the new ones: the score baseline needs depth. */
const mergeTweets = (previous, fresh) => {
  const byId = new Map()
  for (const tweet of [...fresh, ...(Array.isArray(previous?.tweets) ? previous.tweets : [])]) {
    if (tweet?.id && !byId.has(tweet.id)) byId.set(tweet.id, tweet)
  }
  return [...byId.values()]
    .sort((left, right) => Date.parse(right.createdAt ?? '') - Date.parse(left.createdAt ?? ''))
    .slice(0, CACHED_PER_ACCOUNT)
}

/**
 * Read one account.
 *
 * The profile page is the primary source: x.com renders the recent posts into
 * it, counts included, so one keyless GET is the whole read. The syndicated
 * timeline payload is the second opinion — clean JSON, but for a fair share of
 * accounts it carries the all-time top posts instead of the recent ones.
 */
async function gatherAccount(account, { state, config, windowHours, now, log, signal }) {
  const previous = state.accounts[account.handle]

  const profile = await fetchProfileTweets(account.handle, { signal })
  if (profile.ok) {
    state.accounts[account.handle] = {
      fetchedAt: new Date(now).toISOString(),
      source: 'profile',
      tweets: mergeTweets(previous, profile.tweets),
    }
    const newest = newestTimestamp(profile.tweets)
    if (Number.isFinite(newest) && now - newest <= windowHours * HOUR) {
      return { source: 'profile', count: profile.tweets.length }
    }
    log?.(`@${account.handle}: ${staleLabel(now, newest)} on the profile page`)
    return { stale: staleLabel(now, newest), source: 'profile', count: profile.tweets.length }
  }
  log?.(`@${account.handle}: profile page unavailable (${profile.reason}), trying the syndicated timeline`)

  const timeline = await fetchTimeline(account.handle, { signal })
  if (!timeline.ok) return { failed: `profile=${profile.reason}; timeline=${timeline.reason}` }

  state.accounts[account.handle] = {
    fetchedAt: new Date(now).toISOString(),
    source: 'timeline',
    tweets: mergeTweets(previous, timeline.tweets),
  }
  const newest = newestTimestamp(timeline.tweets)
  if (Number.isFinite(newest) && now - newest <= windowHours * HOUR) {
    return { source: 'timeline', count: timeline.tweets.length }
  }
  return { stale: staleLabel(now, newest), source: 'timeline', count: timeline.tweets.length }
}

const ACCOUNT_TIMEOUT_MS = 45000

/** Never let one stuck request stop the whole pass. */
const withTimeout = (promise, ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ failed: 'timeout' }), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        resolve({ failed: `error: ${error?.message ?? String(error)}` })
      },
    )
  })

async function gather({ config, state, windowHours, now, force, log, signal, onProgress, onAccount }) {
  const cacheTtl = (force ? 2 : config.cacheMinutes) * 60 * 1000
  const fetched = []
  const failures = []
  const stale = []
  for (let index = 0; index < config.accounts.length; index += 1) {
    if (signal?.aborted) break
    const account = config.accounts[index]
    const cached = state.accounts[account.handle]
    const cachedAt = cached ? Date.parse(cached.fetchedAt ?? '') : Number.NaN
    if (cached && Number.isFinite(cachedAt) && now - cachedAt < cacheTtl) continue
    onAccount?.({ index: index + 1, total: config.accounts.length, handle: account.handle })
    const result = await withTimeout(
      gatherAccount(account, { state, config, windowHours, now, log, signal }),
      ACCOUNT_TIMEOUT_MS,
    )
    if (result.failed !== undefined) {
      failures.push({ handle: account.handle, reason: result.failed })
      log?.(`@${account.handle} unavailable: ${result.failed}`)
    } else if (result.stale !== undefined) {
      // A source that answers but has nothing inside the window is not an error:
      // it is an account that did not post. Reporting it as a failure made the
      // 401 noise look like a forty-account outage.
      stale.push({ handle: account.handle, reason: result.stale })
    } else {
      fetched.push({ handle: account.handle, source: result.source, count: result.count })
    }
    onProgress?.()
    if (index < config.accounts.length - 1) await delay(config.requestGapMs, signal)
  }
  return { fetched, failures, stale }
}

const toDigestItem = (candidate) => ({
  id: candidate.tweet.id,
  thread: candidate.tweet.conversationId,
  url: candidate.tweet.url,
  author: {
    handle: candidate.tweet.author.handle,
    name: candidate.tweet.author.name,
    verified: candidate.tweet.author.verified,
    tier: candidate.account.tier,
  },
  createdAt: candidate.tweet.createdAt,
  text: candidate.tweet.text,
  excerpt: normalizeExcerpt(candidate.tweet.text),
  score: candidate.score,
  category: candidate.category,
  reasons: candidate.reasons,
  metrics: candidate.tweet.metrics,
  metricsPartial: candidate.tweet.metricsPartial === true,
  engagement: candidate.engagement,
  parts: {
    heat: round(candidate.parts.heat),
    novelty: round(candidate.parts.novelty),
    density: round(candidate.parts.density),
    discussion: round(candidate.parts.discussion),
    relevance: round(candidate.parts.relevance),
  },
})

/**
 * Refresh the digest.
 * @returns {Promise<{ items: object[], shortlist: object[], summary: object }>}
 */
export async function buildDigest({ config, state, log, force = false, reason, signal, now = Date.now(), onProgress, onAccount }) {
  // The first run backfills a week so the card is not empty on install day.
  const firstRun = state.lastRefreshAt === null
  const windowHours = firstRun ? Math.max(config.windowHours, 24 * 7) : config.windowHours
  const gatherResult = await gather({ config, state, windowHours, now, force, log, signal, onProgress, onAccount })
  const accounts = new Map(config.accounts.map((account) => [account.handle.toLowerCase(), account]))

  const seenIds = new Set(state.seen)
  const dedupeText = new Set()
  const candidates = []
  let gated = 0

  for (const [handle, entry] of Object.entries(state.accounts)) {
    const account = accounts.get(handle.toLowerCase())
    if (!account || !Array.isArray(entry.tweets)) continue
    const baseline = median(entry.tweets.filter((tweet) => !tweet.isRetweet).map(engagement))
    for (const tweet of entry.tweets) {
      if (seenIds.has(tweet.id)) continue
      const gate = hardGate(tweet, account, { windowHours, now })
      if (gate !== undefined) {
        gated += 1
        continue
      }
      const fingerprint = tweet.text.replace(/\s+/g, ' ').trim().slice(0, 70).toLowerCase()
      if (dedupeText.has(fingerprint)) continue
      dedupeText.add(fingerprint)
      const scored = scoreTweet(tweet, account, { state, baselineEngagement: baseline, now, matchers: config.matchers })
      candidates.push({ tweet, account, ...scored })
    }
  }

  const eligible = candidates
    .filter((candidate) => candidate.score >= config.minScore)
    .sort((left, right) => right.score - left.score)

  const chosen = []
  const chosenThreads = new Set()
  const perAuthor = new Map()
  for (const candidate of eligible) {
    if (chosen.length >= config.maxItems) break
    if (chosenThreads.has(candidate.tweet.conversationId)) continue
    const handle = candidate.tweet.author.handle.toLowerCase()
    const used = perAuthor.get(handle) ?? 0
    if (used >= config.maxPerAuthor) continue
    perAuthor.set(handle, used + 1)
    chosenThreads.add(candidate.tweet.conversationId)
    chosen.push(candidate)
  }

  const items = chosen.map(toDigestItem)

  // The LLM editor is the real selector: it sees the whole gate-passed pool, not
  // just what the heuristic liked, so opinion, snark and hands-on posts that do
  // not look like announcements still get a chance. One voice may not flood it.
  const shortlistSeen = new Set()
  const shortlist = []
  const shortlistPerAuthor = new Map()
  for (const candidate of [...candidates].sort((left, right) => right.score - left.score)) {
    if (shortlist.length >= config.editorCandidates) break
    if (shortlistSeen.has(candidate.tweet.conversationId)) continue
    const handle = candidate.tweet.author.handle.toLowerCase()
    const used = shortlistPerAuthor.get(handle) ?? 0
    if (used >= config.editorPerAuthor) continue
    shortlistPerAuthor.set(handle, used + 1)
    shortlistSeen.add(candidate.tweet.conversationId)
    shortlist.push(toDigestItem(candidate))
  }

  markSeen(state, candidates.map((candidate) => candidate.tweet.id))
  pruneState(state, now)

  const summary = {
    at: new Date(now).toISOString(),
    industry: config.industry?.label ?? '',
    reason: firstRun ? 'first-run' : reason ?? (force ? 'manual' : 'scheduled'),
    windowHours,
    accounts: config.accounts.length,
    fetched: gatherResult.fetched,
    failed: gatherResult.failures,
    stale: gatherResult.stale,
    gated,
    candidates: candidates.length,
    eligible: eligible.length,
    chosen: items.length,
    threshold: config.minScore,
    shortlist: shortlist.length,
  }
  return { items, shortlist, summary }
}
