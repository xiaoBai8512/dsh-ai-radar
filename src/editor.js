/**
 * The LLM editorial layer: a second pass over the heuristic shortlist that
 * rejects what does not deserve the time, ranks what survives, translates each
 * kept post into Chinese, and writes the one-line reason to read it.
 *
 * The shortlist is batched: a long JSON reply can exhaust the output budget
 * before any text is emitted, so each call stays small and a failed batch is
 * retried once with a shorter prompt instead of losing the whole pass.
 */

const HOOKS = new Set(['争议', '实测', '新玩法', '内幕', '突破', '观点', '工具'])
const MAX_POST_CHARS = 600
const RETRY_POST_CHARS = 260
const MAX_TOKENS = 4000

const SYSTEM_PROMPT = `你是「AI 雷达」的编辑，服务一个对 AI 好奇、平时动手做东西的工程读者。目标只有一个：从他的信息流里挑出他刷到会停下来的帖子，而不是做一份行业简报。

判断顺序：
1. 先问：这条有没有钩子？只有带钩子的才可能入选。钩子就是会让人「哦这个有意思」的东西：反直觉的结论、自己跑出来的实测数据、观点冲突或当场对线、能被立刻上手的玩法或小工具、行业内幕与一线吐槽、真正改变认知的突破。
2. 再问：钩子是真的吗？夸大的营销、没有数字的吹捧、通稿式发布、纯转发抽奖，钩子是假的，直接砍。
3. 例行进展——又一个基准、又一次合作、又一场直播、又一个「我们很兴奋地宣布」——除非它带来真正新的能力或可验证的硬数字，否则砍掉。这类内容哪怕再重要，也不该占据读者的注意力配额。

同一条信息被多个账号重复时，只留最有钩子的那条。

对每一条候选输出：
- id：原样返回
- keep：true 或 false
- value：0~10，「这个人愿意点开的程度」。9-10 强钩子且可信，今天必看；7-8 有明确钩子；5-6 有点意思但可有可无；0-4 例行内容
- hook：钩子类型，只能取 争议、实测、新玩法、内幕、突破、观点、工具 之一
- why：一句话说清钩子是什么，不超过 30 字，必须具体（点出反直觉在哪、数字是多少、跟谁对线），禁止「内容很有价值」「值得关注」这类空话
- zh：中文译文。忠实原文、口语化、不加原文没有的评论；模型名、基准名、公司名、数字保留原文写法；原文已是中文就给润色版；不超过 120 字

另外给一句 overall：这批候选整体怎么样，不超过 40 字，可以说「今天没什么硬货」。
只输出一个 JSON 对象，不要 Markdown 代码块，不要解释。格式：
{"overall":"...","items":[{"id":"...","keep":true,"value":8,"hook":"实测","why":"...","zh":"..."}]}`

const stripFences = (text) =>
  text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim()

export const parseJsonObject = (text) => {
  const cleaned = stripFences(text)
  try {
    return JSON.parse(cleaned)
  } catch {
    const start = cleaned.indexOf('{')
    const end = cleaned.lastIndexOf('}')
    if (start === -1 || end <= start) return undefined
    try {
      return JSON.parse(cleaned.slice(start, end + 1))
    } catch {
      return undefined
    }
  }
}

const clampValue = (value) => {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.max(0, Math.min(10, number))
}

/** Collect assistant text from one model call. */
export async function collectText(stream) {
  let text = ''
  let failure
  let finishKind = ''
  for await (const chunk of stream) {
    if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
    else if (chunk?.type === 'block-end' && chunk.block?.type === 'text' && typeof chunk.block.text === 'string') {
      if (text.length === 0) text += chunk.block.text
    } else if (chunk?.type === 'finish') {
      finishKind = chunk.reason?.kind ?? ''
      if (finishKind === 'error' || finishKind === 'aborted') failure = chunk.reason.failure
    }
  }
  if (failure) throw new Error(failure.message ?? `model call failed (${failure.code ?? 'unknown'})`)
  return { text, finishKind }
}

/**
 * Resolve the provider/model route for the editor: an explicit override wins,
 * then the profile's default model, then the first registered provider.
 */
export async function resolveEditorRoute({ llm, config, agentDefaultModel, log }) {
  if (config.editorProvider && config.editorModel) {
    return { provider: config.editorProvider, model: config.editorModel }
  }
  try {
    const selection = agentDefaultModel?.currentSelection?.()
    if (selection && typeof selection.provider === 'string' && typeof selection.model === 'string') {
      return { provider: selection.provider, model: selection.model }
    }
  } catch (error) {
    log?.(`editor: default model unavailable (${error?.message ?? String(error)})`)
  }
  let providers = []
  try {
    providers = llm.listProviders?.() ?? []
  } catch {
    providers = []
  }
  for (const provider of providers) {
    try {
      const models = await llm.listModels(provider.id)
      if (models.length > 0) return { provider: provider.id, model: models[0].id }
    } catch {
      /* try the next provider */
    }
  }
  return undefined
}

const buildPrompt = (batch, maxChars) => {
  const candidates = batch.map((item) => ({
    id: item.id,
    author: `@${item.author.handle}`,
    posted: item.createdAt,
    metrics: `${item.metrics.like} likes / ${item.metrics.reply} replies / ${item.metrics.retweet} reposts`,
    text: item.text.length > maxChars ? `${item.text.slice(0, maxChars)}…` : item.text,
  }))
  return JSON.stringify({ candidates }, null, 1)
}

const askModel = async ({ llm, route, batch, maxChars, signal }) => {
  const { text, finishKind } = await collectText(
    llm.stream({
      provider: route.provider,
      model: route.model,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: buildPrompt(batch, maxChars) }] }],
      maxTokens: MAX_TOKENS,
      temperature: 0.15,
      signal,
    }),
  )
  const parsed = text.trim().length > 0 ? parseJsonObject(text) : undefined
  if (!parsed || !Array.isArray(parsed.items)) {
    const reason = text.trim().length === 0 ? `empty reply (finish=${finishKind || 'unknown'})` : `unparsable reply: ${text.slice(0, 80)}`
    return { ok: false, error: reason }
  }
  return { ok: true, parsed }
}

/** One batch, with one shorter-prompt retry when the reply is unusable. */
async function runBatch({ llm, route, batch, signal, log }) {
  let lastError = 'unknown'
  for (const maxChars of [MAX_POST_CHARS, RETRY_POST_CHARS]) {
    try {
      const result = await askModel({ llm, route, batch, maxChars, signal })
      if (result.ok) return result
      lastError = result.error
      log?.(`editor batch failed (${result.error}), retrying shorter`)
    } catch (error) {
      lastError = error?.message ?? String(error)
      log?.(`editor batch threw (${lastError}), retrying shorter`)
    }
  }
  return { ok: false, error: lastError }
}

/**
 * Run the editorial pass over batches of the shortlist.
 * @returns {Promise<{ ok: true, items: object[], overall: string, kept: number, model: string } | { ok: false, error: string }>}
 */
export async function runEditor({ shortlist, config, llm, agentDefaultModel, log, signal }) {
  if (shortlist.length === 0) return { ok: true, items: [], overall: '', kept: 0 }
  if (!llm || typeof llm.stream !== 'function') return { ok: false, error: 'llm service unavailable' }
  const route = await resolveEditorRoute({ llm, config, agentDefaultModel, log })
  if (!route) return { ok: false, error: 'no editor model route' }

  const batchSize = Math.max(1, config.editorBatchSize)
  const batchCount = Math.ceil(shortlist.length / batchSize)
  if (batchCount > 1) log?.(`editor: ${shortlist.length} candidates in ${batchCount} batches`)

  const verdicts = new Map()
  const overalls = []
  const errors = []
  for (let index = 0; index < shortlist.length; index += batchSize) {
    const batch = shortlist.slice(index, index + batchSize)
    const result = await runBatch({ llm, route, batch, signal, log })
    if (!result.ok) {
      errors.push(result.error)
      continue
    }
    if (typeof result.parsed.overall === 'string' && result.parsed.overall.trim().length > 0) {
      overalls.push(result.parsed.overall.trim())
    }
    for (const verdict of result.parsed.items) {
      if (verdict && typeof verdict.id === 'string') verdicts.set(verdict.id, verdict)
    }
  }

  if (verdicts.size === 0) return { ok: false, error: errors.join(' | ') || 'no verdicts' }

  const kept = []
  for (const item of shortlist) {
    const verdict = verdicts.get(item.id)
    if (!verdict || verdict.keep === false) continue
    const value = clampValue(verdict.value)
    if (value < config.editorThreshold) continue
    const zh = typeof verdict.zh === 'string' && verdict.zh.trim().length > 0 ? verdict.zh.trim() : undefined
    const why = typeof verdict.why === 'string' ? verdict.why.trim() : ''
    const hook = HOOKS.has(verdict.hook) ? verdict.hook : undefined
    kept.push({ ...item, value, zh, why, hook })
  }

  kept.sort((left, right) => right.value - left.value || right.score - left.score)
  const chosen = []
  const threads = new Set()
  const perAuthor = new Map()
  for (const item of kept) {
    if (chosen.length >= config.maxItems) break
    if (threads.has(item.thread)) continue
    const handle = item.author.handle.toLowerCase()
    const used = perAuthor.get(handle) ?? 0
    if (used >= config.maxPerAuthor) continue
    perAuthor.set(handle, used + 1)
    threads.add(item.thread)
    chosen.push(item)
  }

  // Batches each report an overall; one sentence reads better than a stitched pair.
  const overall = overalls[0] ?? ''
  log?.(`editor (${route.provider}/${route.model}): ${shortlist.length} in, ${verdicts.size} judged, ${kept.length} kept, ${chosen.length} published`)
  return { ok: true, items: chosen, overall, kept: kept.length, model: `${route.provider}/${route.model}` }
}
