/**
 * Hacker News comment mining through the public Algolia API.
 *
 * X only renders a couple of top replies per post when logged out, so the
 * volume that makes "recurring questions" meaningful comes from here: HN
 * comments are fully readable, on-topic, and written by the same people who
 * actually hit the tooling problems.
 */

import { httpGetText } from './xs.js'

const MAX_CHARS = 600

const decodeEntities = (text) =>
  text
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, '/')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))

/** HN comment HTML is plain paragraphs, links, and code blocks. */
export const htmlToText = (html) =>
  decodeEntities(
    String(html ?? '')
      .replace(/<p>/gi, ' ')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' '),
  ).trim()

/** Recent comments mentioning one query. */
async function searchComments(query, { cutoff, perPage, signal }) {
  const url = new URL('https://hn.algolia.com/api/v1/search_by_date')
  url.searchParams.set('query', query)
  url.searchParams.set('tags', 'comment')
  url.searchParams.set('numericFilters', `created_at_i>${cutoff}`)
  url.searchParams.set('hitsPerPage', String(perPage))
  let response
  try {
    response = await httpGetText(url.toString(), {
      headers: { accept: 'application/json' },
      timeoutMs: 20000,
      signal,
    })
  } catch (error) {
    return { ok: false, reason: `network: ${error?.message ?? String(error)}` }
  }
  if (response.status < 200 || response.status >= 300) return { ok: false, reason: `http ${response.status}` }
  let payload
  try {
    payload = JSON.parse(response.text)
  } catch {
    return { ok: false, reason: 'unparsable payload' }
  }
  if (!Array.isArray(payload.hits)) return { ok: false, reason: 'no hits' }
  return { ok: true, hits: payload.hits }
}

/**
 * Recent HN comments across several queries, deduplicated and normalized into
 * the same shape the question pool uses for X replies.
 * @returns {Promise<{ ok: true, comments: object[], total: number } | { ok: false, reason: string }>}
 */
export async function fetchHnComments({ queries, days = 7, perQuery = 60, signal }) {
  const cutoff = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60
  const comments = []
  const seen = new Set()
  let total = 0
  for (const query of queries) {
    const result = await searchComments(query, { cutoff, perPage: perQuery, signal })
    if (!result.ok) continue
    total += result.hits.length
    for (const hit of result.hits) {
      const id = hit?.objectID
      if (typeof id !== 'string' || seen.has(id)) continue
      const text = htmlToText(hit.comment_text).slice(0, MAX_CHARS)
      if (text.length < 20) continue
      seen.add(id)
      comments.push({
        id,
        handle: hit.author ?? 'someone',
        url: `https://news.ycombinator.com/item?id=${id}`,
        text,
        createdAt: new Date((Number(hit.created_at_i) || 0) * 1000).toISOString(),
        like: Number(hit.points) || 0,
        storyTitle: typeof hit.story_title === 'string' ? hit.story_title : undefined,
        source: 'hn',
        rootId: hit.story_id ? String(hit.story_id) : undefined,
      })
    }
  }
  if (comments.length === 0) return { ok: false, reason: 'no comments' }
  return { ok: true, comments, total }
}
