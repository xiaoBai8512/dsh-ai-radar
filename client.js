/**
 * Client half of AI Radar: a native sidebar entry and its main-panel view.
 * It shows today's scored AI posts. Data comes from the Host route, never from X
 * directly (the browser holds no credentials and X sends no CORS headers).
 */

window.__ModuleLoader__.load({
  id: 'dsh-ai-radar',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    const API = '/plugins/ai-radar'
    const PANEL_ID = 'ai-radar'

    const STRINGS = {
      zh: {
        title: 'AI 雷达',
        empty: '今天还没有够格的帖子。',
        refreshing: '抓取中…',
        refresh: '立即抓取',
        updated: '更新于',
        back: '返回对话',
        threshold: '门槛',
        accounts: '个信源',
        loading: '加载中…',
        failed: '读取失败',
        original: '原文',
        translation: '译文',
        whyLabel: '为什么看',
        editorOff: '未启用 LLM 编辑层',
        editorFailed: '编辑层未跑成功，显示规则排序',
        tabDigest: '日报',
        tabQuestions: '问题',
        qPool: '已攒',
        qPoolUnit: '条评论',
        qEmpty: '还没攒够评论。未登录的 X 只开放少量热门回复，所以要先跑几天。',
        qEmptyHint: '去点一下「立即抓取」，会扫描今天吵得最凶的几条帖子的回复区。',
        qAngle: '选题角度',
        qMentions: '条提到',
        qSource: '看原帖',
        noData: '还没有抓取结果，稍等第一轮抓取完成。',
        industry: '行业',
        editIndustry: '设置行业',
        industryHint: '改行业名、关键词和信源账号。保存会清空旧日报并重新抓一轮。',
        nameLabel: '行业名',
        keywordsLabel: '关键词（一行一个，用来判断一条帖子算不算这个话题）',
        brandsLabel: '专有名词（可选，用来判断「新信号」，例如产品名、型号）',
        accountsLabel: '信源账号（每行一个 @handle，可在后面加 ,1 / ,2 / ,3 表示权重档）',
        hnLabel: 'Hacker News 查询（一行一个，留空即关闭；只有科技行业有意义）',
        save: '保存并重新抓取',
        saving: '保存中…',
        cancel: '取消',
        saveFailed: '保存失败',
        needAccounts: '至少需要一个信源账号，否则没有可抓的内容。',
        categories: {
          'model-release': '模型发布',
          research: '论文与基准',
          engineering: '开源与工程',
          debate: '观点争鸣',
          industry: '行业动态',
        },
      },
      en: {
        title: 'AI radar',
        empty: 'Nothing cleared the bar today.',
        refreshing: 'Fetching…',
        refresh: 'Fetch now',
        updated: 'Updated',
        back: 'Back to conversation',
        threshold: 'bar',
        accounts: 'sources',
        loading: 'Loading…',
        failed: 'Read failed',
        original: 'Original',
        translation: 'Translation',
        whyLabel: 'Why read',
        editorOff: 'LLM editor off',
        editorFailed: 'Editor failed; showing heuristic order',
        tabDigest: 'Daily',
        tabQuestions: 'Questions',
        qPool: 'pooled',
        qPoolUnit: 'comments',
        qEmpty: 'Not enough comments yet. Logged-out X only renders a few top replies, so this needs a few days.',
        qEmptyHint: 'Hit "Fetch now" to scan the reply sections of today\'s loudest posts.',
        qAngle: 'Angle',
        qMentions: 'mentions',
        qSource: 'Post',
        noData: 'No fetch yet; the first pass is on its way.',
        industry: 'Industry',
        editIndustry: 'Set industry',
        industryHint: 'Change the name, keywords and sources. Saving clears the current digest and refetches.',
        nameLabel: 'Industry name',
        keywordsLabel: 'Keywords (one per line; decides whether a post is on topic)',
        brandsLabel: 'Named products (optional, for the novelty check, e.g. product or model names)',
        accountsLabel: 'Sources (one @handle per line; append ,1 / ,2 / ,3 for tier)',
        hnLabel: 'Hacker News queries (one per line; empty disables it, only useful for tech)',
        save: 'Save and refetch',
        saving: 'Saving…',
        cancel: 'Cancel',
        saveFailed: 'Save failed',
        needAccounts: 'At least one source account is required, or there is nothing to fetch.',
        categories: {
          'model-release': 'Model release',
          research: 'Paper / benchmark',
          engineering: 'Open source / tooling',
          debate: 'Debate',
          industry: 'Industry',
        },
      },
    }

    const pickLocale = () => {
      const lang = typeof navigator !== 'undefined' ? navigator.language || 'zh' : 'zh'
      return lang.toLowerCase().startsWith('zh') ? 'zh' : 'en'
    }

    const makeTranslate = (ctx) => {
      const locale = pickLocale()
      const dict = STRINGS[locale]
      let bound
      try {
        if (ctx && ctx.locale && typeof ctx.locale.register === 'function') {
          ctx.locale.register('ai-radar', { en: STRINGS.en, zh: STRINGS.zh })
          if (typeof ctx.locale.bind === 'function') bound = ctx.locale.bind('ai-radar')
        }
      } catch {
        bound = undefined
      }
      const t = (key) => {
        if (bound) {
          try {
            const value = bound(key)
            if (typeof value === 'string' && value.length > 0 && value !== key) return value
          } catch {
            /* fall through to the local dictionary */
          }
        }
        const parts = key.split('.')
        let node = dict
        for (const part of parts) {
          if (node === undefined || node === null) return key
          node = node[part]
        }
        return typeof node === 'string' ? node : key
      }
      return t
    }

    const compactNumber = (value) => {
      const n = Number(value) || 0
      if (n >= 1000000) return `${(n / 1000000).toFixed(1).replace(/\.0$/, '')}m`
      if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
      return String(n)
    }

    const timeAgo = (iso) => {
      const at = Date.parse(iso)
      if (!Number.isFinite(at)) return ''
      const minutes = Math.max(0, Math.round((Date.now() - at) / 60000))
      if (minutes < 60) return `${minutes}m`
      const hours = Math.round(minutes / 60)
      if (hours < 24) return `${hours}h`
      return `${Math.round(hours / 24)}d`
    }

    const reasonText = (reason, t) => {
      const zh = pickLocale() === 'zh'
      switch (reason && reason.key) {
        case 'heat':
          return zh ? `互动 ${reason.params?.ratio ?? '?'}× 基线` : `${reason.params?.ratio ?? '?'}× its baseline engagement`
        case 'novelty':
          return zh ? `新信号 ${reason.params?.terms ?? ''}` : `New signal ${reason.params?.terms ?? ''}`
        case 'density':
          return zh ? '带数据或链接' : 'Has data or a link'
        case 'debate':
          return zh ? `回复率 ${reason.params?.percent ?? '?'}%` : `${reason.params?.percent ?? '?'}% replies`
        case 'relevance':
          return zh ? '命中关注方向' : 'On-topic'
        case 'primary':
          return zh ? '一手信源' : 'Primary source'
        default:
          return ''
      }
    }

    const STYLE = `
      .dsh-air-root { box-sizing: border-box; height: 100%; min-height: 0; overflow: auto; padding: max(24px, calc(var(--dsh-frame-top-clearance, 0px) + 12px)) clamp(12px, 4vw, 48px) 24px; }
      .dsh-air-card { display: flex; flex-direction: column; max-width: 760px; margin-inline: auto; border-radius: 14px; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-primary); }
      .dsh-air-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 14px; }
      .dsh-air-head-title { margin: 0; font-size: 16px; font-weight: 600; }
      .dsh-air-actions { display: flex; flex-wrap: wrap; gap: 8px; }
      .dsh-air-btn:focus-visible, .dsh-air-tab:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
      .dsh-air-spacer { flex: 1; }
      .dsh-air-btn { font-family: inherit; font-size: 11px; line-height: 1; padding: 6px 9px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); cursor: pointer; }
      .dsh-air-btn:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
      .dsh-air-btn:disabled { opacity: .55; cursor: default; }
      .dsh-air-hint { padding: 0 14px 10px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .dsh-air-list { overflow-y: auto; padding: 0 6px 8px; display: flex; flex-direction: column; gap: 2px; }
      .dsh-air-item { display: block; text-decoration: none; color: inherit; padding: 9px 8px 10px; border-radius: 10px; border: 1px solid transparent; }
      .dsh-air-item:hover { background: var(--dsw-alias-bg-layer-1); border-color: var(--dsw-alias-border-l1); }
      .dsh-air-item-top { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .dsh-air-author { color: var(--dsw-alias-label-primary); font-weight: 600; font-size: 11.5px; }
      .dsh-air-score { margin-left: auto; font-size: 10.5px; font-weight: 600; color: var(--dsw-alias-brand-primary); }
      .dsh-air-hook { font-size: 10px; padding: 2px 6px; border-radius: 6px; background: color-mix(in srgb, var(--dsw-alias-brand-primary) 14%, transparent); color: var(--dsw-alias-brand-primary); font-weight: 600; }
      .dsh-air-cat { font-size: 10px; padding: 2px 6px; border-radius: 6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-secondary); }
      .dsh-air-text { margin: 5px 0 6px; font-size: 12.5px; line-height: 1.5; color: var(--dsw-alias-label-primary); display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; word-break: break-word; }
      .dsh-air-why { margin: 0 0 6px; font-size: 11.5px; line-height: 1.45; color: var(--dsw-alias-label-secondary); }
      .dsh-air-why b { color: var(--dsw-alias-brand-primary); font-weight: 600; margin-right: 4px; }
      .dsh-air-orig { margin: 0 0 5px; padding: 0; border: 0; background: none; font-family: inherit; font-size: 10px; color: var(--dsw-alias-label-secondary); text-decoration: underline; cursor: pointer; }
      .dsh-air-orig:hover { color: var(--dsw-alias-label-primary); }
      .dsh-air-body { display: block; text-decoration: none; color: inherit; }
      .dsh-air-tabs { display: flex; gap: 2px; padding: 2px; border-radius: 8px; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); }
      .dsh-air-tab { font-family: inherit; font-size: 10.5px; line-height: 1; padding: 4px 7px; border-radius: 6px; border: 0; background: none; color: var(--dsw-alias-label-secondary); cursor: pointer; }
      .dsh-air-tab.on { background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary); box-shadow: 0 1px 3px rgba(0,0,0,.12); }
      .dsh-air-cluster { padding: 9px 10px 10px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); margin: 0 6px 6px; }
      .dsh-air-cluster-head { display: flex; align-items: center; gap: 6px; }
      .dsh-air-qcount { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 16px; padding: 0 5px; border-radius: 8px; background: color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent); color: var(--dsw-alias-brand-primary); font-size: 10px; font-weight: 700; }
      .dsh-air-cluster-theme { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary); line-height: 1.35; }
      .dsh-air-cluster-src { margin-left: auto; font-size: 9.5px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
      .dsh-air-cluster-angle { margin-top: 5px; font-size: 11px; line-height: 1.45; color: var(--dsw-alias-label-secondary); }
      .dsh-air-cluster-angle b { color: var(--dsw-alias-brand-primary); font-weight: 600; margin-right: 4px; }
      .dsh-air-cluster-q { margin-top: 4px; padding-left: 11px; position: relative; font-size: 11.5px; line-height: 1.45; color: var(--dsw-alias-label-primary); }
      .dsh-air-cluster-q:before { content: '·'; position: absolute; left: 2px; color: var(--dsw-alias-brand-primary); font-weight: 700; }
      .dsh-air-cluster-example { margin-top: 5px; font-size: 11px; line-height: 1.45; color: var(--dsw-alias-label-secondary); }
      .dsh-air-cluster-example:before { content: '“'; }
      .dsh-air-cluster-example:after { content: '”'; }
      .dsh-air-overall { padding: 0 14px 8px; font-size: 11.5px; line-height: 1.45; color: var(--dsw-alias-label-secondary); font-style: italic; }
      .dsh-air-reasons { display: flex; flex-wrap: wrap; gap: 4px; }
      .dsh-air-reason { font-size: 10px; padding: 2px 6px; border-radius: 6px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); }
      .dsh-air-metrics { margin-top: 5px; font-size: 10.5px; color: var(--dsw-alias-label-secondary); }
      .dsh-air-empty { padding: 22px 16px 26px; text-align: center; font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 1.6; }
      .dsh-air-form { padding: 0 14px 16px; display: flex; flex-direction: column; gap: 10px; }
      .dsh-air-field { display: flex; flex-direction: column; gap: 4px; }
      .dsh-air-field label { font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .dsh-air-input, .dsh-air-textarea { font-family: inherit; font-size: 12px; line-height: 1.45; padding: 7px 9px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); width: 100%; box-sizing: border-box; }
      .dsh-air-textarea { min-height: 84px; resize: vertical; }
      .dsh-air-form-actions { display: flex; gap: 8px; justify-content: flex-end; }
      .dsh-air-error { font-size: 11.5px; line-height: 1.45; color: var(--dsw-alias-label-secondary); }
    `

    function Item({ item, t }) {
      const [showOriginal, setShowOriginal] = useState(false)
      const translated = typeof item.zh === 'string' && item.zh.trim().length > 0
      const body = showOriginal || !translated ? item.excerpt || item.text || '' : item.zh
      const value = item.value !== undefined && item.value !== null ? item.value : item.score
      const reasons = Array.isArray(item.reasons) ? item.reasons.slice(0, 2) : []
      return h(
        'div',
        { className: 'dsh-air-item' },
        h(
          'div',
          { className: 'dsh-air-item-top' },
          h('span', { className: 'dsh-air-author' }, `@${item.author && item.author.handle ? item.author.handle : '?'}`),
          item.hook
            ? h('span', { className: 'dsh-air-hook' }, item.hook)
            : h(
                'span',
                { className: 'dsh-air-cat' },
                t(`categories.${item.category}`) === `categories.${item.category}` ? item.category || '' : t(`categories.${item.category}`),
              ),
          h('span', null, timeAgo(item.createdAt)),
          h('span', { className: 'dsh-air-score' }, `${value}`),
        ),
        h(
          'a',
          { className: 'dsh-air-body', href: item.url, target: '_blank', rel: 'noreferrer noopener', title: item.text },
          h('div', { className: 'dsh-air-text' }, body),
        ),
        item.why
          ? h('div', { className: 'dsh-air-why' }, h('b', null, t('whyLabel')), item.why)
          : reasons.length > 0
            ? h(
                'div',
                { className: 'dsh-air-reasons' },
                reasons.map((reason, index) => h('span', { className: 'dsh-air-reason', key: index }, reasonText(reason, t))),
              )
            : null,
        translated
          ? h(
              'button',
              { className: 'dsh-air-orig', type: 'button', onClick: () => setShowOriginal((value) => !value) },
              showOriginal ? t('translation') : t('original'),
            )
          : null,
        h(
          'div',
          { className: 'dsh-air-metrics' },
          `♥ ${compactNumber(item.metrics && item.metrics.like)} · ↻ ${compactNumber(item.metrics && item.metrics.retweet)} · 💬 ${compactNumber(item.metrics && item.metrics.reply)}`,
        ),
      )
    }

    function IndustryForm({ t, industry, onCancel, onSaved }) {
      const [label, setLabel] = useState(industry.label || '')
      const [keywords, setKeywords] = useState((industry.keywords || []).join('\n'))
      const [brands, setBrands] = useState((industry.brands || []).join('\n'))
      const [accounts, setAccounts] = useState(
        (industry.accounts || []).map((account) => `${account.handle}${account.tier && account.tier !== 2 ? `,${account.tier}` : ''}`).join('\n'),
      )
      const [hn, setHn] = useState(((industry.hn && industry.hn.queries) || []).join('\n'))
      const [saving, setSaving] = useState(false)
      const [error, setError] = useState(null)

      const save = async () => {
        if (accounts.trim().length === 0) {
          setError(t('needAccounts'))
          return
        }
        setSaving(true)
        setError(null)
        try {
          const response = await fetch(`${API}/industry`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({
              id: industry.id || 'custom',
              label,
              keywords,
              brands,
              accounts,
              hn: { enabled: hn.trim().length > 0, queries: hn },
            }),
          })
          if (!response.ok) {
            const payload = await response.json().catch(() => ({}))
            throw new Error(payload.error || `HTTP ${response.status}`)
          }
          onSaved()
        } catch (err) {
          setError(`${t('saveFailed')}: ${err && err.message ? err.message : String(err)}`)
        } finally {
          setSaving(false)
        }
      }

      const field = (key, value, setValue, textarea) =>
        h(
          'div',
          { className: 'dsh-air-field', key },
          h('label', null, t(key)),
          textarea
            ? h('textarea', { className: 'dsh-air-textarea', value, spellCheck: false, onChange: (event) => setValue(event.target.value) })
            : h('input', { className: 'dsh-air-input', value, onChange: (event) => setValue(event.target.value) }),
        )

      return h(
        'div',
        { className: 'dsh-air-form' },
        h('div', { className: 'dsh-air-hint', style: { padding: '0 0 2px' } }, t('industryHint')),
        field('nameLabel', label, setLabel, false),
        field('keywordsLabel', keywords, setKeywords, true),
        field('brandsLabel', brands, setBrands, true),
        field('accountsLabel', accounts, setAccounts, true),
        field('hnLabel', hn, setHn, true),
        error ? h('div', { className: 'dsh-air-error' }, error) : null,
        h(
          'div',
          { className: 'dsh-air-form-actions' },
          h('button', { className: 'dsh-air-btn', type: 'button', onClick: onCancel, disabled: saving }, t('cancel')),
          h('button', { className: 'dsh-air-btn', type: 'button', onClick: save, disabled: saving }, saving ? t('saving') : t('save')),
        ),
      )
    }

    function AiRadar({ t, onBack }) {
      const [view, setView] = useState(() => {
        try {
          return window.localStorage.getItem('dsh.aiRadar.view') === 'questions' ? 'questions' : 'digest'
        } catch {
          return 'digest'
        }
      })
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const [editing, setEditing] = useState(false)
      const alive = useRef(true)

      const load = useCallback(async () => {
        try {
          const response = await fetch(`${API}/digest`, { headers: { accept: 'application/json' } })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const next = await response.json()
          if (alive.current) {
            setData(next)
            setError(null)
          }
        } catch (err) {
          if (alive.current) setError(err && err.message ? err.message : String(err))
        }
      }, [])

      useEffect(() => {
        alive.current = true
        load()
        const timer = setInterval(load, 5 * 60 * 1000)
        return () => {
          alive.current = false
          clearInterval(timer)
        }
      }, [load])

      useEffect(() => {
        try {
          window.localStorage.setItem('dsh.aiRadar.view', view)
        } catch {
          /* storage may be unavailable */
        }
      }, [view])

      const refresh = useCallback(async () => {
        setBusy(true)
        try {
          const response = await fetch(`${API}/refresh`, { method: 'POST', headers: { accept: 'application/json' } })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          await load()
        } catch (err) {
          if (alive.current) setError(err && err.message ? err.message : String(err))
        } finally {
          if (alive.current) setBusy(false)
        }
      }, [load])

      const digest = data && Array.isArray(data.digest) ? data.digest : []
      const count = digest.length
      const updated = data && data.updatedAt ? new Date(data.updatedAt) : null
      const questions = (data && data.questions) || {}
      const themes = Array.isArray(questions.themes) ? questions.themes : []
      const updatedLabel = updated && Number.isFinite(updated.getTime())
        ? `${t('updated')} ${updated.getHours().toString().padStart(2, '0')}:${updated.getMinutes().toString().padStart(2, '0')}`
        : t('noData')

      return h(
        'div',
        { className: 'dsh-air-root' },
        h('style', null, STYLE),
        h(
          'section',
          { className: 'dsh-air-card', 'aria-labelledby': 'dsh-air-title' },
          h(
            'div',
            { className: 'dsh-air-head' },
            h('h1', { className: 'dsh-air-head-title', id: 'dsh-air-title' }, t('title')),
            h(
              'div',
              { className: 'dsh-air-tabs', role: 'tablist' },
              h(
                'button',
                {
                  className: view === 'digest' ? 'dsh-air-tab on' : 'dsh-air-tab',
                  type: 'button',
                  role: 'tab',
                  'aria-selected': view === 'digest',
                  onClick: () => setView('digest'),
                },
                `${t('tabDigest')} ${count}`,
              ),
              h(
                'button',
                {
                  className: view === 'questions' ? 'dsh-air-tab on' : 'dsh-air-tab',
                  type: 'button',
                  role: 'tab',
                  'aria-selected': view === 'questions',
                  onClick: () => setView('questions'),
                },
                t('tabQuestions'),
              ),
            ),
            h('span', { className: 'dsh-air-spacer' }),
            h(
              'div',
              { className: 'dsh-air-actions' },
              h(
                'button',
                {
                  className: 'dsh-air-btn',
                  type: 'button',
                  onClick: () => setEditing((value) => !value),
                  'aria-pressed': editing,
                  title: t('industryHint'),
                },
                t('editIndustry'),
              ),
              h(
                'button',
                { className: 'dsh-air-btn', type: 'button', onClick: refresh, disabled: busy || (data && data.running) },
                busy || (data && data.running) ? t('refreshing') : t('refresh'),
              ),
              h('button', { className: 'dsh-air-btn', type: 'button', onClick: onBack }, t('back')),
            ),
          ),
          h(
            'div',
            { className: 'dsh-air-hint' },
            data
              ? view === 'digest'
                ? `${data.industry ? `${data.industry.label} · ` : ''}${(data.accounts || []).length} ${t('accounts')} · ${t('threshold')} ${data.threshold ?? '?'} · ${count}/${data.maxItems ?? '?'}`
                : `${t('qPool')} ${questions.poolSize ?? 0} ${t('qPoolUnit')}${questions.at ? ` · ${updatedLabel}` : ''}`
              : t('loading'),
          ),
          data && view === 'digest' && data.overall ? h('div', { className: 'dsh-air-overall' }, data.overall) : null,
          data && view === 'questions' && questions.overall
            ? h('div', { className: 'dsh-air-overall' }, questions.overall)
            : null,
          error
            ? h('div', { className: 'dsh-air-empty' }, `${t('failed')}: ${error}`)
            : editing && data && data.industry
              ? h(IndustryForm, {
                  t,
                  industry: data.industry,
                  onCancel: () => setEditing(false),
                  onSaved: async () => {
                    setEditing(false)
                    await load()
                  },
                })
            : view === 'questions'
              ? themes.length === 0
                ? h(
                    'div',
                    { className: 'dsh-air-empty' },
                    `${t('qEmpty')}${questions.error ? ` (${questions.error})` : ''}`,
                    h('br', null),
                    h('br', null),
                    t('qEmptyHint'),
                  )
                : h(
                    'div',
                    { className: 'dsh-air-list' },
                    themes.map((theme, index) =>
                      h(
                        'div',
                        { className: 'dsh-air-cluster', key: index },
                        h(
                          'div',
                          { className: 'dsh-air-cluster-head' },
                          h('span', { className: 'dsh-air-qcount' }, String(theme.count ?? 0)),
                          h('span', { className: 'dsh-air-cluster-theme' }, theme.theme || ''),
                          theme.sources && (theme.sources.x || theme.sources.hn)
                            ? h(
                                'span',
                                { className: 'dsh-air-cluster-src' },
                                [theme.sources.x ? `X ${theme.sources.x}` : '', theme.sources.hn ? `HN ${theme.sources.hn}` : '']
                                  .filter(Boolean)
                                  .join(' · '),
                              )
                            : null,
                        ),
                        theme.angle
                          ? h('div', { className: 'dsh-air-cluster-angle' }, h('b', null, t('qAngle')), theme.angle)
                          : null,
                        Array.isArray(theme.questions) && theme.questions.length > 0
                          ? theme.questions
                              .slice(0, 3)
                              .map((question, key) => h('div', { className: 'dsh-air-cluster-q', key }, question))
                          : (theme.examples || [])
                              .slice(0, 2)
                              .map((example, key) => h('div', { className: 'dsh-air-cluster-example', key }, example)),
                      ),
                    ),
                  )
              : count === 0
                ? h('div', { className: 'dsh-air-empty' }, data ? t('empty') : t('loading'))
                : h(
                    'div',
                    { className: 'dsh-air-list' },
                    digest.map((item) => h(Item, { key: item.id, item, t })),
                  ),
        ),
      )
    }

    function RadarIcon({ size = 16 }) {
      return h(
        'svg',
        { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true },
        h('circle', { cx: 12, cy: 12, r: 9 }),
        h('circle', { cx: 12, cy: 12, r: 5 }),
        h('path', { d: 'm12 12 6.4-6.4', strokeLinecap: 'round' }),
        h('circle', { cx: 12, cy: 12, r: 1.3, fill: 'currentColor', stroke: 'none' }),
      )
    }

    return {
      inject: ['slots', 'layout', 'locale'],
      apply(ctx) {
        const t = makeTranslate(ctx)
        const Panel = () => h(AiRadar, { t, onBack: () => ctx.layout.selectPanel(null) })
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID }, Panel),
        )
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 40, label: () => t('title') }, RadarIcon),
        )
      },
    }
  },
})
