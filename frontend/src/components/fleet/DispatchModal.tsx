import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { fleetHostsStore, type FleetDispatchResult, type FleetHost } from '@/stores/live';
import { HostPowerBadge } from '@/components/fleet/HostPowerBadge';
import { fleetHostVisualState } from '@/components/console/fleet-model';
import {
  describeDispatchTargets,
  parseDispatchItems,
  validateDispatchForm,
  type DispatchFormValue,
  type FleetDispatchRequest,
} from './dispatch-form';
import { postShadowLink, postShadowSelection, shadowSuggestionCopy } from '@/components/console/routes-assemble';
import { fallbackReasonCopy } from '@/components/console/routes-model';
import { shadowCostCopy, shadowIntroCopy, shadowRelationCopy, shadowSignature, type ShadowState } from './dispatch-shadow';
import './DispatchModal.css';

export interface DispatchModalProps {
  open: boolean;
  hosts: FleetHost[];
  onClose: () => void;
  onDispatch: (request: FleetDispatchRequest) => Promise<FleetDispatchResult>;
  onDispatched?: (batchId: string) => void;
}

const EMPTY_FORM: DispatchFormValue = {
  tasks: '',
  hosts: [],
  tag: '',
  wake: true,
  timeoutMinutes: '',
  label: '',
};

export const DispatchModal: React.FC<DispatchModalProps> = ({
  open,
  hosts,
  onClose,
  onDispatch,
  onDispatched,
}) => {
  const [form, setForm] = useState<DispatchFormValue>(EMPTY_FORM);
  const [pending, setPending] = useState<FleetDispatchRequest>();
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  // 影子状态不随 open 重置:关了再开、内容没变就不该再烧一次;签名(不含勾选)变了才会再调。
  const [shadow, setShadow] = useState<ShadowState>({ status: 'idle' });
  const shadowRef = useRef<ShadowState>(shadow);
  shadowRef.current = shadow;

  useEffect(() => {
    if (!open) return;
    setPending(undefined);
    setError(undefined);
    setSubmitting(false);
  }, [open]);

  const hostsState = useSyncExternalStore(fleetHostsStore.subscribe, fleetHostsStore.getSnapshot);
  const powerByHost = useMemo(
    () => new Map(hostsState.power.map((node) => [node.host, node])),
    [hostsState.power],
  );
  const remoteHosts = useMemo(
    () => hosts.filter((host) => host.kind === 'remote' && host.enabled),
    [hosts],
  );
  const tags = useMemo(
    () => [...new Set(remoteHosts.flatMap((host) => host.tags))].sort((a, b) => a.localeCompare(b)),
    [remoteHosts],
  );
  const previewCount = parseDispatchItems(form.tasks).length;

  const change = <K extends keyof DispatchFormValue>(key: K, value: DispatchFormValue[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    setError(undefined);
  };
  const toggleHost = (name: string) => {
    change('hosts', form.hosts.includes(name)
      ? form.hosts.filter((host) => host !== name)
      : [...form.hosts, name]);
  };
  const close = () => {
    if (!submitting) onClose();
  };
  /** W17:校验通过后做一次影子调用。同签名不重复;结果只进 shadow state。 */
  const runShadow = (request: FleetDispatchRequest) => {
    const signature = shadowSignature(request, remoteHosts.map((h) => h.name));
    // done / calling / failed 同签名都不再调:failed 也可能是超时——已经打出去、已经计费
    if (shadow.status !== 'idle' && shadow.signature === signature) return;
    if (remoteHosts.length === 0) {
      // 前端就能判定的「跳过」不发请求,也不显示成「失败」
      setShadow({ status: 'done', signature, result: { kind: 'skipped', message: '没有可用的远端机器，未调用选择器' } });
      return;
    }
    setShadow({ status: 'calling', signature });
    void postShadowSelection({
      items: request.items,
      hosts: remoteHosts.map((h) => ({ name: h.name, kind: h.kind, model: h.model, tags: h.tags, maxConcurrency: h.maxConcurrency, enabled: h.enabled, ok: h.ok, inflight: h.inflight })),
      chosen: request.hosts ?? [],
      tag: request.tag ?? '',
      label: request.label ?? '',
      confirm: true,
    }).then((r) => {
      setShadow(r.ok ? { status: 'done', signature, result: r.result } : { status: 'failed', signature, error: r.error });
    }).catch((cause: unknown) => {
      setShadow({ status: 'failed', signature, error: cause instanceof Error ? cause.message : String(cause) });
    });
  };
  const review = () => {
    const result = validateDispatchForm(form);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(undefined);
    setPending(result.request);
    runShadow(result.request);
  };
  const confirm = async () => {
    if (pending === undefined || submitting) return;
    setSubmitting(true);
    setError(undefined);
    try {
      const result = await onDispatch(pending);
      // W17:派发真的发生了 → 把 batchId 与实际落的机器挂到影子决策上(失败不影响派发,只在控制台留痕)。
      // 读 ref 而不是渲染闭包:await 期间影子可能刚落定。
      const latest = shadowRef.current;
      if (latest.status === 'done' && latest.result.kind === 'decided') {
        const hostsHit = [...new Set(result.runs.map((run) => run.host))];
        void postShadowLink({ ref: latest.result.id, batchId: result.batchId, hosts: hostsHit }).then((r) => {
          if (!r.ok) console.warn('影子决策关联批次失败', r.error);
        });
      }
      setForm(EMPTY_FORM);
      setPending(undefined);
      onDispatched?.(result.batchId);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSubmitting(false);
    }
  };
  const shadowCopy = shadow.status === 'done' ? shadowSuggestionCopy(shadow.result, fallbackReasonCopy) : undefined;
  // 关系按**当前**勾选算(签名不含勾选,台账里的 agreed 是那次调用时的)
  const shadowRelation = shadow.status === 'done' && shadow.result.kind === 'decided' ? shadowRelationCopy(shadow.result.pick, pending?.hosts ?? []) : shadowCopy?.relation;
  // 影子调用在途时不许派发:否则 batchId 挂不上,这条已烧额度的影子行永远孤儿
  const shadowInFlight = shadow.status === 'calling';

  const targetText = describeDispatchTargets(pending?.hosts ?? [], remoteHosts, pending?.tag ?? '');
  const footer = pending === undefined ? (
    <>
      <Button variant="ghost" onClick={close}>取消</Button>
      <Button variant="primary" onClick={review} title={shadowIntroCopy(remoteHosts.length)}>检查派发</Button>
    </>
  ) : (
    <>
      <Button variant="ghost" disabled={submitting} onClick={() => setPending(undefined)}>返回修改</Button>
      <Button data-dispatch-confirm variant="primary" disabled={submitting || shadowInFlight} onClick={() => void confirm()}>
        {submitting ? '正在派发…' : shadowInFlight ? '等影子调用返回…' : '确认并派发'}
      </Button>
    </>
  );

  return (
    <Modal
      isOpen={open}
      onClose={close}
      title={pending === undefined ? '派任务到 Homelab' : '确认模型调用'}
      footer={footer}
      maxWidth="680px"
      initialFocusSelector={pending === undefined ? '[data-dispatch-tasks]' : '[data-dispatch-confirm]'}
      overlayClassName="dispatch-modal"
    >
      {pending === undefined ? (
        <>
          <div className="form-group">
            <label className="form-label" htmlFor="fleet-dispatch-label">批次名称（可选）</label>
            <input
              id="fleet-dispatch-label"
              className="form-input"
              maxLength={120}
              value={form.label}
              onChange={(event) => change('label', event.target.value)}
              placeholder="例如：文档回归 ×3"
            />
          </div>
          <div className="form-group">
            <div className="dispatch-modal__label-row">
              <label className="form-label" htmlFor="fleet-dispatch-tasks">任务</label>
              <span className="dispatch-modal__count">{previewCount}/32 项</span>
            </div>
            <textarea
              id="fleet-dispatch-tasks"
              data-dispatch-tasks
              className="form-input dispatch-modal__tasks"
              value={form.tasks}
              onChange={(event) => change('tasks', event.target.value)}
              placeholder={'每行一项任务，也可用 ;; 分隔\n每项必须自包含，最多 8000 字符'}
              rows={8}
            />
          </div>
          <fieldset className="dispatch-modal__fieldset">
            <legend className="form-label">目标机器（可选；不选则由调度器选择）</legend>
            {remoteHosts.length === 0 ? (
              <div className="dispatch-modal__quiet">没有已启用的远端机器。</div>
            ) : (
              <div className="dispatch-modal__host-grid">
                {remoteHosts.map((host) => {
                  const power = powerByHost.get(host.name);
                  return (
                    <label key={host.name} className="dispatch-modal__host-option">
                      <input
                        type="checkbox"
                        checked={form.hosts.includes(host.name)}
                        onChange={() => toggleHost(host.name)}
                      />
                      <span>
                        <strong>{host.name}</strong>
                        {host.model && <small>{host.model}</small>}
                        <HostPowerBadge
                          state={fleetHostVisualState(host.ok, power)}
                          etaMs={power?.etaMs}
                          error={host.error ?? power?.wakeError ?? undefined}
                        />
                      </span>
                    </label>
                  );
                })}
              </div>
            )}
          </fieldset>
          <div className="dispatch-modal__two-columns">
            <div className="form-group">
              <label className="form-label" htmlFor="fleet-dispatch-tag">标签（与机器选择取交集）</label>
              <select
                id="fleet-dispatch-tag"
                className="form-input"
                value={form.tag}
                onChange={(event) => change('tag', event.target.value)}
              >
                <option value="">不限标签</option>
                {tags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="fleet-dispatch-timeout">单项超时（分钟，可选）</label>
              <input
                id="fleet-dispatch-timeout"
                className="form-input u-num"
                type="number"
                min={1}
                max={60}
                step={1}
                value={form.timeoutMinutes}
                onChange={(event) => change('timeoutMinutes', event.target.value)}
                placeholder="使用后端默认值"
              />
            </div>
          </div>
          <p className="dispatch-modal__quiet" data-shadow-intro>{shadowIntroCopy(remoteHosts.length)}</p>
          <label className="dispatch-modal__wake">
            <input
              type="checkbox"
              checked={form.wake}
              onChange={(event) => change('wake', event.target.checked)}
            />
            <span>
              <strong>自动唤醒不可达机器</strong>
              <small>关闭后，固定到不可达机器的派发会被拒绝。</small>
            </span>
          </label>
        </>
      ) : (
        <div className="dispatch-modal__confirmation">
          <div className="dispatch-modal__confirmation-mark" aria-hidden="true">!</div>
          <div>
            <h3>这会发起真实模型调用</h3>
            <p>
              将在 <strong>{targetText}</strong> 上发起{' '}
              <strong className="u-num">{pending.items.length}</strong> 次完整 agent 循环 · 会消耗模型额度。
            </p>
            <p className="dispatch-modal__quiet">{shadowCostCopy(shadow)}</p>
            <p className="dispatch-modal__quiet" data-shadow-status={shadow.status} aria-live="polite">
              {shadow.status === 'calling' && '选择器影子调用中…'}
              {shadow.status === 'failed' && `选择器影子调用失败：${shadow.error}`}
              {shadowCopy !== undefined && shadowCopy.head}
              {shadowRelation !== undefined && ` · ${shadowRelation}`}
            </p>
          </div>
        </div>
      )}
      {error && <div className="dispatch-modal__error" role="alert">{error}</div>}
    </Modal>
  );
};
