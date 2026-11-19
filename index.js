/** Host half of AI Radar: fetch, score, persist, and serve the daily digest. */

import { normalizeConfig } from './src/config.js'
import { buildDigest } from './src/digest.js'
import { runEditor } from './src/editor.js'
import { accumulateQuestions, clusterQuestions } from './src/questions.js'
import { fetchConversation } from './src/replies.js'
import { fetchHnComments } from './src/hn.js'
import { delay } from './src/xs.js'
import { loadState, saveState } from './src/state.js'

export const inject = ['webServer']

const ROUTE = '/plugins/ai-radar'
const STARTUP_CATCH_UP_HOURS = 6
// Source order lives in src/digest.js: the profile page first (recent posts,
// full counts), the syndicated timeline only as the second opinion.

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const state = loadState(config)
  const log = (message) => {
    try {
      ctx.logger?.info?.(`ai-radar: ${message}`)
    } catch {
      /* logging must never break the plugin */
    }
  }

  let running = null
  let lastError = null
  let progress = null

  const snapshot = () => ({
    updatedAt: state.lastRefreshAt,
    digest: state.digest,
    summary: state.lastSummary,
    running: running !== null,
    progress,
    error: lastError,
    accounts: config.accounts.map((account) => ({ handle: account.handle, tier: account.tier, label: account.label })),
    threshold: config.minScore,
    editor: config.editor,
    editorState: state.lastSummary?.editor ?? null,
    overall: state.lastSummary?.editor?.overall ?? '',
    questions: {
      at: state.questionsAt,
      poolSize: state.questionPool.length,
      themes: state.questionClusters,
      overall: state.questionOverall,
      error: state.questionError,
    },
    maxItems: config.maxItems,
    maxPerAuthor: config.maxPerAuthor,
    windowHours: config.windowHours,
    refreshHour: config.refreshHour,
  })

  /**
   * Mine the reply sections of the posts people actually argued about, keep a
   * rolling pool of questions, and cluster it into topic angles.
   */
  const mineQuestions = async (shortlist) => {
    if (!config.questions) return
    let scanned = 0
    let added = 0

    // Reply counts are missing for posts served through the profile fallback, so
    // rank by overall loudness and let the conversation page report its own count.
    const loudness = (item) => (item.metrics?.reply ?? 0) * 4 + (item.metrics?.like ?? 0) / 8
    const sources = [...shortlist]
      .filter((item) => typeof item.url === 'string' && item.id)
      .sort((left, right) => loudness(right) - loudness(left))
      .slice(0, config.questionPosts)

    const refetchMs = config.questionRefetchHours * 60 * 60 * 1000
    for (const item of sources) {
      const last = state.questionPosts[item.id]
      const lastAt = last ? Date.parse(last) : Number.NaN
      if (Number.isFinite(lastAt) && Date.now() - lastAt < refetchMs) continue
      const result = await fetchConversation(item.url, item.id)
      state.questionPosts[item.id] = new Date().toISOString()
      if (result.ok && result.rootReplyCount !== undefined && result.rootReplyCount < config.questionMinReplies) {
        log(`questions: @${item.author.handle} skipped (${result.rootReplyCount} replies)`)
        continue
      }
      if (result.ok) {
        const merged = accumulateQuestions({
          pool: state.questionPool,
          replies: result.replies,
          poolDays: config.questionPoolDays,
        })
        state.questionPool = merged.pool
        added += merged.added
        scanned += 1
      } else {
        log(`questions: @${item.author.handle} conversation unavailable (${result.reason})`)
      }
      await delay(2500)
    }

    // HN supplies the volume that a logged-out X reply section never will.
    if (config.hn) {
      const hn = await fetchHnComments({
        queries: config.hnQueries,
        days: config.hnDays,
        perQuery: config.hnPerQuery,
      })
      if (hn.ok) {
        const merged = accumulateQuestions({
          pool: state.questionPool,
          replies: hn.comments,
          poolDays: config.questionPoolDays,
        })
        state.questionPool = merged.pool
        added += merged.added
        log(`questions: HN ${hn.comments.length} comments scanned, +${merged.added}`)
      } else {
        log(`questions: HN unavailable (${hn.reason})`)
      }
    }

    if (state.questionPool.length < 8) {
      state.questionError = `pool too small (${state.questionPool.length})`
      return
    }
    const clustered = await clusterQuestions({
      pool: state.questionPool,
      config,
      llm: ctx.get('llm'),
      agentDefaultModel: ctx.get('agentDefaultModel'),
      log,
    })
    if (clustered.ok) {
      state.questionClusters = clustered.themes
      state.questionOverall = clustered.overall
      state.questionsAt = new Date().toISOString()
      state.questionError = null
      log(`questions: ${scanned} threads scanned, +${added} questions, ${clustered.themes.length} themes`)
    } else {
      state.questionError = clustered.error
      log(`questions: clustering failed (${clustered.error})`)
    }
  }

  const refresh = (reason, force) => {
    if (running !== null) return running
    const began = Date.now()
    running = (async () => {
      try {
        // A full pass takes minutes; persist account by account so a crash or a
        // restart mid-run never throws away what was already fetched.
        const persist = () => {
          try {
            saveState(config, state)
          } catch {
            /* the final save below reports a real failure */
          }
        }
        const { items, shortlist, summary } = await buildDigest({
          config,
          state,
          log,
          force,
          reason,
          onProgress: persist,
          onAccount: (step) => {
            progress = step
          },
        })
        // LLM editorial pass: keep/reject, rank, translate, and write the reason.
        let published = items
        let overall = ''
        if (config.editor) {
          const edited = await runEditor({
            shortlist,
            config,
            llm: ctx.get('llm'),
            agentDefaultModel: ctx.get('agentDefaultModel'),
            log,
          })
          if (edited.ok) {
            published = edited.items
            overall = edited.overall
            summary.editor = { ok: true, model: edited.model, kept: edited.kept, overall }
          } else {
            summary.editor = { ok: false, error: edited.error }
          }
        } else {
          summary.editor = { ok: false, error: 'disabled' }
        }

        // "Check now" is non-destructive: an empty manual pass keeps whatever is
        // published. The scheduled pass owns the daily edition and may be empty.
        const keptPrevious = published.length === 0 && reason === 'manual' && state.digest.length > 0
        state.digest = keptPrevious ? state.digest : published
        summary.keptPrevious = keptPrevious

        try {
          await mineQuestions(shortlist)
          summary.questions = {
            pool: state.questionPool.length,
            themes: state.questionClusters.length,
            error: state.questionError,
          }
        } catch (error) {
          state.questionError = error?.message ?? String(error)
          log(`questions: mining failed (${state.questionError})`)
        }
        state.lastRefreshAt = summary.at
        state.lastSummary = summary
        lastError = null
        saveState(config, state)
        log(
          `refreshed (${reason}): ${items.length} kept, ${summary.candidates} candidates, ` +
            `${summary.gated} gated, ${summary.stale.length} stale, ${summary.failed.length} failed, ` +
            `${config.accounts.length} accounts, ${Date.now() - began}ms`,
        )
        return { ok: true, summary, count: items.length }
      } catch (error) {
        lastError = error?.message ?? String(error)
        log(`refresh failed: ${lastError}`)
        try {
          saveState(config, state)
        } catch {
          /* keep the last durable snapshot */
        }
        return { ok: false, error: lastError }
      } finally {
        running = null
        progress = null
      }
    })()
    return running
  }

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE,
      handler: async (req, res) => {
        const pathname = new URL(req.url ?? '/', 'http://localhost').pathname
        req.resume()
        if (pathname === `${ROUTE}/digest`) {
          if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method-not-allowed' })
          return sendJson(res, 200, snapshot())
        }
        if (pathname === `${ROUTE}/refresh`) {
          if (req.method !== 'POST') return sendJson(res, 405, { error: 'method-not-allowed' })
          refresh('manual', false)
          return sendJson(res, 202, { started: true, state: snapshot() })
        }
        return sendJson(res, 404, { error: 'not-found' })
      },
    }),
  )

  const msUntilNextRun = () => {
    const now = new Date()
    const next = new Date(now)
    next.setHours(config.refreshHour, 0, 0, 0)
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1)
    return next.getTime() - now.getTime()
  }

  ctx.effect(() => {
    let timer
    const schedule = () => {
      timer = setTimeout(() => {
        refresh('scheduled', true).finally(schedule)
      }, msUntilNextRun())
      timer.unref?.()
    }
    schedule()
    return () => clearTimeout(timer)
  })

  ctx.effect(() => {
    if (!config.enabled) return undefined
    const last = state.lastRefreshAt ? Date.parse(state.lastRefreshAt) : Number.NaN
    const stale = !Number.isFinite(last) || Date.now() - last > STARTUP_CATCH_UP_HOURS * 60 * 60 * 1000
    if (!stale) return undefined
    const timer = setTimeout(() => {
      refresh('startup', true)
    }, 2500)
    timer.unref?.()
    return () => clearTimeout(timer)
  })

  log(`ready: ${config.accounts.length} accounts, refresh at ${config.refreshHour}:00, threshold ${config.minScore}`)
}
