/**
 * The editorial standard: hard gates first, then five weighted signals.
 * heat 25 · novelty 25 · density 20 · discussion 15 · relevance 15.
 */

const clamp01 = (value) => Math.min(1, Math.max(0, value))

const HOUR = 60 * 60 * 1000

const ALLOWED_LANGS = new Set(['en', 'zh', 'ja', 'und', ''])

const BLOCKED = [
  /\bwe(?:'| a)?re hiring\b/i,
  /\bnow hiring\b/i,
  /\bjob (?:opening|alert)s?\b/i,
  /\bgiveaway\b/i,
  /\bairdrop\b/i,
  /\breferral\b/i,
  /\bpromo code\b/i,
  /\bdiscount code\b/i,
  /\bwebinar\b/i,
  /\bregister (?:now|today)\b/i,
  /\blink in bio\b/i,
  /\bdm me\b/i,
  /\bsponsored\b/i,
  /\bprice (?:drop|cut)\b/i,
  /\b(?:join|follow) (?:our|my) (?:telegram|discord|whatsapp)\b/i,
  /\bfollow (?:me|us) (?:for|to)\b/i,
  /\bwin a\b/i,
]

const LAUNCH = /\b(introduc\w*|releas\w*|unveil\w*|announc\w*|now available|open[- ]?sourc\w*|we built|launch\w*|ships?|shipping)\b/i
const RESEARCH = /\b(arxiv|paper|benchmark|bench|eval\w*|dataset|sota|ablation)\b/i
const ENGINEERING = /\b(github|repo|open[- ]?source|mit license|library|sdk|api|cli|docker|pip install|npm i|git clone|self[- ]host)\b/i
const DATAISH = /(\d+\s?%|\d+(?:\.\d+)?\s?x\b|×|\b\d+(?:\.\d+)?\s?(?:tokens?|b|m|k)\b|\baccuracy\b|\bscore\b|\blatency\b|\bms\b|\bthroughput\b|SOTA)/i
const CODEISH = /```|npm i\b|pip install\b|git clone\b|curl \b|^import |^from .* import /im
// The vertical's own vocabulary lives in the industry pack (src/industry.js),
// so nothing here names a field. What stays global is the shape of a checkable
// claim: a version number, a benchmark name, an all-caps acronym.
const BENCH_TERM = /\b[a-z0-9]{2,20}-?(?:bench|benchmark|eval)\b/gi
const ACRONYM = /\b[A-Z]{3,6}\b/g
const DULL_ACRONYMS = new Set(['API', 'GPU', 'CPU', 'LLM', 'IDE', 'CLI', 'SDK', 'USD', 'CEO', 'CTO', 'PDF', 'URL', 'USA', 'NEW', 'THE', 'AND', 'AI', 'RIP', 'FAQ'])

/** Salient, checkable terms: the only thing novelty is allowed to key on. */
const ASCII_DASHES = /[\u2010-\u2015\u2212]/g

export function extractTerms(text, matchers) {
  const terms = new Set()
  const normalized = text.replace(ASCII_DASHES, '-')
  if (matchers?.brand) {
    for (const match of normalized.matchAll(matchers.brand)) terms.add(match[0].toLowerCase().replace(/\s+/g, '-'))
  }
  for (const match of normalized.matchAll(BENCH_TERM)) terms.add(match[0].toLowerCase())
  for (const match of normalized.matchAll(ACRONYM)) {
    const acronym = match[0].toLowerCase()
    if (DULL_ACRONYMS.has(match[0])) continue
    // Skip an acronym that is only the brand half of a model term already found.
    if ([...terms].some((term) => term.startsWith(`${acronym}-`) || term.startsWith(`${acronym} `))) continue
    terms.add(acronym)
  }
  return [...terms].slice(0, 8)
}

const engagementOf = (tweet) =>
  tweet.metrics.like + 2 * tweet.metrics.retweet + 2 * tweet.metrics.reply + 2 * tweet.metrics.quote

export const median = (values) => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

/** Hard gates: anything that fails here never reaches the score. */
export function hardGate(tweet, account, { windowHours, now }) {
  if (tweet.isRetweet) return 'retweet'
  if (tweet.sensitive) return 'sensitive'
  if (!tweet.createdAt) return 'no-timestamp'
  const age = now - Date.parse(tweet.createdAt)
  if (!(age >= -2 * HOUR && age <= windowHours * HOUR)) return 'outside-window'
  if (tweet.author.handle.toLowerCase() !== account.handle.toLowerCase()) return 'not-author'
  if (!ALLOWED_LANGS.has(tweet.lang)) return 'language'
  if (tweet.author.followers > 0 && tweet.author.followers < 400) return 'low-followers'
  const minimumLength = account.tier === 1 ? 24 : 55
  if (tweet.text.length < minimumLength) return 'too-short'
  if (!/[\p{L}]/u.test(tweet.text)) return 'no-letters'
  if (tweet.text.replace(/[\s\p{Emoji}]/gu, '').length < minimumLength * 0.6) return 'emoji-only'
  for (const pattern of BLOCKED) if (pattern.test(tweet.text)) return 'promotional'
  // A small account's post needs some traction; labs are exempt because the
  // announcement itself is the news.
  if (account.tier > 1) {
    const traction =
      tweet.metrics.like +
      2 * tweet.metrics.retweet +
      2 * tweet.metrics.reply +
      2 * tweet.metrics.quote
    const floor = account.tier === 2 ? 100 : 150
    if (traction < floor) return 'low-engagement'
  }
  return undefined
}

function heatSignal(tweet, baselineEngagement) {
  const engagement = engagementOf(tweet)
  const followers = tweet.author.followers
  const expected = Math.max(40, baselineEngagement > 0 ? baselineEngagement : followers * 0.0012)
  const ratio = engagement / expected
  const score = clamp01((Math.log10(engagement + 10) - Math.log10(expected + 10)) / 2.1)
  return { score, ratio, engagement }
}

function noveltySignal(tweet, state, now, matchers) {
  const terms = extractTerms(tweet.text, matchers)
  const fresh = terms.filter((term) => !state.terms[term])
  const termScore = terms.length > 0 ? fresh.length / terms.length : 0
  const launchBonus = LAUNCH.test(tweet.text) ? 1 : RESEARCH.test(tweet.text) ? 0.6 : 0.25
  const score = clamp01(0.55 * termScore + 0.45 * launchBonus)
  for (const term of terms) if (!state.terms[term]) state.terms[term] = new Date(now).toISOString()
  return { score, terms, fresh }
}

function densitySignal(tweet) {
  let score = 0
  if (tweet.hasLink) score += 0.28
  if (DATAISH.test(tweet.text)) score += 0.24
  if (CODEISH.test(tweet.text)) score += 0.14
  const length = tweet.text.length
  if (length >= 90 && length <= 900) score += 0.2
  else if (length > 40) score += 0.1
  if (tweet.hasMedia) score += 0.04
  return clamp01(score)
}

function discussionSignal(tweet) {
  const { like, reply, quote } = tweet.metrics
  const replyRatio = reply / Math.max(1, like)
  const quoteRatio = quote / Math.max(1, like)
  return { score: clamp01(replyRatio * 2.4 + quoteRatio * 1.6), replyRatio }
}

function relevanceSignal(tweet, account, matchers) {
  const hits = new Set(matchers?.relevance ? [...tweet.text.matchAll(matchers.relevance)].map((hit) => hit[0].toLowerCase()) : [])
  let score = clamp01(hits.size * 0.16)
  if (account.tier === 1) score = clamp01(score + 0.3)
  else if (account.tier === 2) score = clamp01(score + 0.12)
  return score
}

// Neutral keys: the label is the client's job and the pack decides the field,
// so a beauty pack should not have to publish "model-release" anywhere.
const CATEGORY = (tweet, account, replyRatio) => {
  if (account.tier === 1 && LAUNCH.test(tweet.text)) return 'release'
  if (RESEARCH.test(tweet.text)) return 'research'
  if (ENGINEERING.test(tweet.text)) return 'engineering'
  if (replyRatio > 0.18) return 'debate'
  return 'industry'
}

/**
 * Score one gated post.
 * @returns {{ score: number, parts: object, reasons: { key: string, params?: object }[], category: string }}
 */
export function scoreTweet(tweet, account, { state, baselineEngagement, now, matchers }) {
  const heat = heatSignal(tweet, baselineEngagement)
  const novelty = noveltySignal(tweet, state, now, matchers)
  const density = densitySignal(tweet)
  const discussion = discussionSignal(tweet)
  const relevance = relevanceSignal(tweet, account, matchers)
  const parts = {
    heat: heat.score,
    novelty: novelty.score,
    density,
    discussion: discussion.score,
    relevance,
  }
  // A partial-metrics source carries no reply/quote counts; fold its weight
  // into the remaining signals instead of penalising the post for it.
  const weights = { heat: 0.25, novelty: 0.25, density: 0.2, discussion: 0.15, relevance: 0.15 }
  if (tweet.metricsPartial === true) weights.discussion = 0
  const totalWeight = Object.values(weights).reduce((sum, value) => sum + value, 0)
  const score = Math.round(
    100 * Object.entries(weights).reduce((sum, [key, weight]) => sum + (weight / totalWeight) * parts[key], 0),
  )
  const reasons = []
  if (heat.score >= 0.55) reasons.push({ key: 'heat', params: { ratio: Math.round(heat.ratio) } })
  if (novelty.score >= 0.55 && novelty.fresh.length > 0) {
    reasons.push({ key: 'novelty', params: { terms: novelty.fresh.slice(0, 2).join(', ') } })
  }
  if (density >= 0.55) reasons.push({ key: 'density' })
  if (discussion.score >= 0.5) {
    reasons.push({ key: 'debate', params: { percent: Math.round(discussion.replyRatio * 100) } })
  }
  if (relevance >= 0.75) reasons.push({ key: 'relevance' })
  if (account.tier === 1) reasons.push({ key: 'primary' })
  return {
    score,
    parts,
    reasons: reasons.slice(0, 3),
    category: CATEGORY(tweet, account, discussion.replyRatio),
    engagement: heat.engagement,
  }
}
