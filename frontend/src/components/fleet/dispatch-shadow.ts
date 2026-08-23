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

/** 同一份表单内容只调一次选择器(「返回修改」后原样再点不重复烧额度);内容变了才算新调用。 */
export function shadowSignature(request: FleetDispatchRequest, hostNames: string[]): string {
  return JSON.stringify({ items: request.items, hosts: request.hosts ?? [], tag: request.tag ?? '', label: request.label ?? '', pool: [...hostNames].sort() });
}

/** 确认页的成本句由影子状态算出,不写常量。 */
export function shadowCostCopy(state: ShadowState): string {
  if (state.status === 'calling') return '检查派发正在做一次选择器影子调用（消耗模型额度）；派发接口尚未调用，也不会唤醒机器。';
  if (state.status === 'done' && state.result.kind === 'decided') return '检查派发已做一次选择器影子调用（已记台账）；派发接口尚未调用，也不会唤醒机器。';
  if (state.status === 'done') return '检查派发未调用选择器；派发接口尚未调用，也不会唤醒机器。';
  if (state.status === 'failed') return '选择器影子调用失败（不影响派发）；派发接口尚未调用，也不会唤醒机器。';
  return '确认前尚未调用派发接口，也不会唤醒机器。';
}
