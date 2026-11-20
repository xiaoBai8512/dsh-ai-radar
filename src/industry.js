/**
 * Industry packs: the part of the radar that is about *a vertical*, not about
 * the product. A pack carries the sources, the vocabulary, and the two prompts'
 * subject; everything else (fetching, gates, scoring weights, UI) is shared.
 *
 * The plugin ships one pack that has been actually run (AI). Any other vertical
 * is data the user supplies or edits, not something we pretend to have verified.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_ACCOUNTS } from './watchlist.js'
import { resolveDataDir } from './state.js'

const PACK_VERSION = 1

const AI_KEYWORDS = [
  'ai', 'a.i.', 'llm', 'llms', 'agent', 'agents', 'agentic', 'model', 'models',
  'inference', 'training', 'pretrain', 'transformer', 'prompt', 'rag', 'fine-tuning',
  'finetune', 'benchmark', 'eval', 'token', 'context window', 'open source', 'dataset',
  'embedding', 'gpu', 'cuda', 'rlhf', 'reasoning', 'multimodal', 'diffusion',
  'attention', 'latent', 'scaling', 'distill', 'quantization', 'moe', 'mixture of experts',
  'robotics', 'code', 'arxiv', 'paper',
  '智能体', '大模型', '推理', '训练', '微调', '开源', '基准', '多模态', '架构',
]

const AI_BRANDS = [
  'gpt', 'claude', 'gemini', 'llama', 'qwen', 'deepseek', 'mistral', 'grok', 'phi',
  'kimi', 'glm', 'ernie', 'minimax', 'command', 'nova', 'o1', 'o3', 'o4',
]

const AI_HN_QUERIES = ['claude code', 'cursor', 'llm api', 'ollama', 'llama.cpp', 'vllm']

const AI_QUESTION_SEEDS = [
  '怎么装、怎么配、怎么迁移',
  '报错与不生效',
  '速度与性能',
  '配额与价格',
  '上下文或其他硬限制',
  '几个工具怎么选',
]

export const DEFAULT_INDUSTRY = Object.freeze({
  id: 'ai',
  label: 'AI 行业',
  keywords: AI_KEYWORDS,
  brands: AI_BRANDS,
  accounts: DEFAULT_ACCOUNTS.map((entry) => ({ handle: entry.handle, tier: entry.tier ?? 2, label: entry.label ?? entry.handle })),
  hn: { enabled: true, queries: AI_HN_QUERIES },
  questionSeeds: AI_QUESTION_SEEDS,
})

const clampTier = (value) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return 2
  return Math.min(3, Math.max(1, Math.round(n)))
}

const cleanString = (value) => (typeof value === 'string' ? value.trim() : '')

/** Accounts split on lines only: the comma belongs to "handle,tier". */
const splitAccounts = (value) => {
  if (Array.isArray(value)) return value
  if (typeof value !== 'string') return []
  return value
    .split(/[\n;；]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

const splitList = (value) => {
  if (Array.isArray(value)) return value.map(cleanString).filter(Boolean)
  if (typeof value !== 'string') return []
  return value
    .split(/[\n,，、;；]+/)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

const normalizeAccount = (entry) => {
  if (typeof entry === 'string') {
    const raw = entry.trim().replace(/^@/, '')
    const [handle, tier] = raw.split(/[\s,，:：]+/)
    if (!handle) return undefined
    return { handle, tier: clampTier(tier ?? 2), label: handle }
  }
  if (!entry || typeof entry !== 'object') return undefined
  const handle = cleanString(entry.handle).replace(/^@/, '')
  if (!handle) return undefined
  return {
    handle,
    tier: clampTier(entry.tier ?? 2),
    label: cleanString(entry.label) || handle,
  }
}

const dedupeAccounts = (accounts) => {
  const seen = new Set()
  const out = []
  for (const account of accounts) {
    const key = account.handle.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(account)
  }
  return out
}

/**
 * Accepts anything the UI, a config file, or a stored pack can produce and
 * returns the shape the rest of the plugin reads.
 */
export function normalizeIndustry(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const label = cleanString(source.label) || DEFAULT_INDUSTRY.label
  const accounts = dedupeAccounts(splitAccounts(source.accounts).map(normalizeAccount).filter(Boolean))
  const keywords = splitList(source.keywords)
  const brands = splitList(source.brands)
  const seeds = splitList(source.questionSeeds)
  const hnSource = source.hn && typeof source.hn === 'object' ? source.hn : { enabled: source.hn !== false }
  // Only the shipped pack falls back to the shipped AI sources. A user pack
  // that names no accounts is empty on purpose — silently scanning the AI list
  // under a "美妆" label would be a lie the UI could not show.
  const shipped = source.id === undefined || source.id === DEFAULT_INDUSTRY.id
  return {
    id: cleanString(source.id) || 'custom',
    label,
    keywords: keywords.length > 0 ? keywords : shipped ? DEFAULT_INDUSTRY.keywords : [],
    brands: brands.length > 0 ? brands : [],
    accounts: accounts.length > 0 ? accounts : shipped ? DEFAULT_INDUSTRY.accounts.map((entry) => ({ ...entry })) : [],
    hn: {
      enabled: hnSource.enabled !== false && splitList(hnSource.queries).length > 0,
      queries: splitList(hnSource.queries),
    },
    questionSeeds: seeds.length > 0 ? seeds : [],
  }
}

/** True when the stored pack is still the shipped one. */
export const isDefaultIndustry = (industry) =>
  industry.accounts.length === DEFAULT_INDUSTRY.accounts.length
  && industry.accounts.every((account, index) => account.handle === DEFAULT_INDUSTRY.accounts[index].handle)

const escapeRegex = (term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const LATIN = /^[a-z0-9][a-z0-9 .&+/#-]*$/i

/**
 * Word-ish matching without \\b: \\b breaks on terms that end in punctuation
 * ("a.i.") and does nothing useful for CJK, where every character is a word
 * boundary. A latin term matches at a letter/digit edge, optionally pluralised;
 * a CJK term is matched as written.
 */
const latinOrCjk = (terms) => {
  const latin = []
  const cjk = []
  for (const term of terms) {
    if (LATIN.test(term)) latin.push(escapeRegex(term))
    else cjk.push(escapeRegex(term))
  }
  const parts = []
  if (latin.length > 0) parts.push(`(?<![a-z0-9])(?:${latin.join('|')})(?:s|es)?(?![a-z0-9])`)
  if (cjk.length > 0) parts.push(`(?:${cjk.join('|')})`)
  return { parts, hasLatin: latin.length > 0 }
}

/**
 * Build the two regexes the scorer needs. Compiled once per refresh, not per
 * post: 33 accounts x 16 posts is not much, but this also keeps the pack the
 * single source of truth for what "on topic" means.
 *
 * @returns {{ relevance: RegExp | null, brand: RegExp | null }}
 */
export function createMatchers(industry) {
  const pack = industry && typeof industry === 'object' ? industry : DEFAULT_INDUSTRY
  const keywords = latinOrCjk(Array.isArray(pack.keywords) ? pack.keywords : [])
  const brands = latinOrCjk(Array.isArray(pack.brands) ? pack.brands : [])
  const brandParts = []
  if (brands.parts.length > 0) {
    // A latin brand only counts with a version/number attached (gpt-5, qwen3),
    // which is what makes the term checkable rather than a mention.
    const latin = (Array.isArray(pack.brands) ? pack.brands : []).filter((term) => LATIN.test(term)).map(escapeRegex)
    const cjk = (Array.isArray(pack.brands) ? pack.brands : []).filter((term) => !LATIN.test(term)).map(escapeRegex)
    if (latin.length > 0) brandParts.push(`(?<![a-z0-9])(?:${latin.join('|')})[-.\\s]?[0-9][\\w.]{0,12}`)
    if (cjk.length > 0) brandParts.push(`(?:${cjk.join('|')})`)
  }
  return {
    relevance: keywords.parts.length > 0 ? new RegExp(keywords.parts.join('|'), 'gi') : null,
    brand: brandParts.length > 0 ? new RegExp(brandParts.join('|'), 'gi') : null,
  }
}

export function resolveIndustryPath(config) {
  return join(resolveDataDir(config), 'industry.json')
}

/** Load the pack the user saved, falling back to the shipped AI pack. */
export function loadIndustry(config) {
  const path = resolveIndustryPath(config)
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || parsed.version !== PACK_VERSION) return { ...DEFAULT_INDUSTRY }
    return normalizeIndustry(parsed.pack)
  } catch {
    return { ...DEFAULT_INDUSTRY }
  }
}

export function saveIndustry(config, industry) {
  const path = resolveIndustryPath(config)
  mkdirSync(resolveDataDir(config), { recursive: true })
  const temp = `${path}.tmp`
  writeFileSync(temp, `${JSON.stringify({ version: PACK_VERSION, pack: industry }, null, 0)}\n`, 'utf8')
  renameSync(temp, path)
  return path
}
