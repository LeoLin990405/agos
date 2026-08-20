import React, { useState } from 'react';
import { Chip } from '@/components/ui/Chip';

export interface ModelSelectorProps {
  currentModel: string;
  onSelectModel: (model: string) => void;
}

export const ModelSelector: React.FC<ModelSelectorProps> = ({
  currentModel,
  onSelectModel,
}) => {
  const [open, setOpen] = useState(false);

  const models = [
    { id: 'DeepSeek-V3', provider: 'DeepSeek', desc: '671B MoE · 极速高精推理', context: '128k' },
    { id: 'Claude-3.5-Sonnet', provider: 'Anthropic', desc: '顶级代码重构与指令遵循', context: '200k' },
    { id: 'Kimi-K1.5', provider: 'Moonshot', desc: '超长上下文与中文推理', context: '256k' },
    { id: 'Qwen-2.5-Coder', provider: 'Alibaba', desc: '本地离线私密沙箱专用', context: '128k' },
  ];

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        style={{ padding: '0 8px', gap: '6px' }}
        onClick={() => setOpen(!open)}
        title="选择主力推理模型"
      >
        <Chip variant="purple">{currentModel}</Chip>
        <span style={{ fontSize: '10px', color: 'var(--text-tertiary)' }}>▾</span>
      </button>

      {open && (
        <div
          style={{
            position: 'absolute',
            bottom: '100%',
            left: 0,
            marginBottom: '8px',
            width: '260px',
            backgroundColor: 'var(--bg-layer-1)',
            border: '1px solid var(--border-bold)',
            borderRadius: '8px',
            padding: '6px',
            boxShadow: 'var(--shadow-panel)',
            zIndex: 50,
            display: 'flex',
            flexDirection: 'column',
            gap: '4px',
          }}
        >
          <div style={{ padding: '4px 8px', fontSize: '10px', color: 'var(--text-tertiary)', fontWeight: 700 }}>
            切换活跃会话模型 (LLM SELECT)
          </div>
          {models.map((m) => (
            <div
              key={m.id}
              onClick={() => {
                onSelectModel(m.id);
                setOpen(false);
              }}
              style={{
                padding: '8px 10px',
                borderRadius: '6px',
                backgroundColor: currentModel === m.id ? 'var(--state-running-bg)' : 'transparent',
                border: currentModel === m.id ? '1px solid var(--state-running-border)' : '1px solid transparent',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
              }}
            >
              <div>
                <div style={{ fontWeight: 600, fontSize: '12px', color: currentModel === m.id ? 'var(--state-running)' : 'var(--text-primary)' }}>
                  {m.id}
                </div>
                <div style={{ fontSize: '10.5px', color: 'var(--text-tertiary)' }}>{m.desc}</div>
              </div>
              <span className="u-num" style={{ fontSize: '10px', color: 'var(--text-dimmed)' }}>{m.context}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
