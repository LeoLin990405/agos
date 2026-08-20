import React, { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';

export interface NewSessionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreateSession: (params: { title: string; cwd: string; preset: string; model: string }) => void;
}

export const NewSessionModal: React.FC<NewSessionModalProps> = ({
  isOpen,
  onClose,
  onCreateSession,
}) => {
  const [title, setTitle] = useState('');
  const [cwd, setCwd] = useState('/Users/leo/Documents/kimi/workspace/agos-frontend');
  const [preset, setPreset] = useState('full-stack-architect');
  const [model, setModel] = useState('DeepSeek-V3');

  const presets = [
    { id: 'full-stack-architect', name: '全栈架构师 (Full-Stack)', desc: '具备前后端全景架构与深度重构权限' },
    { id: 'security-auditor', name: '安全攻防审计员 (Security Auditor)', desc: '严格隔离，专注于漏洞与竞争条件探针' },
    { id: 'ui-design-engineer', name: 'UI 设计工程师 (Design Engineer)', desc: '精通 CSS Token、Geist 排印与共息动效' },
    { id: 'db-migration-specialist', name: '数据库与契约专家 (Data Connect)', desc: '模式校验与严格向后兼容迁移' },
  ];

  const handlePickDirectory = () => {
    // 模拟 host.pickDirectory RPC 调用
    setCwd('/Users/leo/Documents/kimi/workspace/agos-frontend');
  };

  const handleCreate = () => {
    onCreateSession({
      title: title.trim() || '未命名会话',
      cwd,
      preset,
      model,
    });
    onClose();
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={<span>⚡ 新建 Agent OS 会话</span>}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            取消
          </Button>
          <Button variant="primary" size="sm" onClick={handleCreate}>
            创建并进入会话 →
          </Button>
        </>
      }
    >
      <div className="form-group">
        <label className="form-label">会话主题 / 任务目标</label>
        <input
          type="text"
          className="form-input"
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
            value={cwd}
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

      <div className="form-group">
        <label className="form-label">主力大语言模型</label>
        <div style={{ display: 'flex', gap: '8px' }}>
          {['DeepSeek-V3', 'Claude-3.5-Sonnet', 'Kimi-K1.5', 'Qwen-2.5-72B'].map((m) => (
            <Button
              key={m}
              variant={model === m ? 'primary' : 'ghost'}
              size="sm"
              onClick={() => setModel(m)}
            >
              {m}
            </Button>
          ))}
        </div>
      </div>
    </Modal>
  );
};
