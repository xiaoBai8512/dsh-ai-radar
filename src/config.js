/** Normalized runtime configuration for the radar host half. */

import { createMatchers, loadIndustry, normalizeIndustry } from './industry.js'

const clampInt = (value, min, max, fallback) => {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

const normalizeAccount = (entry, index) => {
  if (typeof entry === 'string') {
    return { handle: entry.replace(/^@/, '').trim(), tier: 2, label: entry.replace(/^@/, '').trim() }
  }
  if (!entry || typeof entry !== 'object' || typeof entry.handle !== 'string') return undefined
  const handle = entry.handle.replace(/^@/, '').trim()
  if (handle.length === 0) return undefined
  return {
    handle,
    tier: clampInt(entry.tier ?? 2, 1, 3, 2),
    label: typeof entry.label === 'string' && entry.label.length > 0 ? entry.label : handle,
    order: Number.isFinite(Number(entry.order)) ? Number(entry.order) : index,
  }
}

/**
 * Merge the industry pack with the legacy flat config.
 *
 * The pack is the default; a profile that still spells out `accounts`,
 * `hnQueries` or `keywords` wins for those fields, so an existing install keeps
 * behaving exactly as it did before packs existed.
 */
function mergeIndustry(source, stored) {
  const base = stored && typeof stored === 'object' ? stored : { ...DEFAULT_INDUSTRY }
  const overrides = {}
  if (Array.isArray(source.accounts) && source.accounts.length > 0) overrides.accounts = source.accounts
  if (Array.isArray(source.hnQueries) && source.hnQueries.length > 0) {
    overrides.hn = { enabled: source.hn !== false, queries: source.hnQueries }
  }
  if (Array.isArray(source.keywords) && source.keywords.length > 0) overrides.keywords = source.keywords
  if (Array.isArray(source.brands) && source.brands.length > 0) overrides.brands = source.brands
  if (typeof source.industryLabel === 'string' && source.industryLabel.trim().length > 0) {
    overrides.label = source.industryLabel.trim()
  }
  return normalizeIndustry({ ...base, ...overrides })
}

export function normalizeConfig(raw, options = {}) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const stored = options.industry !== undefined ? options.industry : loadIndustry(source)
  const industry = mergeIndustry(source, stored)
  const accounts = industry.accounts.map((entry, index) => normalizeAccount(entry, index)).filter(Boolean)
  const hnQueries = industry.hn.queries
  return {
    enabled: source.enabled !== false,
    industry,
    matchers: createMatchers(industry),
    industryLabel: industry.label,
    accounts,
    refreshHour: clampInt(source.refreshHour ?? 9, 0, 23, 9),
    maxItems: clampInt(source.maxItems ?? 6, 1, 12, 6),
    maxPerAuthor: clampInt(source.maxPerAuthor ?? 2, 1, 6, 2),
    editor: source.editor !== false,
    editorProvider: typeof source.editorProvider === 'string' ? source.editorProvider : undefined,
    editorModel: typeof source.editorModel === 'string' ? source.editorModel : undefined,
    editorCandidates: clampInt(source.editorCandidates ?? 24, 1, 40, 24),
    editorPerAuthor: clampInt(source.editorPerAuthor ?? 3, 1, 6, 3),
    editorBatchSize: clampInt(source.editorBatchSize ?? 12, 4, 24, 12),
    questions: source.questions !== false,
    questionPosts: clampInt(source.questionPosts ?? 12, 1, 30, 12),
    questionMinReplies: clampInt(source.questionMinReplies ?? 40, 0, 100000, 40),
    questionPoolDays: clampInt(source.questionPoolDays ?? 7, 1, 30, 7),
    questionClusters: clampInt(source.questionClusters ?? 5, 1, 10, 5),
    questionRefetchHours: clampInt(source.questionRefetchHours ?? 72, 1, 720, 72),
    hn: source.hn !== false && industry.hn.enabled && hnQueries.length > 0,
    hnQueries,
    hnDays: clampInt(source.hnDays ?? 7, 1, 30, 7),
    hnPerQuery: clampInt(source.hnPerQuery ?? 60, 10, 100, 60),
    editorThreshold: clampInt(source.editorThreshold ?? 6, 0, 10, 6),
    windowHours: clampInt(source.windowHours ?? 36, 6, 96, 36),
    minScore: clampInt(source.minScore ?? 30, 0, 100, 30),
    requestGapMs: clampInt(source.requestGapMs ?? 4000, 1200, 30000, 4000),
    cacheMinutes: clampInt(source.cacheMinutes ?? 50, 5, 720, 50),
    dataDir: typeof source.dataDir === 'string' && source.dataDir.trim().length > 0 ? source.dataDir.trim() : undefined,
  }
}

/** Re-point a live config at an edited pack without rebuilding everything. */
export function applyIndustry(config, industry) {
  const pack = normalizeIndustry(industry)
  config.industry = pack
  config.industryLabel = pack.label
  config.matchers = createMatchers(pack)
  config.accounts = pack.accounts
  config.hnQueries = pack.hn.queries
  config.hn = pack.hn.enabled && pack.hn.queries.length > 0
  return config
}
