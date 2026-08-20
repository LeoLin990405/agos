import React from 'react';
import { Dot } from '@/components/ui/Dot';

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'canceled';
}

export interface TodoBarProps {
  todos: TodoItem[];
}

export const TodoBar: React.FC<TodoBarProps> = ({ todos }) => {
  if (!todos || todos.length === 0) return null;

  return (
    <div className="todo-kanban-bar">
      <span className="u-microlabel" style={{ flexShrink: 0 }}>待办看板 ({todos.length}):</span>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', overflowX: 'auto', flex: 1 }}>
        {todos.map((todo, idx) => (
          <div
            key={idx}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              backgroundColor: 'var(--bg-layer-1)',
              padding: '3px 8px',
              borderRadius: '4px',
              border: '1px solid var(--border-dim)',
              whiteSpace: 'nowrap',
              fontSize: '11px',
            }}
          >
            <Dot
              state={
                todo.status === 'completed'
                  ? 'done'
                  : todo.status === 'in_progress'
                  ? 'running'
                  : todo.status === 'canceled'
                  ? 'failed'
                  : 'queued'
              }
              size={6}
            />
            <span style={{ color: todo.status === 'completed' ? 'var(--text-tertiary)' : 'var(--text-primary)' }}>
              {todo.content}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};
