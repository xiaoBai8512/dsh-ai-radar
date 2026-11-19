/**
 * Question mining: what are people actually asking and tripping over?
 *
 * Sources have different shapes:
 *   - X replies: a couple of top replies per post when logged out, targeted at
 *     the exact posts that got attention, so few but on point.
 *   - HN comments: fully readable, many per day, written by the people who hit
 *     the concrete tooling problems. This is where the volume comes from.
 *
 * The pool accumulates across days, then the model clusters it into recurring
 * questions plus a concrete content angle for each.
 */

import { collectText, parseJsonObject, resolveEditorRoute } from './editor.js'

const MAX_QUESTION_CHARS = 240
const MAX_POOL_FOR_MODEL = 90
const X_QUOTA = 30
const MAX_TOKENS = 2600

const CLUSTER_PROMPT = `你是内容策划，服务一个做 AI 科普内容（「白科闪点」）的作者。输入是一批真实评论/回复（来自 X 和 Hacker News），每条有 id。

任务：找出反复出现的**工具实操与踩坑**问题，聚成 3~5 类，给作者能直接开做的选题。

只聚这类：怎么装/怎么配/怎么迁移、报错与不生效、速度与性能、配额与价格、上下文限制、几个工具怎么选。
不聚：纯情绪、立场争论、商业分析、纯理论、单纯夸赞。

规则：
- 类别之间必须能区分开；同一件事不要拆两类。
- 只聚输入里出现过的，禁止编造。
- 每类给 angle：具体选题角度——从哪个现象切入、这条内容回答什么，≤40 字。

输出 JSON：
{"overall":"这批评论反映的整体情况，≤40 字",
 "themes":[{"theme":"这一类在问什么/踩什么坑，≤18 字，中文","angle":"可直接开做的选题角度，≤40 字","qs":["属于这一类的 id 全部列上"],"examples":["1~2 条最典型的原文，翻译成中文，≤60 字"]}]}
只输出 JSON，不要 Markdown 代码块。`

const QUESTION_START =
  /^(how|why|what|when|where|which|who|can|could|do|does|did|is|are|was|were|should|would|will|anyone|anybody|has|have|is there|are there)\b/i

const QUESTION_WORDS =
  /(怎么|怎么样|如何|为什么|为何|能不能|可不可以|有没有|是不是|支不支持|能否|在哪|什么时候|请问|有人试过|有人知道|想问|求解|报错|踩坑|不生效|卡住|配不起来)/

/** Concrete pain patterns: not questions, but exactly what makes a topic. */
const TROUBLE =
  /(doesn'?t work|does not work|not working|won'?t work|can'?t get|can not get|can'?t install|failed to|keeps? failing|error\b|exception\b|timed? out|rate limit|out of (memory|credits)|too expensive|switched (back )?(from|to)|migrat(e|ed|ing) (from|to|away)|instead of|workaround|anyone (else )?(got|had|seen|tried)|is there (a|any) way|worth (it|switching)|how (do|does|can) (i|you|we)|setup|configure|config|token limit|context window)/i

/** Does this comment carry a question, a concrete complaint, or a real need? */
export const isQuestion = (text) => {
  const trimmed = text.trim()
  if (trimmed.length < 20) return false
  if (/[?？]\s*$/.test(trimmed)) return true
  if (QUESTION_START.test(trimmed)) return true
  if (QUESTION_WORDS.test(trimmed)) return true
  if (TROUBLE.test(trimmed)) return true
  return false
}

const normalizeKey = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, ' ')
    .trim()
    .slice(0, 100)

/**
 * Add replies/comments to the rolling pool.
 * @returns {{ pool: object[], added: number }}
 */
export function accumulateQuestions({ pool, replies, now = Date.now(), poolDays = 7 }) {
  const cutoff = now - poolDays * 24 * 60 * 60 * 1000
  const kept = (Array.isArray(pool) ? pool : []).filter((entry) => {
    const at = Date.parse(entry.at ?? '')
    return Number.isFinite(at) && at >= cutoff
  })
  const seen = new Set(kept.map((entry) => entry.key))
  let added = 0
  for (const reply of replies) {
    if (!isQuestion(reply.text)) continue
    const key = normalizeKey(reply.text)
    if (key.length < 14 || seen.has(key)) continue
    seen.add(key)
    kept.push({
      key,
      text: reply.text.slice(0, MAX_QUESTION_CHARS),
      handle: reply.handle,
      url: reply.url,
      rootId: reply.rootId,
      source: reply.source === 'hn' ? 'hn' : 'x',
      storyTitle: reply.storyTitle,
      like: reply.like ?? 0,
      at: reply.createdAt ?? new Date(now).toISOString(),
    })
    added += 1
  }
  return { pool: kept, added }
}

/** Recent comments first, with a reserved slice for the scarce X replies. */
const sampleForModel = (pool, limit = MAX_POOL_FOR_MODEL) => {
  const sorted = [...pool].sort((left, right) => {
    const leftAt = Date.parse(left.at ?? '') || 0
    const rightAt = Date.parse(right.at ?? '') || 0
    return rightAt - leftAt
  })
  const x = sorted.filter((entry) => entry.source !== 'hn').slice(0, X_QUOTA)
  const hn = sorted.filter((entry) => entry.source === 'hn').slice(0, Math.max(0, limit - x.length))
  return [...x, ...hn].slice(0, limit)
}

const buildPrompt = (sample) => {
  const comments = sample.map((entry, index) => ({
    id: `q${index + 1}`,
    from: entry.source === 'hn' ? 'hn' : 'x',
    text: entry.text,
  }))
  return JSON.stringify({ comments })
}

const CLUSTER_SAMPLE = 30
const CLUSTER_MAX_TOKENS = 6000

const callJson = async ({ llm, route, system, payload, maxTokens, signal }) => {
  const collected = await collectText(
    llm.stream({
      provider: route.provider,
      model: route.model,
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: JSON.stringify(payload) }] }],
      maxTokens,
      temperature: 0.15,
      signal,
    }),
  )
  if (collected.text.trim().length === 0) {
    return { ok: false, error: `empty reply (finish=${collected.finishKind || 'unknown'})` }
  }
  const parsed = parseJsonObject(collected.text)
  if (!parsed) return { ok: false, error: `unparsable reply: ${collected.text.slice(0, 80)}` }
  return { ok: true, parsed }
}

/**
 * Cluster the pooled comments into recurring questions with content angles.
 *
 * The extraction stage is heuristic on purpose: a reasoning model asked to
 * rewrite dozens of comments tends to burn the whole output budget on thoughts
 * and return nothing. So the model only ever sees a short list of comments and
 * produces a small themed reply.
 *
 * @returns {Promise<{ ok: true, themes: object[], overall: string } | { ok: false, error: string }>}
 */
export async function clusterQuestions({ pool, config, llm, agentDefaultModel, log, signal }) {
  if (!Array.isArray(pool) || pool.length < 8) return { ok: false, error: `pool too small (${pool?.length ?? 0})` }
  if (!llm || typeof llm.stream !== 'function') return { ok: false, error: 'llm service unavailable' }
  const route = await resolveEditorRoute({ llm, config, agentDefaultModel, log })
  if (!route) return { ok: false, error: 'no model route' }

  const sample = sampleForModel(pool, CLUSTER_SAMPLE)
  const comments = sample.map((entry, index) => ({
    id: `q${index + 1}`,
    from: entry.source === 'hn' ? 'hn' : 'x',
    text: entry.text.length > 180 ? `${entry.text.slice(0, 180)}…` : entry.text,
  }))

  const attempts = [comments, comments.slice(0, Math.ceil(comments.length / 2))]
  let clustered
  for (const attempt of attempts) {
    clustered = await callJson({
      llm,
      route,
      system: CLUSTER_PROMPT,
      payload: { comments: attempt },
      maxTokens: CLUSTER_MAX_TOKENS,
      signal,
    })
    if (clustered.ok && Array.isArray(clustered.parsed.themes)) break
  }
  if (!clustered.ok || !Array.isArray(clustered.parsed.themes)) {
    return { ok: false, error: clustered.error ?? 'no themes' }
  }

  const themes = []
  for (const theme of clustered.parsed.themes) {
    if (!theme || typeof theme.theme !== 'string') continue
    const ids = Array.isArray(theme.qs) ? theme.qs.filter((id) => typeof id === 'string') : []
    const members = []
    for (const id of ids) {
      const match = id.match(/^q(\d+)$/)
      if (!match) continue
      const entry = comments[Number(match[1]) - 1]
      const original = entry ? sample[Number(match[1]) - 1] : undefined
      if (original) members.push(original)
    }
    if (members.length === 0) continue
    const examples = Array.isArray(theme.examples)
      ? theme.examples.filter((example) => typeof example === 'string' && example.trim().length > 0).slice(0, 2)
      : members.slice(0, 2).map((member) => member.text)
    themes.push({
      theme: theme.theme.trim(),
      angle: typeof theme.angle === 'string' ? theme.angle.trim() : '',
      count: members.length,
      sources: {
        x: members.filter((member) => member.source !== 'hn').length,
        hn: members.filter((member) => member.source === 'hn').length,
      },
      examples,
      quality: members.reduce((sum, member) => sum + (member.like ?? 0), 0),
      links: [...new Set(members.map((member) => member.url).filter(Boolean))].slice(0, 3),
    })
  }
  if (themes.length === 0) return { ok: false, error: 'no themes after mapping' }
  themes.sort((left, right) => right.count - left.count || right.quality - left.quality)
  const kept = themes.slice(0, config.questionClusters)
  const overall = typeof clustered.parsed.overall === 'string' ? clustered.parsed.overall.trim() : ''
  log?.(
    `questions (${route.provider}/${route.model}): ${pool.length} pooled, ${sample.length} sampled, ` +
      `${themes.length} themes, kept ${kept.length}`,
  )
  return { ok: true, themes: kept, overall, model: `${route.provider}/${route.model}`, sampled: sample.length }
}
