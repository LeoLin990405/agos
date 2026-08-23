/**
 * W17 影子选择器在 DispatchModal 里的纯函数(不 import CSS,可 node --test)。
 */
import type { ShadowResult } from '@/components/console/routes-assemble';
import type { FleetDispatchRequest } from './dispatch-form';

/**
 * W17 影子选择器的状态。它与 form / pending 完全分开:影子结果只展示、只写台账,
 * 绝不流进 setForm / change / setPending(源锁在 dispatch-modal-shadow.test.ts)。
 */
export type ShadowState =
  | { status: 'idle' }
  | { status: 'calling'; signature: string }
  | { status: 'done'; signature: string; result: ShadowResult }
  | { status: 'failed'; signature: string; error: string };

/**
 * 同一份**选择器输入**只调一次(「返回修改」后原样再点不重复烧额度);内容变了才算新调用。
 * 用户勾选(request.hosts)不进选择器输入,所以不进签名——只改勾选框再点不会再烧一次;
 * 勾选与建议的关系由屏上当前勾选算(见 shadowRelationCopy),不靠台账里那次的 agreed。
 */
export function shadowSignature(request: FleetDispatchRequest, hostNames: string[]): string {
  return JSON.stringify({ items: request.items, tag: request.tag ?? '', label: request.label ?? '', pool: [...hostNames].sort() });
}

/** 这些回落码表示选择器**没有真正打出去**(零模型调用):未配置 / 无适配器 / 并发过载。 */
export const NO_CALL_FALLBACKS: readonly string[] = ['NOT_CONFIGURED', 'NO_ADAPTER', 'OVERLOAD'];

/** 确认页的成本句由影子状态算出,不写常量。 */
export function shadowCostCopy(state: ShadowState): string {
  const tail = '派发接口尚未调用，也不会唤醒机器。';
  if (state.status === 'calling') return `检查派发正在做一次选择器影子调用（消耗模型额度）；${tail}`;
  if (state.status === 'done' && state.result.kind === 'decided') {
    const r = state.result;
    if (r.source === 'fallback' && r.fallbackReason !== undefined && NO_CALL_FALLBACKS.includes(r.fallbackReason)) {
      return `检查派发尝试了选择器影子调用，但选择器没有真正打出去（${r.fallbackReason}，零模型调用，已记台账）；${tail}`;
    }
    return `检查派发已做一次选择器影子调用（已记台账）；${tail}`;
  }
  if (state.status === 'done') return `检查派发未调用选择器；${tail}`;
  if (state.status === 'failed') return `选择器影子调用失败（不影响派发）；${tail}`;
  return `确认前尚未调用派发接口，也不会唤醒机器。`;
}

/** 首页说明句由候选池算出:没有候选就不许诺「会做一次影子调用」。 */
export function shadowIntroCopy(candidateCount: number): string {
  if (candidateCount === 0) return '没有可用的远端机器：「检查派发」不会调用选择器（零额度），也不会写台账。';
  return `「检查派发」会对这 ${candidateCount} 台候选做一次选择器影子调用（消耗模型额度）：只把「选择器会选哪台」记进路由台账并显示出来，不改你的勾选，也不改派发。`;
}

/** 建议与**当前**勾选的关系,由屏上数据算:勾了且一致 / 勾了不一致 / 没勾。pick 为空时无关系。 */
export function shadowRelationCopy(pick: string | null, chosen: readonly string[]): string | undefined {
  if (pick === null) return undefined;
  if (chosen.length === 0) return '你没有勾选机器，派发由调度器分配；建议只记台账';
  return chosen.includes(pick) ? '与你勾选的机器一致' : '与你勾选的机器不一致；派发仍按你的勾选';
}
