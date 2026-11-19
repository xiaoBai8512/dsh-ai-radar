/**
 * Read one post's page and pull out the replies it renders for a logged-out
 * visitor.
 *
 * What is reachable: the post plus a handful of top replies. What is not: the
 * full reply list, or any pagination. The question miner therefore aggregates a
 * rolling pool across posts and days instead of counting one thread.
 *
 * Source: the page itself — x.com server-renders the post and its replies into
 * the HTML, counts included. The r.jina.ai reader hop that used to turn that
 * page into markdown now answers `401 AuthenticationRequiredError` to anonymous
 * callers, which silently killed the X half of the question pool.
 */

import { fetchConversationTweets } from './xs.js'

const MAX_REPLY_CHARS = 600

/** Fetch and parse one post's conversation. */
export async function fetchConversation(url, rootId, { signal } = {}) {
  const page = await fetchConversationTweets(url, { signal })
  if (!page.ok) return { ok: false, reason: page.reason }

  const root = page.tweets.find((tweet) => tweet.id === rootId) ?? page.tweets[0]
  const rootReplyCount = root?.metrics?.reply
  const replies = page.tweets
    .filter((tweet) => tweet.id !== root?.id && !tweet.isRetweet)
    .map((tweet) => ({
      id: tweet.id,
      handle: tweet.author.handle,
      url: tweet.url,
      text: tweet.text.replace(/\s+/g, ' ').trim().slice(0, MAX_REPLY_CHARS),
      createdAt: tweet.createdAt ?? undefined,
      replyCount: tweet.metrics.reply,
      like: tweet.metrics.like,
      rootId: rootId ?? root?.id,
      source: 'x',
    }))
    .filter((reply) => reply.text.length >= 12)

  if (replies.length === 0) return { ok: false, reason: 'no-replies-rendered', rootReplyCount }
  return { ok: true, replies, rootReplyCount }
}
