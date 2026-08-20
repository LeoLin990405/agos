import React, { useLayoutEffect, useRef, useState } from 'react';
import { Dot } from '@/components/ui/Dot';
import '@/design-system/reasoning-block.css';

export interface ReasoningBlockProps {
  /** 耗时文案,空串则不显示。不再有编造的默认值。 */
  duration?: string;
  /** token / 字数文案,空串则不显示。不再有编造的默认值。 */
  tokens?: string;
  title?: string;
  children: React.ReactNode;
  /** 是否仍在思考中:运行态默认展开 + --state-running 着色 + 呼吸点。 */
  thinking?: boolean;
  /** 不传时:思考中默认展开,已完成默认收起(P2:消掉「每条思考都摊开」的噪音)。 */
  defaultExpanded?: boolean;
}

const DoneIcon = (
  <svg
    viewBox="0 0 16 16"
    width="16"
    height="16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M3.2 8.4 6.3 11.5 12.8 4.8" />
  </svg>
);

const ChevronIcon = (
  <svg
    viewBox="0 0 14 14"
    width="14"
    height="14"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M5.2 3 9.4 7 5.2 11" />
  </svg>
);

export const ReasoningBlock: React.FC<ReasoningBlockProps> = ({
  duration = '',
  tokens = '',
  title = '思考过程',
  children,
  thinking = false,
  defaultExpanded,
}) => {
  const initialOpen = defaultExpanded ?? thinking;
  const [expanded, setExpanded] = useState(initialOpen);
  const [mounted, setMounted] = useState(initialOpen);
  const [bodyHeight, setBodyHeight] = useState(0);
  const innerRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!expanded) return;
    const el = innerRef.current;
    if (el === null) return;
    setBodyHeight(el.scrollHeight);
  }, [expanded, children]);

  const toggle = (): void => {
    setMounted(true);
    setExpanded((v) => !v);
  };

  const headText = duration !== '' ? `${title}(耗时 ${duration})` : title;

  return (
    <div
      className={`rb-block${thinking ? ' is-thinking' : ''}${expanded ? ' is-open' : ''}`}
    >
      <div
        className="cot-header rb-header"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={`${headText}(${expanded ? '收起' : '展开'})`}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
          }
        }}
      >
        <span className="rb-lead" aria-hidden="true">
          <span className="rb-lead-thinking"><Dot state="running" /></span>
          <span className="rb-lead-done">{DoneIcon}</span>
        </span>
        <div className="rb-head-main">
          <span className="rb-title">{headText}</span>
        </div>
        {tokens !== '' && <span className="u-num rb-tokens">{tokens}</span>}
        <span className="cot-toggle-icon rb-chevron">{ChevronIcon}</span>
      </div>
      <div className="rb-body" style={{ height: expanded ? `${bodyHeight}px` : 0 }}>
        {mounted && (
          <div className="rb-inner" ref={innerRef}>
            <div className="rb-content">{children}</div>
          </div>
        )}
      </div>
    </div>
  );
};
