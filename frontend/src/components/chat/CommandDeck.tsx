import React, { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Dot } from '@/components/ui/Dot';
import { ModelSelector } from './ModelSelector';

export interface CommandDeckProps {
  onSend?: (text: string) => void;
  defaultModel?: string;
  onModelChange?: (model: string) => void;
}

export const CommandDeck: React.FC<CommandDeckProps> = ({
  onSend,
  defaultModel = 'DeepSeek-V3',
  onModelChange,
}) => {
  const [text, setText] = useState('');
  const [swarmMode, setSwarmMode] = useState(true);
  const [currentModel, setCurrentModel] = useState(defaultModel);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (text.trim()) {
        onSend?.(text);
        setText('');
      }
    }
  };

  const handleSend = () => {
    if (text.trim()) {
      onSend?.(text);
      setText('');
    }
  };

  const handleSelectModel = (m: string) => {
    setCurrentModel(m);
    onModelChange?.(m);
  };

  return (
    <footer className="chat-input-deck">
      <div className="input-box-container">
        <textarea
          className="chat-textarea"
          placeholder="输入需求、执行指令，或使用 / 唤起工具与技能..."
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
        />

        <div className="input-deck-footer">
          <div className="input-deck-tools">
            <Button variant="ghost" size="sm" title="添加附件或代码上下文">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
              </svg>
              <span>附加文件</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setSwarmMode(!swarmMode)}
              title="切换 Swarm 多智能体并发模式"
            >
              <Dot state={swarmMode ? 'running' : 'queued'} size={6} />
              <span>Swarm 并发 ({swarmMode ? '开' : '关'})</span>
            </Button>
            <ModelSelector currentModel={currentModel} onSelectModel={handleSelectModel} />
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span className="kbd">⌘ + ↵</span>
            <Button variant="primary" size="sm" style={{ padding: '0 16px' }} onClick={handleSend}>
              <span>发送</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </Button>
          </div>
        </div>
      </div>
    </footer>
  );
};
