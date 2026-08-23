/**
 * 组装提案 / 三角色试跑 的解析、派生与请求。
 *
 * ⚠️ 词汇:这一侧叫「试跑」,不叫「派活」。「派活」留给电脑台的 swarm 子代理批次
 * (AgosComputer),那是真开子代理、会动仓库的;这里三个角色各出一段文本、明令不碰仓库。
 * 同一个词横跨两个危险方向相反的轴,读者会并成一件事(2026-08-23 审查 P1-3)。
 *
 * ⚠️ 诚实闸的方向:**后端是断言方,前端是校验方。**
 * 原来 parseDispatchRun 把 sessionSwitched / outcome 硬写成 false / null,
 * 后端如实报「换了会话、outcome ok」会被前端静默改写成「没换、待回填」,
 * 而唯一上屏的 note 字段却不做任何校验 —— 覆盖 = 把唯一能发现问题的信号删掉
 * (2026-08-23 审查 P1-1)。现在:冻结字段不符或**缺席**、角色表/回合表不合形 → 不解析,
 * 违约点列给界面。缺席也算违约:后端一个字不说,前端不替它印「未换会话」。
 *
 * ⚠️ 屏上文案一律是冻结常量或由同屏数据算出来的;载荷里的文案字段只校验、不搬运。
 * 所有「发生过什么」的时态句与空态门都在 deriveAssembleView() 里算,RoutesView 只渲染 ——
 * 那些同屏互相矛盾的句子,全部出在把门控散在 JSX 里而没有可执行测试的时候
 * (第二轮对抗验证 [7][8][9][10][12][42])。
 *
 * ⚠️ 载荷形状以插件真源为准:POST /assemble 返回 {decision, assemble: 记录, dispatched:false},
 * POST /assemble/dispatch 返回 {dispatch: 记录, assemble, dispatched, sessionSwitched, outcome, note, live},
 * GET /routes 返回 {decisions, assemble, dispatch, stats}。三种信封的外层都可能带契约字段,
 * 所以只按**信封键**下钻,不按外层字段猜(第二轮 [0][28][38]:按外层字段猜把真实信封当成了记录,
 * 线上每次组装/试跑都会报违约 —— 而后端已经落盘、模型已经调用)。
 * routes-assemble.runtime.test.ts 用插件自己的函数造信封来验这一点。
 *
 * 冻结常量与 ~/.dsh/profiles/desktop/plugins/dsh-agos-router/lib/{assemble,dispatch}.js
 * 逐字镜像;两边各自用单测钉住字面量。
 */
export const ASSEMBLE_COPY = '组装提案，只定角色不执行';
export const LIVE_DISPATCH_OFF_COPY = '未接入本跳会话换模';
export const ASSEMBLE_EMPTY_COPY = '还没有组装提案';
export const OUTCOME_CONFIRM_COPY = '确认回填人工胜负，不换本跳会话模型';
export const DISPATCH_COPY = '本次是三角色试跑，未换本跳会话模型';
export const DISPATCH_NO_TOOLS_COPY = '三角色只出文本，不改仓库';
/** 这是前端确认框的句子,与后端 dispatch.js 里同名的 API 错误串**不是**一句话,所以不叫 DISPATCH_CONFIRM_COPY。 */
export const DISPATCH_CONFIRM_CHECK_COPY = '确认三角色试跑：只出文本，不换本跳会话模型，不记胜负';
export const DISPATCH_EMPTY_COPY = '还没有试跑记录';
export const DISPATCH_BUTTON_COPY = '开始三角色试跑';
export const ASSEMBLE_CONFIRM_COPY = '确认只生成组装提案，不换本跳会话模型';
export const ASSEMBLE_HOW_COPY = '组装会在后端内部跑一次选择器（或静态回落）选首选模型，再按后验排三角色，并写一条待回填决策行；界面本身不调用 decide 接口。';
export const CONTRACT_VIOLATION_COPY = '响应与冻结契约不符';

/** 时态句(由同屏数据算出)用到的片段。 */
export const STATUS_NOT_RUN_COPY = '尚未试跑';
export const STATUS_HAS_RUN_COPY = '已有试跑记录（只出文本，未换本跳会话模型）';
/** 台账只保留最近一条试跑,所以只能说「没有可见记录」,推不出「没跑过」(第三轮 [9])。 */
export const STATUS_OTHER_RUN_COPY = '这条提案没有可见的试跑记录；台账最近一次试跑属于另一条提案';
export const STATUS_OTHER_RUN_UNKNOWN_COPY = '这条提案没有可见的试跑记录；台账最近一次试跑的归属未采集';
export const STATUS_RUN_INVALID_COPY = '试跑记录与冻结契约不符，状态未采集';
export const STATUS_LEDGER_UNREAD_COPY = '台账未读到，试跑状态未采集';
export const LISTED_RUN_HEADER_COPY = '这条提案的试跑记录（只出文本，未换本跳会话模型）';
/** ok:true 且 text 为空在契约里只有一个来源:后端 sanitizePreview 把产出判成敏感后清空(第三轮 [2])。 */
export const TURN_TEXT_REDACTED_COPY = '产出文本被敏感信息闸扣下，未采集';
/** 回合文本是模型原话,不是系统断言;上屏时带这个前缀(第三轮 [11])。 */
export const TURN_TEXT_PREFIX = '原话 · ';
/** 成功回合被 maxTokens 截断:文本不完整,后面的角色看的也是这份不完整稿。 */
export const TURN_TRUNCATED_COPY = '（被 maxTokens 上限截断，文本不完整）';

/**
 * 退役文案:台账里的历史行带的是改名前的常量,它们当时就是冻结值,不能因为改名
 * 被追认成违约。**只认这张表**,表外任何文本都是违约;表本身由单测逐字钉住。
 * 2026-08-23「派活测试」→「三角色试跑」;同日「组装提案，不是已派活」→「只定角色不执行」
 * (中间那版「尚未试跑」从未落盘,不入表)。
 */
export const RETIRED_ASSEMBLE_NOTES: readonly string[] = ['组装提案，不是已派活'];
export const RETIRED_DISPATCH_NOTES: readonly string[] = ['本次是派活测试，未换本跳会话模型'];
/** 改名落地时刻(2026-08-23 03:20 +08:00)。退役文案只对早于这一刻的记录有效;之后还带旧文案 = 后端没更新(第三轮 [23])。 */
export const RETIRED_BEFORE_TS = 1787426400000;

/** 后端 assemble.js 会写进 notes 的两句(GENERATION_NEQ_REVIEW_COPY / POOL_TOO_SMALL_COPY)。 */
export const NOTE_DISTINCT_COPY = 'generation≠review：评审模型必须和实现模型不同';
export const NOTE_POOL_SMALL_COPY = '候选池不够，未能做到 generation≠review';
export const KNOWN_ASSEMBLE_NOTES: readonly string[] = [NOTE_DISTINCT_COPY, NOTE_POOL_SMALL_COPY];

/** 后端 dispatch.js 会写进 turns[].note 的唯一一句(MODEL_UNRESOLVED_COPY)。 */
export const KNOWN_TURN_NOTES: readonly string[] = ['宿主未配置该模型'];

/**
 * dispatch.js / selector-llm.js 的错误码全集 → 中文。认不出的不渲染原码(019 同口径)。
 * 用 Map 不用对象:`'__proto__' in obj` 为真,会把 Object.prototype 当文案渲染,React 直接抛错(第二轮 [1])。
 * 2026-08-23 插件把 BAD_OUTPUT 拆成四个码(stream-outcome.js):供应商报错在宿主里是 finish{kind:'error'}
 * 块不是 throw,原来全被记成「无文本」。BAD_OUTPUT 一行保留,只为认得台账历史行(dsp-1787419059326)。
 */
export const TURN_ERROR_COPY = new Map<string, string>([
  ['UNRESOLVED', '宿主未配置该模型'],
  ['NO_ADAPTER', '宿主缺少 llm 适配器'],
  ['TIMEOUT', '超时'],
  ['ABORTED', '已中止'],
  ['BAD_OUTPUT', '没有产出可见文本（旧码，原因未拆分）'],
  ['NO_TEXT', '没有产出文本块'],
  ['TOOL_CALL', '模型试图调用工具'],
  ['UNPARSEABLE', '输出不是约定的 JSON'],
  ['PROVIDER_ERROR', '供应商报错'],
  ['STREAM_ERROR', '流式调用出错'],
  ['OVERLOAD', '供应商过载'],
]);
/**
 * 供应商错误码 → 中文。来源:dsh-llm-pi-ai classifyPiAiError + dsh-llm-deepseek 的 wire finish_reason 大写 +
 * dsh-llm adapter-failure 的 UNKNOWN 兜底。认不出的不渲染(只显「供应商报错」)。
 */
const PROVIDER_CODE_COPY = new Map<string, string>([
  ['AUTH', '鉴权失败'],
  ['QUOTA', '额度用尽'],
  ['RATE_LIMIT', '限流'],
  ['INVALID_REQUEST', '请求不合法'],
  ['INVALID_CREDENTIAL', '凭据无效'],
  ['MISSING_CREDENTIAL', '缺少凭据'],
  ['UNKNOWN_MODEL', '宿主不认识该模型（配置错）'],
  ['SERVER', '供应商服务端错误'],
  ['TIMEOUT', '供应商超时'],
  ['LLM_STREAM_IDLE_TIMEOUT', '流空闲超时'],
  ['TRANSPORT', '网络传输错误'],
  ['STREAM_CLOSED', '流被关闭'],
  ['CONTEXT_WINDOW_EXCEEDED', '超出上下文窗口'],
  ['CONTENT_FILTER', '内容被供应商过滤'],
  ['EMPTY_RESPONSE', '供应商返回空响应'],
  ['MALFORMED_RESPONSE', '供应商响应格式不对'],
  ['UNSUPPORTED_CONTENT', '内容类型不受支持'],
  ['PI_AI_ERROR', '供应商错误（未细分）'],
  ['UNKNOWN', '原因未知'],
]);
export const TURN_ERROR_UNKNOWN_COPY = '失败，错误码未识别';
export const TURN_TEXT_LIMIT = 400;

/** 形状:角色名只认四个;模型名是 ASCII slug;提案/试跑 id 是 asm-/dsp- 加数字;任务类镜像 labels.js。 */
export const ROLE_SET: ReadonlySet<string> = new Set(['planner', 'implementer', 'reviewer', 'fixer']);
const CORE_ROLES = ['planner', 'implementer', 'reviewer'] as const;
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._\-\[\]]{0,79}$/;
const ASSEMBLE_ID_RE = /^asm-\d{1,20}$/;
const DISPATCH_ID_RE = /^dsp-\d{1,20}$/;
const LABEL_RE = /^(?:[a-z0-9一-鿿]+(?:-[a-z0-9一-鿿]+)*|[a-z0-9一-鿿-]{1,16}~[0-9a-f]{12})$/u;
const LABEL_LIMIT = 32;

export interface AssembleRole {
  role: string;
  model: string;
}

/** 解析结果里没有 note / live:界面文案由冻结常量给出,不从载荷搬运。 */
export interface AssemblePlan {
  id?: string;
  label?: string;
  source?: 'selector' | 'fallback';
  pick?: string;
  dispatched: false;
  roles: AssembleRole[];
  /** 只含与同屏 roles 一致的已知说明;与 distinct 矛盾的后端原话不显示(第二轮 [13])。 */
  notes: string[];
  unknownNotes: number;
  /** 由同屏 roles 算出:评审模型 ≠ 实现模型。不信后端自报的 distinct。 */
  distinct: boolean;
}

export interface DispatchTurn {
  role: string;
  model: string;
  ok: boolean;
  /** 已译成中文的失败说明;ok 时为 undefined。 */
  failure?: string;
  /** 模型产出,前端再截一次 TURN_TEXT_LIMIT。 */
  text?: string;
  /** ok 但没有文本:按契约只可能是后端敏感信息闸把产出清空了。 */
  redacted?: boolean;
  /** ok 但 finish=max-tokens:文本被上限截断,后面的角色看的是截断稿。 */
  truncated?: boolean;
}

export interface DispatchRun {
  id?: string;
  /** 指向被试跑的那条组装提案(asm-…)。界面靠它判断「这条提案试跑过没有」。 */
  ref?: string;
  dispatched: true;
  sessionSwitched: false;
  outcome: null;
  turns: DispatchTurn[];
}

export interface ContractViolation {
  field: string;
  expected: string;
  got: string;
}

const SHOW_LIMIT = 80;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 违约值只给一个截断过的预览;alert 区不是后端文本的搬运带。字符串按原长计数,不算引号与转义。 */
const show = (value: unknown): string => {
  if (value === undefined) return '缺席';
  if (typeof value === 'string') {
    return value.length > SHOW_LIMIT ? `"${value.slice(0, SHOW_LIMIT)}…"(共 ${value.length} 字符)` : `"${value}"`;
  }
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > SHOW_LIMIT ? `${text.slice(0, SHOW_LIMIT)}…(共 ${text.length} 字符)` : text;
};

const clip = (value: string, limit: number): string =>
  value.length > limit ? `${value.slice(0, limit)}…` : value;

/**
 * 只按**信封键**下钻一层:值里有 key → 取 value[key](是记录就用,不是记录就当没有);
 * 值里没有 key → 只有它自己带 roles / turns 才算裸记录,否则就是一个没有这条记录的信封
 * (第三轮 [0][10][20]:原来「没有键 = 值本身是记录」把空台账的 GET 信封判成 4+7 条「缺席」违约)。
 * 不按外层有没有 dispatched 之类字段猜。
 */
const unwrap = (value: unknown, key: 'assemble' | 'dispatch'): Record<string, unknown> | null => {
  if (!isRecord(value)) return null;
  if (key in value) {
    const inner = value[key];
    return isRecord(inner) ? inner : null;
  }
  return (key === 'assemble' ? 'roles' : 'turns') in value ? value : null;
};

/** 文案字段必须**在场**且在表内。缺席不是默认值,是违约。退役值只对改名前落盘的记录有效。 */
function frozenText(root: Record<string, unknown>, field: string, current: string, retired: readonly string[], out: ContractViolation[]): void {
  const got = root[field];
  if (got === current) return;
  if (typeof got === 'string' && retired.includes(got)) {
    if (typeof root.ts === 'number' && root.ts < RETIRED_BEFORE_TS) return;
    out.push({ field, expected: `${current}（退役文案只对 ${RETIRED_BEFORE_TS} 之前的记录有效）`, got: show(got) });
    return;
  }
  out.push({ field, expected: current, got: show(got) });
}

const roleRowOk = (row: unknown): row is { role: string; model: string } =>
  isRecord(row) && typeof row.role === 'string' && ROLE_SET.has(row.role)
  && typeof row.model === 'string' && MODEL_ID_RE.test(row.model);

/** 角色表 / 回合表必须非空且每行合形;否则是违约,不是「没有记录」(第二轮 [5][11])。 */
function shapedRows(root: Record<string, unknown>, field: 'roles' | 'turns', out: ContractViolation[]): void {
  const raw = root[field];
  if (!Array.isArray(raw) || raw.length === 0) {
    out.push({ field, expected: '非空数组', got: show(raw) });
    return;
  }
  const bad = raw.findIndex((row) => {
    if (!roleRowOk(row)) return true;
    if (field !== 'turns') return false;
    const r = row as Record<string, unknown>;
    return typeof r.ok !== 'boolean' || (r.ok === true && r.error !== undefined);
  });
  if (bad >= 0) {
    out.push({ field: `${field}[${bad}]`, expected: '角色∈{planner,implementer,reviewer,fixer} · 模型名为 ASCII slug' + (field === 'turns' ? ' · ok 为布尔且 ok 时无 error' : ''), got: show(raw[bad]) });
    return;
  }
  // 行间:planner / implementer / reviewer 各恰好一次(第三轮 [4][7]:重复角色让 distinct 按最后一行算,与列表第一行矛盾)。
  const counts = new Map<string, number>();
  for (const row of raw as { role: string }[]) counts.set(row.role, (counts.get(row.role) ?? 0) + 1);
  const missing = CORE_ROLES.filter((r) => (counts.get(r) ?? 0) !== 1);
  if (missing.length > 0) out.push({ field, expected: 'planner / implementer / reviewer 各恰好一次', got: `${missing.join(',')} 的出现次数为 ${missing.map((r) => counts.get(r) ?? 0).join(',')}` });
}

function assembleViolationsOf(root: Record<string, unknown>): ContractViolation[] {
  const out: ContractViolation[] = [];
  if (root.dispatched !== false) out.push({ field: 'dispatched', expected: 'false', got: show(root.dispatched) });
  frozenText(root, 'note', ASSEMBLE_COPY, RETIRED_ASSEMBLE_NOTES, out);
  frozenText(root, 'live', LIVE_DISPATCH_OFF_COPY, [], out);
  shapedRows(root, 'roles', out);
  return out;
}

function dispatchViolationsOf(root: Record<string, unknown>): ContractViolation[] {
  const out: ContractViolation[] = [];
  if (root.dispatched !== true) out.push({ field: 'dispatched', expected: 'true', got: show(root.dispatched) });
  if (root.sessionSwitched !== false) out.push({ field: 'sessionSwitched', expected: 'false', got: show(root.sessionSwitched) });
  if (root.outcome !== null) out.push({ field: 'outcome', expected: 'null', got: show(root.outcome) });
  frozenText(root, 'note', DISPATCH_COPY, RETIRED_DISPATCH_NOTES, out);
  frozenText(root, 'live', LIVE_DISPATCH_OFF_COPY, [], out);
  frozenText(root, 'tools', DISPATCH_NO_TOOLS_COPY, [], out);
  shapedRows(root, 'turns', out);
  return out;
}

/** 组装提案的冻结契约。传信封({assemble: 记录, …})或记录本身都行,看到的是同一层。 */
export function assembleContractViolations(value: unknown): ContractViolation[] {
  const root = unwrap(value, 'assemble');
  return root ? assembleViolationsOf(root) : [];
}

/** 试跑的冻结契约。传信封({dispatch: 记录, …})或记录本身都行。 */
export function dispatchContractViolations(value: unknown): ContractViolation[] {
  const root = unwrap(value, 'dispatch');
  return root ? dispatchViolationsOf(root) : [];
}

export function formatViolations(kind: '组装' | '试跑', list: readonly ContractViolation[]): string {
  const parts = list.map((v) => `${v.field} 应为 ${v.expected}，实为 ${v.got}`);
  return `${kind}${CONTRACT_VIOLATION_COPY}：${parts.join('；')}`;
}

const idField = (value: unknown, re: RegExp): string | undefined =>
  typeof value === 'string' && re.test(value) ? value : undefined;

/** 违约 → null。没有记录 → null。两者由调用方用 *ContractViolations 区分(违约一定非空)。 */
export function parseAssemblePlan(value: unknown): AssemblePlan | null {
  const root = unwrap(value, 'assemble');
  if (!root) return null;
  if (assembleViolationsOf(root).length > 0) return null;
  const roles = (root.roles as unknown[]).filter(roleRowOk).map((r) => ({ role: r.role, model: r.model }));
  const byRole = new Map(roles.map((r) => [r.role, r.model]));
  const implementer = byRole.get('implementer');
  const reviewer = byRole.get('reviewer');
  const distinct = typeof implementer === 'string' && typeof reviewer === 'string' && implementer !== reviewer;
  const rawNotes = Array.isArray(root.notes) ? root.notes : [];
  // 「评审模型必须和实现模型不同」是规则句,照显;「候选池不够」是事实句,只在同屏 roles 确实评审=实现时显示
  // (第三轮 [30]:后端小池时两句并出,原来把规则句当事实句对照,把标准输出判成了「不一致」)。
  const consistent = (note: string): boolean => (note === NOTE_DISTINCT_COPY ? true : note === NOTE_POOL_SMALL_COPY ? !distinct : false);
  const notes = rawNotes.filter((item): item is string => typeof item === 'string' && consistent(item));
  const label = typeof root.label === 'string' && root.label.length <= LABEL_LIMIT && LABEL_RE.test(root.label) ? root.label : undefined;
  return {
    id: idField(root.id, ASSEMBLE_ID_RE),
    label,
    source: root.source === 'selector' || root.source === 'fallback' ? root.source : undefined,
    pick: idField(root.pick, MODEL_ID_RE),
    dispatched: false,
    roles,
    notes,
    unknownNotes: rawNotes.length - notes.length,
    distinct,
  };
}

/**
 * 回合失败说明:后端 note 只认表内那句,error 码译成中文,都认不出就说「未识别」。不搬运。
 * PROVIDER_ERROR 再带供应商码的译文(认不出就不带);finish 为 max-tokens 时点明「被上限截断」——
 * 这两样都是台账里的离散码,不是自由文本。
 */
export function turnFailureCopy(row: { note?: unknown; error?: unknown; providerCode?: unknown; finish?: unknown }): string {
  if (typeof row.note === 'string' && KNOWN_TURN_NOTES.includes(row.note)) return row.note;
  if (typeof row.error !== 'string') return TURN_ERROR_UNKNOWN_COPY;
  const copy = TURN_ERROR_COPY.get(row.error);
  if (copy === undefined) return TURN_ERROR_UNKNOWN_COPY;
  const provider = typeof row.providerCode === 'string' ? PROVIDER_CODE_COPY.get(row.providerCode) : undefined;
  const truncated = row.finish === 'max-tokens' ? '，输出被 maxTokens 上限截断' : '';
  return `${copy}${provider ? `（${provider}）` : ''}${truncated}`;
}

export function parseDispatchRun(value: unknown): DispatchRun | null {
  const root = unwrap(value, 'dispatch');
  if (!root) return null;
  if (dispatchViolationsOf(root).length > 0) return null;
  const turns = (root.turns as unknown[]).filter(roleRowOk).map((row): DispatchTurn => {
    const r = row as Record<string, unknown>;
    const ok = r.ok === true;
    return {
      role: row.role,
      model: row.model,
      ok,
      failure: ok ? undefined : turnFailureCopy(r),
      text: ok && typeof r.text === 'string' && r.text !== '' ? clip(r.text, TURN_TEXT_LIMIT) : undefined,
      redacted: ok && (typeof r.text !== 'string' || r.text === ''),
      truncated: ok && r.finish === 'max-tokens',
    };
  });
  return {
    id: idField(root.id, DISPATCH_ID_RE),
    ref: idField(root.ref, ASSEMBLE_ID_RE),
    dispatched: true,
    sessionSwitched: false,
    outcome: null,
    turns,
  };
}

export function sourceCopy(source: string | undefined): string {
  if (source === 'fallback') return '静态回落';
  if (source === 'selector') return '选择器';
  return '来源未采集';
}

/** 唯一的「这条试跑属于这条提案」谓词:两边的 id 都要在场且相等。 */
export const isDispatchOfThis = (assemble: AssemblePlan | null, dispatch: DispatchRun | null): dispatch is DispatchRun =>
  assemble !== null && dispatch !== null && assemble.id !== undefined && dispatch.ref !== undefined && dispatch.ref === assemble.id;

/**
 * 组装段落的全部派生状态。RoutesView 只渲染这个对象,不自己判断。
 * 输入:台账载荷(GET /routes 信封,可能还没加载到)、本地刚组装的提案、本地刚跑完的试跑。
 */
export interface AssembleView {
  ledgerLoaded: boolean;
  assembleViolations: ContractViolation[];
  dispatchViolations: ContractViolation[];
  assemble: AssemblePlan | null;
  /** 属于屏上这条提案的试跑(本地刚跑的优先,其次台账的);没有则 null。 */
  dispatchOfThis: DispatchRun | null;
  /** 时态句:尚未 / 已有 / 属于另一条 / 归属未采集 / 契约不符 / 台账未读到。没有提案时 undefined。 */
  statusCopy: string | undefined;
  /** 提案那一整行:类别句 + (台账试跑未违约时的)保证句 + 时态句。整句由这里给,视图不拼(第三轮 [37])。 */
  assembleLine: string | undefined;
  /** 试跑列表抬头:本地刚跑的说「本次」,台账里的不说「本次」。 */
  dispatchHeader: string | undefined;
  showAssembleEmpty: boolean;
  showDispatchEmpty: boolean;
}

export function deriveAssembleView(input: {
  /** GET /routes 的信封(RoutesPayload),可能还没加载到。 */
  payload: object | undefined;
  proposed: AssemblePlan | null;
  localRun: DispatchRun | null;
}): AssembleView {
  const { payload, proposed, localRun } = input;
  const ledgerLoaded = payload !== undefined;
  const assembleViolations = payload ? assembleContractViolations(payload) : [];
  const dispatchViolations = payload ? dispatchContractViolations(payload) : [];
  const listedAssemble = payload ? parseAssemblePlan(payload) : null;
  const listedDispatch = payload ? parseDispatchRun(payload) : null;
  const assemble = proposed ?? listedAssemble;
  const dispatchOfThis = isDispatchOfThis(assemble, localRun) ? localRun : isDispatchOfThis(assemble, listedDispatch) ? listedDispatch : null;

  let statusCopy: string | undefined;
  if (assemble !== null) {
    // 本地刚跑完、且指向屏上这条提案的试跑,是最新的一手证据,压过台账那条的违约(第三轮 [6][25])。
    if (dispatchOfThis !== null) statusCopy = STATUS_HAS_RUN_COPY;
    else if (!ledgerLoaded) statusCopy = STATUS_LEDGER_UNREAD_COPY;
    else if (dispatchViolations.length > 0) statusCopy = STATUS_RUN_INVALID_COPY;
    // 「台账最近一次」说的是台账,就只看台账那条,不看本地状态(第二轮 [12]);ref 认不出只能说归属未采集(第三轮 [3][8])。
    else if (listedDispatch !== null) statusCopy = listedDispatch.ref ? `${STATUS_OTHER_RUN_COPY} ${listedDispatch.ref}` : STATUS_OTHER_RUN_UNKNOWN_COPY;
    else statusCopy = STATUS_NOT_RUN_COPY;
  }
  const dispatchHeader = dispatchOfThis === null ? undefined : dispatchOfThis === localRun ? DISPATCH_COPY : LISTED_RUN_HEADER_COPY;
  // 保证句「未接入本跳会话换模」只在台账里这条提案的试跑没有自报相反证据时出现。
  const assembleLine = assemble === null || statusCopy === undefined
    ? undefined
    : `${ASSEMBLE_COPY}。${dispatchViolations.length > 0 && dispatchOfThis === null ? '' : `${LIVE_DISPATCH_OFF_COPY}。`}${statusCopy}。`;
  return {
    ledgerLoaded,
    assembleViolations,
    dispatchViolations,
    assemble,
    dispatchOfThis,
    statusCopy,
    assembleLine,
    dispatchHeader,
    showAssembleEmpty: ledgerLoaded && assemble === null && assembleViolations.length === 0,
    // 「还没有试跑记录」只在台账里**一条试跑都没有**时说;属于别的提案的那条由 statusCopy 交代(第二轮 [9])。
    showDispatchEmpty: ledgerLoaded && assemble !== null && dispatchViolations.length === 0 && listedDispatch === null && localRun === null,
  };
}

/**
 * 这个文件是路由面**唯一**的写端点出口。RoutesView 不直接发请求。
 * 锁法(routes-assemble.test.ts / routes-assemble.runtime.test.ts):
 *  1. 运行时锁 —— **先**替换 globalThis.fetch 再 import 本模块,记录真实发出的 (method, url, body 键),
 *     调用下面三个函数,断言集合恰好等于白名单。模块顶层别名也逃不过:钩子在模块求值之前。
 *  2. 本文件 AST 锁 —— `fetch` 标识符只许作为直接被调函数出现,且第一个实参必须是白名单里的
 *     字符串字面量;不许别名、不许属性访问、不许 XMLHttpRequest / sendBeacon / WebSocket。
 *  3. 仓级扫描 —— TypeScript 扫描 src/** 含测试与 .js/.mts,字面量里 routes/decide(不分大小写)零出现、
 *     路由路径不许参与 + 拼接 / 数组 / 模板串、写路径只许在本文件。
 * ⚠️ 三把锁防的是**漂移与顺手**,不是对手:URL 分段写在别的文件、`typeof window` 门、
 * `Reflect.get(globalThis, 'fe'+'tch')` 都能同时绕过三把锁(第三轮对抗验证 [13][35])。
 * 而且 POST /api/agos/routes/decide 在后端是**活端点**,不会 405。所以「UI 不 POST decide」
 * 是一条由代码审查与这三把锁共同维持的纪律,不是一道物理墙。
 */
/** 后端错误串也不搬运:只认插件 index.js / dispatch.js 会发的几句,其余只给状态码与错误码(第三轮 [22])。 */
export const KNOWN_BACKEND_ERRORS: readonly string[] = [
  '组装提案需要 confirm:true',
  '三角色试跑需要 confirm:true',
  '请求指定的提案不是台账最新一条，拒绝试跑',
  '还没有组装提案',
  'outcome result must be ok or fail',
  'outcome ref is required',
];
const errorOf = (payload: unknown, status: number): string => {
  if (isRecord(payload)) {
    if (typeof payload.error === 'string' && KNOWN_BACKEND_ERRORS.includes(payload.error)) return payload.error;
    if (typeof payload.code === 'string' && /^[A-Z_]{3,40}$/.test(payload.code)) return `HTTP ${status} · 错误码 ${payload.code}`;
  }
  return `HTTP ${status}`;
};

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json() as unknown;
  } catch {
    return undefined;
  }
}

export async function postRouteOutcome(
  input: { ref: string; result: 'ok' | 'fail'; confirm: boolean },
  signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (input.confirm !== true) {
    return { ok: false, error: '回填胜负需要确认' };
  }
  const ref = input.ref.trim();
  if (ref === '') {
    return { ok: false, error: '决策编号未采集' };
  }
  const response = await fetch('/api/agos/routes/outcome', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ref, result: input.result, source: 'operator' }),
    signal,
  });
  const payload = await readJson(response);
  if (!response.ok) {
    return { ok: false, error: errorOf(payload, response.status) };
  }
  return { ok: true };
}

export async function postAssembleProposal(
  input: { task: string; confirm: boolean },
  signal?: AbortSignal,
): Promise<{ ok: true; plan: AssemblePlan } | { ok: false; error: string }> {
  if (input.confirm !== true) {
    return { ok: false, error: '组装提案需要确认' };
  }
  const response = await fetch('/api/agos/routes/assemble', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task: input.task, confirm: true }),
    signal,
  });
  const payload = await readJson(response);
  if (!response.ok) {
    return { ok: false, error: errorOf(payload, response.status) };
  }
  if (!isRecord(payload)) {
    return { ok: false, error: '组装响应不是对象' };
  }
  if (typeof payload.error === 'string') {
    return { ok: false, error: errorOf(payload, response.status) };
  }
  const violations = assembleContractViolations(payload);
  if (violations.length > 0) {
    return { ok: false, error: formatViolations('组装', violations) };
  }
  const plan = parseAssemblePlan(payload);
  if (!plan) {
    return { ok: false, error: '组装响应缺少提案记录' };
  }
  return { ok: true, plan };
}

export async function postAssembleDispatch(
  input: { task: string; ref: string; confirm: boolean },
  signal?: AbortSignal,
): Promise<{ ok: true; dispatch: DispatchRun } | { ok: false; error: string }> {
  if (input.confirm !== true) {
    return { ok: false, error: DISPATCH_CONFIRM_CHECK_COPY };
  }
  const ref = input.ref.trim();
  if (!ASSEMBLE_ID_RE.test(ref)) {
    return { ok: false, error: '提案编号未采集，无法指定试跑对象' };
  }
  const response = await fetch('/api/agos/routes/assemble/dispatch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // ref 指定「对屏上这条提案试跑」;后端核对台账最新提案,不一致即 409。
    body: JSON.stringify({ task: input.task, ref, confirm: true }),
    signal,
  });
  const payload = await readJson(response);
  if (!response.ok) {
    return { ok: false, error: errorOf(payload, response.status) };
  }
  if (!isRecord(payload)) {
    return { ok: false, error: '试跑响应不是对象' };
  }
  if (typeof payload.error === 'string') {
    return { ok: false, error: errorOf(payload, response.status) };
  }
  const violations = dispatchContractViolations(payload);
  if (violations.length > 0) {
    return { ok: false, error: formatViolations('试跑', violations) };
  }
  const dispatch = parseDispatchRun(payload);
  if (!dispatch) {
    return { ok: false, error: '试跑响应缺少试跑记录' };
  }
  return { ok: true, dispatch };
}
