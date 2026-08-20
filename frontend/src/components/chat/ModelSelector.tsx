import React, { useEffect, useState } from 'react';
import { Chip } from '@/components/ui/Chip';
import { fetchSessionModels, selectSessionModel, type SessionModels } from '@/stores/live';

/** 模型选择器(V5 真值):session.models 全量分组 + session.selectModel 切换。 */
export interface ModelSelectorProps {
  sessionId: string | undefined;
}

export const ModelSelector: React.FC<ModelSelectorProps> = ({ sessionId }) => {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<SessionModels>({ current: undefined, groups: [] });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (sessionId === undefined) { setData({ current: undefined, groups: [] }); return; }
    let alive = true;
    void fetchSessionModels(sessionId).then((d) => { if (alive) setData(d); });
    return () => { alive = false; };
  }, [sessionId, open]);

  // P0-5:主名 + 档位副词。档位=该模型在 session.models 里所属的分组名(provider),
  // 分组未加载到就不渲染副词(数据零编造)。
  const current = data.current;
  const currentGroup = current === undefined
    ? undefined
    : data.groups.find((g) => g.provider === current.provider && g.models.some((m) => m.id === current.model));
  const currentEntry = current === undefined
    ? undefined
    : currentGroup?.models.find((m) => m.id === current.model);
  const currentLabel = current === undefined ? '选择模型' : (currentEntry?.name ?? current.model);
  const currentTier = currentGroup?.provider ?? '';
  const total = data.groups.reduce((n, g) => n + g.models.length, 0);

  const pick = async (provider: string, model: string): Promise<void> => {
    if (sessionId === undefined || busy) return;
    setBusy(true);
    const ok = await selectSessionModel(sessionId, provider, model);
    if (ok) setData((d) => ({ ...d, current: { provider, model } }));
    setBusy(false);
    setOpen(false);
  };

  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        style={{ padding: '0 8px', gap: '6px' }}
        onClick={() => setOpen(!open)}
        title={sessionId === undefined
          ? '先选择会话'
          : currentTier !== '' ? `${currentLabel} · ${currentTier} 档 · ${total} 个可路由` : `主力模型 · ${total} 个可路由`}
        disabled={sessionId === undefined}
      >
        <Chip variant="purple">{currentLabel}</Chip>
        {currentTier !== '' && (
          <span style={{ fontSize: '12px', color: 'var(--text-tertiary)', whiteSpace: 'nowrap' }}>{currentTier}</span>
        )}
        <span style={{ fontSize: '10px', color: 'var(--text-tertiary)' }}>▾</span>
      </button>

      {open && (
        <div
          style={{
            position: 'absolute', bottom: '100%', left: 0, marginBottom: '8px',
            width: '300px', maxHeight: '380px', overflowY: 'auto',
            backgroundColor: 'var(--bg-layer-1)',
            border: '1px solid var(--border-subtle)',
            borderRadius: '12px', padding: '6px',
            boxShadow: 'var(--shadow-panel)', zIndex: 50,
            display: 'flex', flexDirection: 'column', gap: '2px',
          }}
        >
          {data.groups.length === 0 && (
            <div style={{ padding: '14px', fontSize: '12px', color: 'var(--text-tertiary)', textAlign: 'center' }}>
              正在加载模型清单…
            </div>
          )}
          {data.groups.map((g) => (
            <div key={g.provider}>
              <div style={{ padding: '8px 10px 4px', fontSize: '10.5px', letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--text-dimmed)' }}>
                {g.provider} · {g.models.length}
              </div>
              {g.models.map((m) => {
                const isCurrent = data.current?.provider === g.provider && data.current?.model === m.id;
                return (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => { void pick(g.provider, m.id); }}
                    style={{
                      display: 'flex', alignItems: 'center', gap: '8px', width: '100%',
                      padding: '7px 10px', border: 'none', borderRadius: '8px',
                      background: isCurrent ? 'var(--state-running-bg)' : 'transparent',
                      color: isCurrent ? 'var(--state-running)' : 'var(--text-secondary)',
                      fontSize: '12.5px', textAlign: 'left', cursor: 'pointer',
                      fontFamily: 'var(--font-mono)',
                    }}
                    onMouseEnter={(e) => { if (!isCurrent) e.currentTarget.style.background = 'var(--interactive-hover, rgba(127,127,127,0.08))'; }}
                    onMouseLeave={(e) => { if (!isCurrent) e.currentTarget.style.background = 'transparent'; }}
                  >
                    <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{m.name}</span>
                    {isCurrent && <span style={{ fontSize: '10px' }}>当前</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
