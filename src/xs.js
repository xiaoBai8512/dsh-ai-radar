/**
 * Public X access without an API key.
 *
 * Two live channels, both keyless:
 *   1. the profile / conversation page itself — x.com server-renders the most
 *      recent posts (with counts) into the HTML, so a plain GET with a browser
 *      user-agent yields the *recent* timeline. One request per account.
 *   2. the syndicated timeline payload — clean JSON, but for a good share of
 *      accounts it is the all-time top posts rather than the recent ones, so it
 *      is only a second opinion behind the page.
 *
 * The r.jina.ai reader hop that used to discover recent post ids is gone: it
 * now answers `401 AuthenticationRequiredError` for anonymous callers, which is
 * what the daily summary was reporting as "http 401" on 30 of 35 accounts.
 *
 * Network note: this machine reaches the internet through an HTTP proxy
 * (`http_proxy`/`https_proxy`), and the runtime's built-in `fetch` does not
 * honour those variables, so a direct connect fails. `httpGetText` tunnels
 * through the proxy when one is configured and otherwise uses `fetch`.
 */

import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

const ENDPOINT = 'https://syndication.twitter.com/srv/timeline-profile/screen-name/'

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export const delay = (ms, signal) => {
  if (ms <= 0) return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms)
    function finish() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    signal?.addEventListener('abort', finish, { once: true })
  })
}

const proxyUrl = () => {
  const raw = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined
  if (/^socks/i.test(raw)) return undefined
  try {
    const parsed = new URL(raw)
    return parsed.hostname.length > 0 ? parsed : undefined
  } catch {
    return undefined
  }
}

const tunnel = (proxy, host, port, timeoutMs) =>
  new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.hostname, port: Number(proxy.port) || 80 })
    const fail = (error) => {
      socket.destroy()
      reject(error)
    }
    socket.setTimeout(timeoutMs, () => fail(new Error('proxy connect timeout')))
    socket.once('error', fail)
    socket.once('connect', () => {
      socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`)
    })
    let buffer = ''
    const onData = (chunk) => {
      buffer += chunk.toString('latin1')
      const end = buffer.indexOf('\r\n\r\n')
      if (end === -1) return
      socket.off('data', onData)
      const status = buffer.slice(0, buffer.indexOf('\r\n'))
      if (!/ 200(?: |$)/.test(status)) {
        fail(new Error(`proxy CONNECT refused: ${status}`))
        return
      }
      socket.setTimeout(0)
      const secure = tls.connect({ socket, servername: host })
      secure.setTimeout(timeoutMs, () => fail(new Error('tls handshake timeout')))
      secure.once('error', fail)
      secure.once('secureConnect', () => resolve(secure))
    }
    socket.on('data', onData)
  })

/** Minimal HTTPS GET with proxy tunnelling; resolves to the response body text. */
export function httpGetText(url, { headers = {}, timeoutMs = 20000, signal } = {}) {
  const target = new URL(url)
  const proxy = proxyUrl()
  if (proxy === undefined) {
    return fetch(url, { headers, signal }).then(async (response) => ({
      status: response.status,
      text: await response.text(),
    }))
  }
  return tunnel(proxy, target.hostname, Number(target.port) || 443, timeoutMs).then(
    (socket) =>
      new Promise((resolve, reject) => {
        const request = http.request(
          {
            host: target.hostname,
            port: Number(target.port) || 443,
            path: `${target.pathname}${target.search}`,
            method: 'GET',
            headers,
            createConnection: () => socket,
          },
          (response) => {
            const chunks = []
            response.on('data', (chunk) => chunks.push(chunk))
            response.on('end', () => {
              socket.destroy()
              resolve({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') })
            })
            response.on('error', (error) => {
              socket.destroy()
              reject(error)
            })
          },
        )
        request.setTimeout(timeoutMs, () => {
          request.destroy(new Error('request timeout'))
        })
        request.on('error', (error) => {
          socket.destroy()
          reject(error)
        })
        if (signal) signal.addEventListener('abort', () => request.destroy(new Error('aborted')), { once: true })
        request.end()
      }),
  )
}

const decodeHtml = (text) =>
  text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")

const toIso = (value) => {
  const at = Date.parse(value)
  return Number.isFinite(at) ? new Date(at).toISOString() : null
}

/* ------------------------------------------------------------------ *
 * Channel 1: the server-rendered page
 *
 * x.com embeds the tweets it renders — for a profile the recent ones, for a
 * status page the post plus the replies it shows a logged-out visitor — as a
 * JSON payload inside the HTML, escaped one level. Everything needed is in
 * there: id, author, text, created_at_ms, and the full counts block, which is
 * strictly more than the embed endpoint gives (likes only).
 * ------------------------------------------------------------------ */

/**
 * Undo exactly one level of JSON-string escaping, left to right.
 *
 * The page embeds its payload as a JSON document inside a JS string literal, so
 * every escape is doubled: a real newline arrives as `\\n` and a quote inside a
 * post arrives as `\\\"`. Collapsing only the pairs that belong to the outer
 * layer (`\\` and `\"`) leaves a valid JSON document for `readJsonString`,
 * which then resolves the inner escapes. A regex with a lookbehind cannot do
 * this: it has to consume the escape pairs in order.
 */
const unescapeOnce = (html) => {
  let out = ''
  for (let index = 0; index < html.length; index += 1) {
    const char = html[index]
    if (char !== '\\') {
      out += char
      continue
    }
    const next = html[index + 1]
    if (next === '\\' || next === '"' || next === '/') {
      out += next
      index += 1
      continue
    }
    out += char
  }
  return out
}

/** Read a JSON string literal whose opening quote sits at `quoteAt`. */
const readJsonString = (text, quoteAt) => {
  let index = quoteAt + 1
  let out = ''
  while (index < text.length) {
    const char = text[index]
    if (char === '\\') {
      const next = text[index + 1]
      if (next === 'n') {
        out += '\n'
        index += 2
        continue
      }
      if (next === 't') {
        out += '\t'
        index += 2
        continue
      }
      if (next === 'r') {
        index += 2
        continue
      }
      if (next === '"' || next === '\\' || next === '/') {
        out += next
        index += 2
        continue
      }
      if (next === 'u') {
        const code = Number.parseInt(text.slice(index + 2, index + 6), 16)
        out += Number.isFinite(code) ? String.fromCharCode(code) : ''
        index += 6
        continue
      }
      out += next ?? ''
      index += 2
      continue
    }
    if (char === '"') return { text: out, end: index + 1 }
    out += char
    index += 1
  }
  return undefined
}

const TCO_URL = /"url":"(https:\/\/t\.co\/[A-Za-z0-9]+)"/g
const EXPANDED_URL = /"expanded_url":"([^"]+)"/g

/**
 * Rebuild links: the payload keeps the t.co shortener in the text and the real
 * target in the entity objects next to it. Pair each t.co link with the first
 * expansion that follows it, and drop media links (they add nothing to a card).
 */
const expandLinks = (text, block) => {
  const shorts = [...block.matchAll(TCO_URL)].map((match) => ({ at: match.index, short: match[1] }))
  const targets = [...block.matchAll(EXPANDED_URL)].map((match) => ({ at: match.index, url: match[1] }))
  let out = text
  for (const entry of shorts) {
    const target = targets.find((candidate) => candidate.at > entry.at && candidate.at - entry.at < 400)
    if (!target) continue
    const replacement = /\/status\/\d+\/(?:photo|video)\/\d+$/.test(target.url) ? '' : target.url
    out = out.split(entry.short).join(replacement)
  }
  return out.replace(/https?:\/\/t\.co\/[A-Za-z0-9]+/g, '')
}

const countOf = (block, key) => Number((block.match(new RegExp(`"${key}":(\\d+)`)) ?? [])[1]) || 0

const normalizeHtmlTweet = (block, id) => {
  const detailsAt = block.indexOf('"full_text":"')
  if (detailsAt === -1) return undefined
  const literal = readJsonString(block, detailsAt + '"full_text":'.length)
  if (!literal) return undefined
  const head = block.slice(0, detailsAt)

  const author = head.match(/"core":\{"name":"([^"]*)","screen_name":"([^"]+)"\}/)
  const screenName = author?.[2] ?? (head.match(/"screen_name":"([^"]+)"/) ?? [])[1]
  if (!screenName) return undefined

  const createdMs = Number((head.match(/"created_at_ms":(\d+)/) ?? [])[1])
  const legacyCreated = (head.match(/"created_at":"([^"]+)"/) ?? [])[1]
  const createdAt = Number.isFinite(createdMs) && createdMs > 0
    ? new Date(createdMs).toISOString()
    : legacyCreated
      ? toIso(legacyCreated)
      : null

  // `lang`, the sensitivity flag and the media entities of a post sit after its
  // text, so they are read from the whole block; the first match is the post's
  // own, because a quoted post's fields only appear further in.
  const lang = (block.match(/"lang":"([a-z-]+)"/) ?? [])[1] ?? 'und'

  const rawText = expandLinks(literal.text, block)
  const text = decodeHtml(rawText)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (text.length === 0) return undefined

  return {
    id,
    url: `https://x.com/${screenName}/status/${id}`,
    text,
    createdAt,
    lang,
    isRetweet: text.startsWith('RT @') || block.includes('"retweeted_status_result"'),
    sensitive: /"possibly_sensitive":true/.test(block),
    metrics: {
      like: countOf(head, 'favorite_count'),
      retweet: countOf(head, 'retweet_count'),
      reply: countOf(head, 'reply_count'),
      quote: countOf(head, 'quote_count'),
    },
    author: {
      handle: screenName,
      name: author?.[1] ?? screenName,
      followers: Number((head.match(/"followers":(\d+)/) ?? [])[1]) || 0,
      verified: /"is_blue_verified":true/.test(head),
    },
    hasLink: /https?:\/\/t\.co\//.test(literal.text) || /"expanded_url":"(?!https:\/\/x\.com\/[^"]*\/status\/)/.test(block),
    hasMedia: /"ext_media_availability"|"media_entities":\[\{/.test(block),
    conversationId: (block.match(/"conversation_id_str":"(\d+)"/) ?? [])[1] ?? id,
  }
}

/**
 * Every tweet rendered into one x.com page, in page order.
 * @returns {object[]} normalized posts
 */
export function parseHtmlTweets(html) {
  const flat = unescapeOnce(html)
  const anchors = []
  const anchor = /"tweet_results":\{"id":"[^"]*","rest_id":"(\d+)"/g
  let match
  while ((match = anchor.exec(flat)) !== null) anchors.push({ id: match[1], at: match.index })

  const tweets = []
  const seen = new Set()
  for (let index = 0; index < anchors.length; index += 1) {
    const { id, at } = anchors[index]
    if (seen.has(id)) continue
    const end = index + 1 < anchors.length ? anchors[index + 1].at : Math.min(flat.length, at + 24000)
    const tweet = normalizeHtmlTweet(flat.slice(at, end), id)
    if (!tweet) continue
    seen.add(id)
    tweets.push(tweet)
  }
  return tweets
}

/** The recent posts a profile page renders for a logged-out visitor. */
export async function fetchProfileTweets(handle, { signal } = {}) {
  let response
  try {
    response = await httpGetText(`https://x.com/${encodeURIComponent(handle)}`, {
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
      },
      timeoutMs: 25000,
      signal,
    })
  } catch (error) {
    return { ok: false, reason: `network: ${error?.message ?? String(error)}` }
  }
  if (response.status === 429) return { ok: false, reason: 'rate-limited' }
  if (response.status < 200 || response.status >= 300) return { ok: false, reason: `http ${response.status}` }
  const tweets = parseHtmlTweets(response.text).filter(
    (tweet) => tweet.author.handle.toLowerCase() === handle.toLowerCase(),
  )
  if (tweets.length === 0) return { ok: false, reason: 'no-tweets-rendered' }
  return { ok: true, tweets }
}

/** One post's page: the post plus the replies it renders, in page order. */
export async function fetchConversationTweets(url, { signal } = {}) {
  let response
  try {
    response = await httpGetText(url, {
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml',
        'accept-language': 'en-US,en;q=0.9',
      },
      timeoutMs: 30000,
      signal,
    })
  } catch (error) {
    return { ok: false, reason: `network: ${error?.message ?? String(error)}` }
  }
  if (response.status === 429) return { ok: false, reason: 'rate-limited' }
  if (response.status < 200 || response.status >= 300) return { ok: false, reason: `http ${response.status}` }
  const tweets = parseHtmlTweets(response.text)
  if (tweets.length === 0) return { ok: false, reason: 'nothing-rendered' }
  return { ok: true, tweets }
}

/* ------------------------------------------------------------------ *
 * Channel 2: the syndicated timeline payload
 * ------------------------------------------------------------------ */

/** Expand t.co links and strip the trailing media link the syndication payload appends. */
export function cleanText(tweet) {
  let text = typeof tweet.full_text === 'string' ? tweet.full_text : typeof tweet.text === 'string' ? tweet.text : ''
  const urls = tweet.entities?.urls ?? []
  for (const entry of urls) {
    if (typeof entry.url !== 'string') continue
    text = text.split(entry.url).join(entry.expanded_url ?? entry.display_url ?? '')
  }
  text = text.replace(/https?:\/\/t\.co\/[A-Za-z0-9]+/g, '')
  return decodeHtml(text)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** One normalized post, or undefined when the payload is not a usable post. */
function normalizeTweet(tweet) {
  if (!tweet || typeof tweet !== 'object') return undefined
  const id = typeof tweet.id_str === 'string' ? tweet.id_str : typeof tweet.id === 'string' ? tweet.id : undefined
  if (!id) return undefined
  const user = tweet.user && typeof tweet.user === 'object' ? tweet.user : {}
  const handle = typeof user.screen_name === 'string' ? user.screen_name : undefined
  if (!handle) return undefined
  const text = cleanText(tweet)
  if (text.length === 0) return undefined
  const isRetweet = Boolean(tweet.retweeted_status) || text.startsWith('RT @')
  return {
    id,
    url: typeof tweet.permalink === 'string' ? `https://x.com${tweet.permalink}` : `https://x.com/${handle}/status/${id}`,
    text,
    createdAt: toIso(tweet.created_at),
    lang: typeof tweet.lang === 'string' ? tweet.lang : 'und',
    isRetweet,
    sensitive: tweet.possibly_sensitive === true,
    metrics: {
      like: Number(tweet.favorite_count) || 0,
      retweet: Number(tweet.retweet_count) || 0,
      reply: Number(tweet.reply_count) || 0,
      quote: Number(tweet.quote_count) || 0,
    },
    author: {
      handle,
      name: typeof user.name === 'string' ? user.name : handle,
      followers: Number(user.followers_count) || 0,
      verified: user.is_blue_verified === true || user.verified === true,
    },
    hasLink: (tweet.entities?.urls ?? []).length > 0,
    hasMedia: (tweet.entities?.media ?? []).length > 0,
    conversationId: typeof tweet.conversation_id_str === 'string' ? tweet.conversation_id_str : id,
  }
}

const parseTimeline = (html) => {
  const match = html.match(/__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/)
  if (!match) return undefined
  const data = JSON.parse(match[1])
  const entries = data?.props?.pageProps?.timeline?.entries
  return Array.isArray(entries) ? entries : undefined
}

/**
 * Fetch one account's syndicated timeline.
 * @returns {Promise<{ ok: true, tweets: object[] } | { ok: false, reason: string }>}
 */
export async function fetchTimeline(handle, { signal, attempts = 2 } = {}) {
  let last = { ok: false, reason: 'unknown' }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (signal?.aborted) return { ok: false, reason: 'aborted' }
    let response
    try {
      response = await httpGetText(`${ENDPOINT}${encodeURIComponent(handle)}`, {
        headers: {
          'user-agent': USER_AGENT,
          accept: 'text/html,application/xhtml+xml',
          'accept-language': 'en-US,en;q=0.9',
        },
        signal,
      })
    } catch (error) {
      last = { ok: false, reason: `network: ${error?.message ?? String(error)}` }
      await delay(1500, signal)
      continue
    }
    if (response.status === 429) {
      last = { ok: false, reason: 'rate-limited' }
      await delay(12000, signal)
      continue
    }
    if (response.status < 200 || response.status >= 300) {
      last = { ok: false, reason: `http ${response.status}` }
      continue
    }
    let entries
    try {
      entries = parseTimeline(response.text)
    } catch (error) {
      last = { ok: false, reason: `parse: ${error?.message ?? String(error)}` }
      continue
    }
    if (!entries) {
      last = { ok: false, reason: 'unparsable payload' }
      continue
    }
    const tweets = entries
      .map((entry) => (entry?.content?.tweet ? normalizeTweet(entry.content.tweet) : undefined))
      .filter(Boolean)
    return { ok: true, tweets }
  }
  return last
}
