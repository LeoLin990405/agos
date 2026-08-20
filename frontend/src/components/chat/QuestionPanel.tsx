import React, { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Badge';
import { Dot } from '@/components/ui/Dot';

export interface QuestionPanelProps {
  questionId: string;
  prompt: string;
  options: string[];
  isMultiSelect?: boolean;
  onAnswer?: (selected: string[]) => void;
}

export const QuestionPanel: React.FC<QuestionPanelProps> = ({
  questionId,
  prompt,
  options,
  isMultiSelect = false,
  onAnswer,
}) => {
  const [selected, setSelected] = useState<string[]>([]);
  const [customText, setCustomText] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const toggleOption = (opt: string) => {
    if (isMultiSelect) {
      if (selected.includes(opt)) {
        setSelected(selected.filter((s) => s !== opt));
      } else {
        setSelected([...selected, opt]);
      }
    } else {
      setSelected([opt]);
    }
  };

  const handleSubmit = () => {
    const finalAnswer = [...selected];
    if (customText.trim()) finalAnswer.push(customText.trim());
    setSubmitted(true);
    onAnswer?.(finalAnswer);
  };

  if (submitted) {
    return (
      <div className="question-panel" style={{ borderColor: 'var(--state-done)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', color: 'var(--state-done)', fontWeight: 600 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Dot state="done" />
            <span>已提交答复: {selected.join(', ') || customText}</span>
          </div>
          <span className="u-num" style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>刚刚</span>
        </div>
      </div>
    );
  }

  return (
    <div className="question-panel">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--accent-cyan)', fontWeight: 700, fontSize: '13.5px' }}>
          <span>❓ 需要人工确认 (Input Required)</span>
        </div>
        <Badge style={{ backgroundColor: 'rgba(6, 182, 212, 0.15)', color: 'var(--accent-cyan)', borderColor: 'rgba(6, 182, 212, 0.35)' }}>
          {isMultiSelect ? '多选决策' : '单选决策'}
        </Badge>
      </div>

      <div style={{ fontSize: '13px', color: 'var(--text-primary)', lineHeight: 1.5 }}>
        {prompt}
      </div>

      <div className="question-options-list">
        {options.map((opt, idx) => {
          const isSel = selected.includes(opt);
          return (
            <div
              key={idx}
              className={`question-option-item ${isSel ? 'is-selected' : ''}`}
              onClick={() => toggleOption(opt)}
            >
              <span style={{ color: isSel ? 'var(--accent-cyan)' : 'var(--text-tertiary)', fontSize: '13px' }}>
                {isMultiSelect ? (isSel ? '☑' : '☐') : (isSel ? '●' : '○')}
              </span>
              <span style={{ fontSize: '12.5px', color: isSel ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                {opt}
              </span>
            </div>
          );
        })}
      </div>

      <div style={{ display: 'flex', gap: '10px', marginTop: '10px' }}>
        <input
          type="text"
          placeholder="补充自定义补充说明 (可选)..."
          className="form-input"
          style={{ flex: 1 }}
          value={customText}
          onChange={(e) => setCustomText(e.target.value)}
        />
        <Button
          variant="primary"
          size="sm"
          disabled={selected.length === 0 && !customText.trim()}
          onClick={handleSubmit}
        >
          提交决策
        </Button>
      </div>
    </div>
  );
};
