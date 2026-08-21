import React, { useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import type { FleetDispatchResult, FleetHost } from '@/stores/live';
import {
  describeDispatchTargets,
  parseDispatchItems,
  validateDispatchForm,
  type DispatchFormValue,
  type FleetDispatchRequest,
} from './dispatch-form';
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

  useEffect(() => {
    if (!open) return;
    setPending(undefined);
    setError(undefined);
    setSubmitting(false);
  }, [open]);

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
  const review = () => {
    const result = validateDispatchForm(form);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(undefined);
    setPending(result.request);
  };
  const confirm = async () => {
    if (pending === undefined || submitting) return;
    setSubmitting(true);
    setError(undefined);
    try {
      const result = await onDispatch(pending);
      setForm(EMPTY_FORM);
      setPending(undefined);
      onDispatched?.(result.batchId);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setSubmitting(false);
    }
  };

  const targetText = describeDispatchTargets(pending?.hosts ?? [], remoteHosts, pending?.tag ?? '');
  const footer = pending === undefined ? (
    <>
      <Button variant="ghost" onClick={close}>取消</Button>
      <Button variant="primary" onClick={review}>检查派发</Button>
    </>
  ) : (
    <>
      <Button variant="ghost" disabled={submitting} onClick={() => setPending(undefined)}>返回修改</Button>
      <Button data-dispatch-confirm variant="primary" disabled={submitting} onClick={() => void confirm()}>
        {submitting ? '正在派发…' : '确认并派发'}
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
                {remoteHosts.map((host) => (
                  <label key={host.name} className="dispatch-modal__host-option">
                    <input
                      type="checkbox"
                      checked={form.hosts.includes(host.name)}
                      onChange={() => toggleHost(host.name)}
                    />
                    <span>
                      <strong>{host.name}</strong>
                      {host.model && <small>{host.model}</small>}
                    </span>
                  </label>
                ))}
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
            <p className="dispatch-modal__quiet">确认前尚未调用派发接口，也不会唤醒机器。</p>
          </div>
        </div>
      )}
      {error && <div className="dispatch-modal__error" role="alert">{error}</div>}
    </Modal>
  );
};
