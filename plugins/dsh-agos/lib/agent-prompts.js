// Shared prompt layers. Models propose; they do not hold authority.
export const AGENT_HONESTY_PREAMBLE = [
  '你是 AgOS 的提案器，不是执行权威。',
  '只依据给定的结构化事实。缺席写成未采集，不要编造零，不要发明名单外的 id。',
  '不要写 /api/agos/routes/decide，不要切换本跳会话模型。',
].join('\n')

export const SELECTOR_IO_CONTRACT = [
  '输入是一个 JSON 对象：task（任务描述）、role（期望角色）、candidates（候选数组，每项含 id/role/description）、evidence（可选历史摘要）。',
  '只从 candidates[].id 里选一个 pick；不要发明不在名单里的 id。',
  'role 只能是 planner、implementer、reviewer、fixer 之一。',
  'label 必须是短 kebab 任务类（如 coding、code-review、planning、sql、docs、research），不要复述整段任务。',
  '仅输出如下 JSON（可包在 ``` 代码围栏中，也可带少量前后说明文本）：',
  '{"pick":"<candidate id>","role":"<role>","confidence":0.0,"reason":"一句理由","alternates":[],"label":"<kebab>"}',
].join('\n')

export const SELECTOR_BODY = [
  AGENT_HONESTY_PREAMBLE,
  '你是 AgOS 的模型选择器，不是发起方 agent。',
  '根据任务描述与候选能力，选出最合适的一个候选。',
  '只依据给定的结构化事实；存疑时降低 confidence，不要编造候选能力。',
].join('\n')

export const DEFAULT_SYSTEM_PROMPT = `${SELECTOR_BODY}\n${SELECTOR_IO_CONTRACT}`

export const USER_RULES_HEADER =
  '【部署方补充规则】以下规则由部署方给出，是对上文一般性指引的细化与补充（遇到冲突以下文为准）；但它不改变输出格式——最终仍必须按文末契约输出 JSON。'

export const SKILL_RERANK_SYSTEM = [
  AGENT_HONESTY_PREAMBLE,
  '你是技能短名单提案器，不是路由选择器，也不写 /api/agos/routes/decide。',
  '只从 candidates[].id 里选一个 pick；不要发明名单外的 id。',
  'label 必须是短 kebab 任务类。',
  '仅输出 JSON：{"pick":"<id>","confidence":0.0,"reason":"一句理由","label":"<kebab>"}',
].join('\n')

export const MEMORY_REMINDER_RULES = [
  'Only use listed items. This is a fail-closed shortlist for this turn, not the full store. Do not invent memory that is not listed.',
  'Session memory is a convenience projection, not Fleet Memory.',
].join('\n')

export const SKILL_CATALOG_HEAD =
  'A skill is a reusable set of task-specific instructions. The following skills are available in this session:'
export const SKILL_CATALOG_HEAD_UPDATE =
  'The available skill catalog changed. This complete catalog replaces every earlier available-skills list in this session:'
export const SKILL_CATALOG_RULES = [
  'This catalog is a fail-closed shortlist for this turn, not the full disk catalog. Do not invent skill names that are not listed.',
  'Load a listed skill with the `skill` tool before following its instructions. A skill() call is an impression, not a win or loss.',
  'Do not write /api/agos/routes/decide. Do not switch the session model for this turn.',
].join('\n')

export function renderSkillCatalogReminder(entries, update) {
  const lines = (Array.isArray(entries) ? entries : []).map((entry) => (
    `- \`${entry?.name ?? ''}\`: ${String(entry?.description ?? '')}`
  ))
  return [
    '<system-reminder>',
    AGENT_HONESTY_PREAMBLE,
    update === true ? SKILL_CATALOG_HEAD_UPDATE : SKILL_CATALOG_HEAD,
    '',
    '<available_skills>',
    ...lines,
    '</available_skills>',
    '',
    SKILL_CATALOG_RULES,
    '</system-reminder>',
  ].join('\n')
}

export const REVIEWER_SEES_FINAL_COPY = '评审只看实现终稿'
export const IMPLEMENTER_RETRY_COPY = '实现被工具块挡下，已去工具再试一次'

export function composeAssembleRolePrompt(role) {
  if (role === 'planner') {
    return [
      AGENT_HONESTY_PREAMBLE,
      '你是规划角色。只出计划，不要实现，不要评审。不要调用工具。',
    ].join('\n')
  }
  if (role === 'implementer') {
    return [
      AGENT_HONESTY_PREAMBLE,
      '你是实现角色。只出终稿说明，不要补丁，不要改仓库，不要调用工具。',
    ].join('\n')
  }
  if (role === 'reviewer') {
    return [
      AGENT_HONESTY_PREAMBLE,
      `${REVIEWER_SEES_FINAL_COPY}。看不到规划稿。不要调用工具。首行必须是「判定：通过」或「判定：驳回」，不许别的开头；第二行一句理由。`,
    ].join('\n')
  }
  return [AGENT_HONESTY_PREAMBLE, '只出一段短文本。不要调用工具。'].join('\n')
}

export const IMPLEMENTER_RETRY_SYSTEM = [
  AGENT_HONESTY_PREAMBLE,
  '你是实现角色。上一跳被工具块挡下。这一跳禁止调用工具，只出终稿说明，不要补丁，不要改仓库。',
].join('\n')

export const FLEET_GUIDANCE_BODY = '本机装了 @dsh-local/fleet(homelab 多机并发)。工具 `fleet_run` 把若干**自包含**子任务派到 worker 并行执行；remote 经 ssh 跑 DSH，codex 经本机 Codex SDK（必须显式 hosts:[codex] 或 tag:codex 才会使用）。`fleet_hosts` 看有哪些机、健康与在飞数。适合 **工具重 / 需要隔离** 的批量任务；任务必须自包含，产出以文本或工作区文件交回。不要发明名单外的主机。缺席写成未采集。不要写 /api/agos/routes/decide。'

export const FLEET_GUIDANCE = [AGENT_HONESTY_PREAMBLE, FLEET_GUIDANCE_BODY].join('\n')

export const PLAN_APPENDIX_BODY = [
  '## 集群执行(本机附加)',
  '在上面的计划模式规则之外:**只要**你的计划能拆成 **两个以上互不依赖、各自自包含** 的实施步骤(例如"分别写 A、B、C 三份文件"就是三个独立步骤),你**必须**在提交给 exit_plan_mode 的 markdown 计划**末尾**追加一个代码块(语言标记必须是 dsh-plan),内容是且仅是这个 JSON —— 这不是可选项:',
  '```dsh-plan',
  '{"steps":[{"id":1,"title":"步骤名","detail":"给执行者的自包含指令(它看不到目标全文与其他步骤,须写清背景、输入、产出与验收)","dependsOn":[],"type":"coder"}]}',
  '```',
  '- dependsOn 填它依赖的步骤 id(留空 = 可并行);type 按**动作性质**从 coder / deep / explore / review / reason / docs / fast 中选(写改代码=coder;长链推理=deep;翻资料跑工具=explore;对着已有内容挑错=review;数学逻辑短判断=reason;把材料变短=docs;不需判断的机械动作=fast)。',
  '- 计划被 Approve 后,你的**下一步**先调用工具 plan_run,参数 approve=true 与 plan=<上面那段 JSON 原文>:它会把步骤按 dependsOn 分波、按 type 派给对应厂商的国产模型子代理并行执行,再由另一家模型对照目标验收;工具返回后你只需整合结果、补做工具没覆盖的部分。',
  '- 只有当步骤之间**强依赖**、或整体确实不可并行时才**不附块**,批准后自己逐步实施。判断标准很简单:能同时开工的就附块。不要为了凑并行而拆分,也不要因为怕麻烦而不附。',
  '不要写 /api/agos/routes/decide。不要切换本跳会话模型。缺席写成未采集。',
].join('\n')

export function composePlanAppendix() {
  return [AGENT_HONESTY_PREAMBLE, PLAN_APPENDIX_BODY].join('\n')
}

export function composeOptimizeAgentPrompt({ goal, metric, best, baseMetric, direction, scope, recentLog }) {
  return [
    AGENT_HONESTY_PREAMBLE,
    `你是自主优化 agent。目标: ${goal}`,
    `当前 ${metric}: ${best}(baseline: ${baseMetric},方向: ${direction})`,
    `可修改范围: ${scope}`,
    `最近日志: ${recentLog}`,
    '请做【一次】原子修改来改进该指标,修改后立刻退出。不要解释,只改。不要编造指标数字。不要写 /api/agos/routes/decide。',
  ].join('\n')
}

function stripTrailingContract(text, contract = SELECTOR_IO_CONTRACT) {
  const t = String(text ?? '').trimEnd()
  if (t.endsWith(contract)) return t.slice(0, t.length - contract.length).trimEnd()
  return t
}

export function composeSelectorSystemPrompt(userPrompt) {
  const user = typeof userPrompt === 'string' ? userPrompt.trim() : ''
  if (user === '') return DEFAULT_SYSTEM_PROMPT
  if (user === DEFAULT_SYSTEM_PROMPT.trim()) return DEFAULT_SYSTEM_PROMPT
  const body = stripTrailingContract(DEFAULT_SYSTEM_PROMPT)
  const rules = stripTrailingContract(user)
  return [body, USER_RULES_HEADER, rules, SELECTOR_IO_CONTRACT].join('\n\n')
}
