import React, { useState } from 'react';
import { Chip } from '@/components/ui/Chip';
import { fileToolPathTail } from './tool-cards';
import './FileToolCard.css';

export interface FileToolCardProps {
  name: string;
  path?: string;
  status: 'running' | 'done' | 'failed';
  duration?: string;
  resultText?: string;
}

const STATUS_COPY: Record<FileToolCardProps['status'], string> = {
  running: '处理中',
  done: '已完成',
  failed: '未成功',
};

export const FileToolCard: React.FC<FileToolCardProps> = ({
  name,
  path,
  status,
  duration,
  resultText,
}) => {
  const [open, setOpen] = useState(false);
  const tail = fileToolPathTail(path);
  const preview = (resultText ?? '').slice(0, 4000);
  const canExpand = preview !== '';

  return (
    <article className={`file-tool-card is-${status}`} aria-label={`${name}${path !== undefined ? ` ${path}` : ''}（${STATUS_COPY[status]}）`}>
      <header className="file-tool-card__head">
        <span className="file-tool-card__name">{name}</span>
        {tail !== undefined ? (
          <strong className="file-tool-card__file" title={path}>{tail}</strong>
        ) : (
          <span className="file-tool-card__missing">路径未采集</span>
        )}
        <Chip>{STATUS_COPY[status]}</Chip>
        {duration !== undefined && duration !== '' && <span className="u-num file-tool-card__dur">{duration}</span>}
      </header>
      {path !== undefined && tail !== path && (
        <p className="file-tool-card__path">{path}</p>
      )}
      {canExpand && (
        <button
          type="button"
          className="file-tool-card__toggle"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? '收起返回' : '查看返回'}
        </button>
      )}
      {open && preview !== '' && <pre className="file-tool-card__body">{preview}</pre>}
    </article>
  );
};
