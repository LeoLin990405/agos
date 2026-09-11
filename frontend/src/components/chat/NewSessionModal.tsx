import React, { useEffect, useRef, useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { createSession, ensureLiveConnection, fetchPresets, getHostHome, renameSession, type PresetInfo } from '@/stores/live';
import { createNamedSession } from '@/components/chat/session-create';

export interface NewSessionModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** 创建成功后回调(带真实 sessionId 与已写入的主题)。 */
  onCreated?: (sessionId: string, title?: string) => void;
  /**
   * 打开时预选的 agentPreset id(空态胶囊排点击带入)。
   * 给定时优先于 agentPreset.list 的 isDefault;不给则维持原有默认行为。
   */
  initialPresetId?: string;
}

export const NewSessionModal: React.FC<NewSessionModalProps> = ({
  isOpen,
  onClose,
  onCreated,
  initialPresetId,
}) => {
  const [title, setTitle] = useState('');
  // 不写死任何用户路径:打开时向宿主要 home;要不到就留空,由用户手输(缺席≠默认值)。
  const [cwd, setCwd] = useState('');
  const [preset, setPreset] = useState('cordis');
  const [presets, setPresets] = useState<{ id: string, name: string, desc: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const titleRef = useRef<HTMLInputElement>(null);
  const cwdRef = useRef<HTMLInputElement>(null);

  // DeepSeek 原生四模式(agentPreset.list 真值:标准/PTC/极简/创造)
  useEffect(() => {
    if (!isOpen) return;
    const pinned = initialPresetId !== undefined && initialPresetId !== '' ? initialPresetId : undefined;
    if (pinned !== undefined) setPreset(pinned); // 预选立即生效,不等 list 回来
    // 0.1.2: host home comes from the $events ready frame, not a host.describe unary.
    ensureLiveConnection();
    const home = getHostHome();
    if (typeof home === 'string' && home !== '') {
      setCwd((prev) => (prev === '' ? home : prev)); // 只填空值,不覆盖用户已输入的
    }
    void fetchPresets().then((list: PresetInfo[]) => {
      if (list.length > 0) {
        setPresets(list.map((p) => ({ id: p.id, name: p.name, desc: p.description })));
        if (pinned !== undefined) return; // 外部预选优先于 isDefault
        const def = list.find((p) => p.isDefault);
        if (def !== undefined) setPreset(def.id);
      }
    });
  }, [isOpen, initialPresetId]);

  const handlePickDirectory = () => { /* host.pickDirectory 需宿主窗口,浅色占位:手输 cwd */ };

  const handleCreate = () => {
    if (busy) return;
    setBusy(true); setError(undefined);
    const submittedTitle = titleRef.current?.value ?? title;
    const submittedCwd = cwdRef.current?.value ?? cwd;
    void createNamedSession(
      { cwd: submittedCwd, title: submittedTitle, agentPreset: preset },
      { createSession, renameSession },
    ).then((result) => {
      setBusy(false);
      if (result.ok) { onCreated?.(result.sessionId, result.title); onClose(); }
      else setError(result.error);
    });
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="新建 Agent OS 会话"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            取消
          </Button>
          {error !== undefined && <span style={{ fontSize: '11px', color: 'var(--state-failed)', marginRight: '8px' }}>{error}</span>}
          <Button variant="primary" size="sm" onClick={handleCreate} disabled={busy}>
            {busy ? '创建中…' : '创建并进入会话 →'}
          </Button>
        </>
      }
    >
      <div className="form-group">
        <label className="form-label">会话主题 / 任务目标</label>
        <input
          type="text"
          className="form-input"
          ref={titleRef}
          aria-label="会话主题"
          placeholder="例如: 重构分布式令牌轮转与流式事件管道..."
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>

      <div className="form-group">
        <label className="form-label">工作区工作目录 (CWD)</label>
        <div style={{ display: 'flex', gap: '8px' }}>
          <input
            type="text"
            className="form-input"
            style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: '11.5px' }}
            ref={cwdRef}
            aria-label="工作目录"
            value={cwd}
            placeholder="宿主机上的绝对路径(打开时自动填宿主 home)"
            onChange={(e) => setCwd(e.target.value)}
          />
          <Button variant="secondary" size="sm" onClick={handlePickDirectory}>
            📂 浏览...
          </Button>
        </div>
      </div>

      <div className="form-group">
        <label className="form-label">智能体工作预设 (Agent Preset)</label>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {presets.map((p) => (
            <div
              key={p.id}
              onClick={() => setPreset(p.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '10px 14px',
                borderRadius: '6px',
                backgroundColor: preset === p.id ? 'var(--state-running-bg)' : 'var(--bg-layer-2)',
                border: preset === p.id ? '1px solid var(--state-running-border)' : '1px solid var(--border-dim)',
                cursor: 'pointer',
              }}
            >
              <div>
                <div style={{ fontWeight: 600, fontSize: '12.5px', color: preset === p.id ? 'var(--state-running)' : 'var(--text-primary)' }}>
                  {p.name}
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginTop: '2px' }}>
                  {p.desc}
                </div>
              </div>
              {preset === p.id && <Chip active>已选</Chip>}
            </div>
          ))}
        </div>
      </div>

    </Modal>
  );
};
