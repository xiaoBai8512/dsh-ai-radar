# AI 雷达 · AI Radar

在 DeepSeek Harness 左侧栏打开 **AI 雷达**：看筛过的日报，也看 X 和 Hacker News 评论里反复出现的实操问题。适合想跟进某一行动态、找值得验证的选题，又不想每天刷时间线的人。

默认跑 AI 行业（33 个信源 + 6 条 HN 查询）。**v0.2 起行业可以自己改**：面板里点「设置行业」，改名称、关键词、信源账号即可，不限于 AI。

## 安装与第一次使用

本地测试包：先把 `dsh-ai-radar-0.2.0.tgz` 下载到当前终端目录，任选与你的 Harness 对应的一条：

```sh
# Harness Desktop 的 DSH 终端
dsh plugin --profile desktop add "$PWD/dsh-ai-radar-0.2.0.tgz"
# 命令行启动的 dsh web
dsh plugin --profile web add "$PWD/dsh-ai-radar-0.2.0.tgz"
```

桌面端完全退出后重开；Web 版重启原来的 `dsh web`。打开左侧栏 **AI 雷达**，首次启动会自动抓取，也可以点 **立即抓取**。默认名单较长，完成可能需要几分钟；抓取进度可在面板查看。

- 运行机器需要能访问 X 的公开页面和 Hacker News 的 Algolia 接口；不需要提供 X 账号或 X API key。X 匿名页面的内容、可用性及更新速度会受网络和上游页面变化影响。
- 中文摘要、编辑筛选和问题聚类默认使用当前 Harness 配置的模型，可能产生模型用量。候选帖和部分公开评论的文本会发给该模型服务。未配置可用模型时，日报回退到规则排序，问题聚类可能暂不显示。可在插件配置中关闭 `editor` 和 `questions`。
- 插件会保存日报、信源缓存和去重记录到本机，不随安装包分发。建议先按已验证环境试装，不把其他 Harness 版本或操作系统视为已兼容。

## 换行业（v0.2）

面板右上角 **设置行业** 打开表单，五项：

| 字段 | 作用 |
|---|---|
| 行业名 | 显示在面板标题行；也是编辑层与问题聚类的口径 |
| 关键词 | 一行一个。一条帖子命中几个词，决定它的相关性分（15 分权重里的一项）；中文词直接按字面匹配，拉丁词自动含复数 |
| 专有名词 | 可选。用来判断「新信号」：拉丁名要带型号或数字才算（`gpt-5`、`qwen3`），中文名本身即可 |
| 信源账号 | 一行一个 `@handle`，可写 `handle,1` / `,2` / `,3` 表示权重档（1 最高） |
| Hacker News 查询 | 一行一个；留空即关闭。只有科技类行业有意义 |

保存后会：写入 `<数据目录>/industry.json`、清空旧日报与去重账本/词库/问题池、按新行业立刻重抓一轮。旧行业的数据不会混进新行业的卡片。

三条限制，先说明白：

- 跨行业都成立的源只有 X 账号名单，插件不会替你想名单；HN 只服务科技类。非科技行业的效果，取决于你填的账号和关键词。
- 换行业等于换了一套判断标准，但**只有 AI 行业做过完整验收**；别的行业目前是「能用，未验收」。
- 编辑层与问题聚类跑在当前 Harness 配置的模型上，换行业后它的标准跟着行业名和关键词走，不会自己长见识。

## 标准（怎么算「有意思」）

四层漏斗，前一层不过就直接丢弃：

**L0 池子**：三类信源，权重不同。
- tier 1 一手官方：OpenAI / Anthropic / Google DeepMind / Google AI / Mistral / Qwen / DeepSeek
- tier 2 研究者与评论者：karpathy、simonw、fchollet、Jim Fan、emollick、AK、Teortaxes、scaling01、near、Lucas Beyer、Vikhyat
- tier 3 工程与工具链：swyx、Mckay Wrigley、Peter Steinberger、Harrison Chase、LangChain、Ollama、Hugging Face、The Turing Post、Rowan Cheung

**L1 硬门槛**（二元淘汰，不打分）
- 时间窗：默认 36 小时内（首次安装时回填 7 天，避免卡片空着）
- 去重：`id` 记账，见过的永不再上榜
- 排除转推、敏感内容、非本账号原创、语言不在 en/zh/ja
- 长度下限（官方号 24 字符、其他 55 字符），排除纯表情
- 排除招聘、抽奖、返利、促销码、webinar、"link in bio" 这类推广

**L2 五维信号（0–1，加权成 0–100 分）**
| 信号 | 权重 | 怎么算 |
|---|---|---|
| 热度异常度 | 25 | 互动量 ÷ 该账号自己近期帖子互动中位数，取对数；比的是「这条比他自己平时的表现热多少」，不是绝对数字 |
| 新颖性 | 25 | 提取模型/版本/基准这类可核验的词，比对近 14 天见过的词库；带 introduc/releas/unveil/open-source 这类动词加分 |
| 信息密度 | 20 | 有链接、有数字/百分比/延迟/准确率、有代码/安装命令、长度在 90–900 字符 |
| 讨论价值 | 15 | 回复数 ÷ 点赞数、引用数 ÷ 点赞数；越有争议越靠前 |
| 相关性 | 15 | 命中 AI/LLM/agent/推理/微调/开源/基准 等词汇表，tier 越高的信源加分 |

**L3 LLM 编辑层**（`src/editor.js`）
规则分只做粗排，**不决定入选**。全部过硬门槛的候选（每人最多 3 条）按规则分取前 24 条，分批（默认每批 12 条）交给 LLM 做二审。编辑给的目标是「刷到会停下来」，不是「做行业简报」。核心判断是**钩子**：
- 有钩子才可能入选：反直觉结论、自己跑出来的实测数据、观点冲突/对线、立刻能上手的玩法或小工具、内幕与一线吐槽、改变认知的突破
- 钩子必须为真：营销、无数字的吹捧、通稿式发布直接砍
- 例行进展（又一个基准、又一次合作、又一场直播）除非带来新能力或可验证硬数字，否则砍

每条的输出：
- `keep` / `value`（0–10 的「愿意点开程度」）
- `hook`：争议 / 实测 / 新玩法 / 内幕 / 突破 / 观点 / 工具，显示成卡片上的小标签
- `why`：说清钩子是什么（≤30 字），禁止「值得关注」这类空话
- `zh`：中文译文（≤120 字，专名与数字保留原文；原文是中文给润色版）
- `overall`：一句整体判断

LLM 用 profile 默模型（`agentDefaultModel.currentSelection()`），可 `editorProvider`/`editorModel` 覆盖。**分批是为输出预算服务**：一次问 24 条时模型会把预算耗在推理上、正文为空，所以每批 12 条、失败自动用更短的提示重试一次。**LLM 不可用时回落规则排序**（不翻译，但照出榜单）。

**L4 最终选择**
- 默认门槛 30 分进候选池，LLM 裁决后每天上限 6 条，同一作者最多 2 条
- 同一对话只留一条
- 分类：模型发布 / 论文与基准 / 开源与工程 / 观点争鸣 / 行业动态
- **宁少而精**：全砍掉也允许，卡片会显示「今天还没有够格的帖子」

## 评论区问题雷达（选题用）

第二个标签页回答「大家到底在问什么、踩哪个坑」，用来做「白科闪点」的选题。

**为什么是 X + Hacker News**：未登录的 X 一条帖子只渲染 2 条左右热门回复（实测：1236 条回复的帖子也只给 3 个块），做不出「高频」统计；HN 评论可全文读取，一天几百条，且写的人正是踩坑的人。两者合在一起：X 给「热帖下最扎眼的反应」，HN 给「量」。

- X 侧：取今天最吵的 N 条帖子（按回复数 + 点赞数排序），逐条抓回复区，每 72 小时最多抓一次
- HN 侧：用公开 Algolia API 按关键词（`claude code`、`cursor`、`llm api`、`ollama`、`llama.cpp`、`vllm`）抓最近 7 天的评论，每天几十到几百条
- 过滤：只留疑问、报错、配置/迁移/配额/选型这类「实操与踩坑」发言
- 攒池：滚动的 7 天池子，最多 1500 条
- 聚类：抽最新 30 条（X 优先）交给 LLM，聚成 3–5 类，每类给
  - 这一类在问什么（≤18 字）
  - **可直接开做的选题角度**（≤40 字）
  - 1–2 条中文示例
  - 来源构成（X 几条 / HN 几条）
- 每条主题还能点开原帖（`links` 已存，面板暂未渲染）
- 计数是「这 30 条采样里提到几类」的规模，不是全网统计；卡片上标了来源构成（X / HN）

**已知的坑（都是踩过的）**：让推理模型一次改写几十条评论，它会把输出预算烧在推理上、正文返回空（`finish=max-tokens` 且无文本）。所以提取阶段改成启发式选样，模型只做一次小回复；编辑层同理，分批 12 条 + 失败半批重试。

配置：`questions`（总开关）、`hn`、`hnQueries`、`hnDays`、`hnPerQuery`、`questionPosts`（扫多少条 X 帖子）、`questionPoolDays`、`questionClusters`。

## 数据从哪来（没有 X API key）

两个还活着的公开端点，一个主力一个兜底：

1. **帖子页本身（主力）**：`https://x.com/<账号>`。x.com 把最近的帖子连同完整计数（赞/转/回/引）服务端渲染进 HTML，一次 GET 就够，不需要登录、token 或第三方代理。正文里的链接是 t.co 短链，真实地址在旁边的 entity 对象里，解析时按就近原则还原，媒体链接直接丢掉。限制：一页只渲染最近 5 条左右。
2. **合成时间线（兜底）**：`syndication.twitter.com/srv/timeline-profile/screen-name/<账号>` — 结构化 JSON，最干净，但**相当一部分账号返回的是「历史最热」而不是「最新」**，所以只在第 1 步拿不到页面时用。
3. 单帖页 `/status/<id>` 用同一套解析，供评论区问题雷达取「帖子 + 它渲染出的几条回复（含回复数）」。

**已废：`r.jina.ai` 读者代理。** 原先用它取「页面上最近的帖子 id」，以及把评论区转成 markdown。它对匿名请求现在直接返回 `401 AuthenticationRequiredError`（按 IP 信誉判定），2026-11-18 23:59 那轮 30/35 个账号的 `http 401` 全部来自这里。现已整体移除，抓取不再依赖任何第三方。

**「没更新」不是失败。** 源能正常返回、但最近一条在时间窗之外，记进 `stale`（例如 `stale (newest 12d old)`）；只有页面和时间线都拿不到才进 `failed`。分开之后，卡片上的错误数才等于真故障数。

网络：如部署环境已配置 HTTP(S) 代理，插件读取 `http_proxy`/`https_proxy` 或对应大写变量；未配置时直接访问。

## 配置

插件的 `config`（在 profile 的 `cordis.patch.yml` 里可改）：

```yaml
- id: ai-radar
  name: 'dsh-ai-radar'
  config:
    refreshHour: 9        # 每天几点抓（本地时间）
    maxItems: 6           # 每天最多几条
    maxPerAuthor: 2       # 同一作者最多几条
    editor: true          # LLM 编辑层（含翻译）总开关
    editorCandidates: 24  # 交给 LLM 的候选数
    editorPerAuthor: 3    # 单个账号最多几条进候选
    editorBatchSize: 12   # 每批问 LLM 几条
    editorThreshold: 6    # LLM 的 value 门槛（0-10）
    questions: true       # 评论区问题雷达总开关
    hn: true              # 是否接入 Hacker News 评论
    hnQueries: [claude code, cursor, llm api, ollama, llama.cpp, vllm]
    hnDays: 7             # HN 回看天数
    questionPosts: 12     # 每轮最多扫多少条 X 帖子的回复区
    # editorProvider: deepseek-account   # 不填则用 profile 默认模型
    # editorModel: deepseek-flash
    windowHours: 36       # 时间窗
    minScore: 30          # 分数门槛
    requestGapMs: 4000    # 请求间隔（毫秒）
    cacheMinutes: 50      # 账号抓取结果的缓存时长
    accounts:             # 覆盖默认名单；可写字符串，也可写 { handle, tier }
      - { handle: OpenAI, tier: 1 }
      - karpathy
    dataDir: /custom/path # 可选，默认 $DSH_HOME/storages/ai-radar
```

## 运行

- Host 半：注册 `/plugins/ai-radar/digest`（GET）与 `/plugins/ai-radar/refresh`（POST），每天 `refreshHour` 抓一次；启动时若上次抓取超过 6 小时则自动补一次。
- Client 半：「AI 雷达」入口走左侧导航（`sidebar.panellist`），内容在主区（`main`）打开，不再覆盖头像区。点「返回对话」回到原会话。数据只从 Host 路由取，浏览器不直接碰 X。
- 状态文件：`~/.dsh/storages/ai-radar/state.json`（账号缓存、去重账本、词库、当前摘要）。

## 已知局限

- 只按名单抓，**不能按关键词全网搜**（X 搜索页需要登录）。
- X 公开页面只暴露少量回复，不能代表完整评论区；问题面板是样本聚类，不是全网频率统计。
- 规则分只用于粗排；价值判断和翻译由 LLM 编辑层完成。超长帖子截断到 600 字符（重试时 260），所以超长贴的译文只覆盖前半段。
- 翻译是逐条的：只有入选的帖子才翻译，没入选的不翻。
- 两个端点都有速率限制，一轮全量抓取约 3–6 分钟，属于后台任务。
