/**
 * 读图 / 评审台账。分歧只渲染仲裁自己给的 disagreements 数组。
 * 老记录缺字段时写「未采集」,绝不回退逐行 diff。
 */
import React, { useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Chip';
import { Dot } from '@/components/ui/Dot';
import { mediaRouteUrl } from '@/components/chat/media-blocks';
import { fetchJsonResource, useResource } from '@/lib/useResource';
import {
  collectedDisagreements,
  kindChip,
  panelOkCount,
  parseVisionLedger,
  type CouncilRecord,
} from './council-ledger-model';

export const LEDGER_READY_COPY = '读图台账已采集';

const quietText: React.CSSProperties = {
  color: 'var(--text-tertiary)',
  fontSize: '12px',
  lineHeight: 1.6,
};

const panelStyle: React.CSSProperties = {
  borderTop: '1px solid var(--border-subtle)',
  padding: '14px 0',
};

function formatWhen(iso: string | undefined): string {
  if (iso === undefined) return '时间未采集';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false });
}

function DisagreementsBlock({ record }: { record: CouncilRecord }) {
  const collected = collectedDisagreements(record);
  if (collected.status === 'absent') {
    return (
      <div>
        <div className="u-microlabel" style={{ marginBottom: '4px' }}>分歧</div>
        <p style={{ ...quietText, margin: 0 }}>未采集(本条记录早于该字段)</p>
        {record.verdict !== undefined && (
          <div style={{ color: 'var(--text-secondary)', fontSize: '12px', lineHeight: 1.6, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', marginTop: '8px' }}>
            {record.verdict}
          </div>
        )}
      </div>
    );
  }
  return (
    <div>
      {record.verdict !== undefined && (
        <div>
          <div className="u-microlabel" style={{ marginBottom: '4px' }}>仲裁结论</div>
          <div style={{ color: 'var(--text-secondary)', fontSize: '12px', lineHeight: 1.6, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {record.verdict}
          </div>
        </div>
      )}
      {collected.status === 'present' && (
        <div style={{ marginTop: record.verdict !== undefined ? '8px' : 0 }}>
          <div className="u-microlabel" style={{ color: 'var(--accent-amber)', marginBottom: '4px' }}>仍有分歧</div>
          {collected.items.map((item, index) => (
            <div key={index} style={{ color: 'var(--text-secondary)', fontSize: '11.5px', lineHeight: 1.5 }}>
              {index + 1}. {item}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LedgerRow({ record }: { record: CouncilRecord }) {
  const [open, setOpen] = useState(false);
  const { ok, total } = panelOkCount(record);
  return (
    <section style={panelStyle} aria-label={record.question ?? '台账记录'}>
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
        <Dot state={ok === total && total > 0 ? 'done' : ok === 0 ? 'failed' : 'running'} size={6} />
        <span className="u-num" style={{ ...quietText, color: 'var(--text-secondary)' }}>{formatWhen(record.time)}</span>
        <Chip>{kindChip(record.kind)}</Chip>
        <strong style={{ color: 'var(--text-primary)', fontSize: '12.5px', overflowWrap: 'anywhere' }}>
          {record.question ?? '(无题注)'}
        </strong>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
          <Badge state={ok === total && total > 0 ? 'done' : 'running'}>面板 {ok}/{total}</Badge>
          {record.arbiter !== undefined && <Chip>仲裁 {record.arbiter}</Chip>}
          {record.inconclusive === true && <Chip variant="amber">证据不足</Chip>}
          {record.parsedOk === false && <Chip variant="amber">非结构化返回</Chip>}
          {record.flagged.map((f) => <Chip key={f} variant="red">标记 {f}</Chip>)}
          <Button size="sm" variant="ghost" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? '收起' : '展开'}
          </Button>
        </span>
      </div>
      {open && (
        <div style={{ marginTop: '10px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <DisagreementsBlock record={record} />
          {record.imagePath !== undefined && (
            <img
              src={mediaRouteUrl(record.imagePath)}
              alt={record.question ?? '台账原图'}
              style={{ maxWidth: '100%', maxHeight: '280px', objectFit: 'contain', border: '1px solid var(--border-dim)', borderRadius: '6px' }}
            />
          )}
          {record.panelists.map((p, i) => (
            <div key={`${p.provider}:${i}`} style={{ border: '1px solid var(--border-dim)', borderRadius: '8px', padding: '8px 10px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '7px', marginBottom: p.text !== undefined ? '6px' : 0 }}>
                <Dot state={p.ok ? 'done' : 'failed'} size={6} />
                <Chip>{p.provider}</Chip>
                {p.model !== undefined && <span className="u-num" style={quietText}>{p.model}</span>}
                {p.ms !== undefined && <span className="u-num" style={quietText}>{p.ms} ms</span>}
                {p.error !== undefined && <span style={{ color: 'var(--state-failed)', fontSize: '11px' }}>{p.error}</span>}
              </div>
              {p.text !== undefined && (
                <div style={{ color: 'var(--text-secondary)', fontSize: '11.5px', lineHeight: 1.55, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                  {p.text}
                </div>
              )}
            </div>
          ))}
          {record.panelists.length === 0 && <p style={{ ...quietText, margin: 0 }}>这条记录没有面板明细。</p>}
        </div>
      )}
    </section>
  );
}

const fetchLedger = async (url: string, signal: AbortSignal): Promise<CouncilRecord[]> =>
  parseVisionLedger(await fetchJsonResource<unknown>(url, signal));

export const CouncilLedgerView: React.FC = () => {
  const resource = useResource<CouncilRecord[]>({ url: '/api/cn/council-records', fetcher: fetchLedger });
  const payload = resource.data;
  const isBusy = resource.status === 'idle' || resource.status === 'loading';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
      <header style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '16px', flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ fontSize: '16px', fontWeight: 800, margin: 0 }}>读图台账</h2>
          <p style={{ ...quietText, margin: '4px 0 0' }}>
            只读数据源 <code>/api/cn/council-records</code> · 最近 30 条全类型记录,倒序
          </p>
        </div>
        <Button size="sm" disabled={isBusy} onClick={() => resource.refresh()}>
          {isBusy ? '读取中…' : '刷新'}
        </Button>
      </header>

      {isBusy && payload === undefined && (
        <p aria-live="polite" style={quietText}>正在读取读图台账…</p>
      )}

      {resource.status === 'error' && resource.error && payload === undefined && (
        <div role="alert" style={{ ...panelStyle, color: 'var(--state-failed)', fontSize: '12px' }}>
          <p style={{ margin: '0 0 10px' }}>台账未响应:{resource.error.message}</p>
          <Button size="sm" onClick={() => resource.refresh()}>重试</Button>
        </div>
      )}

      {payload !== undefined && (
        <div>
          <h3 style={{ fontSize: '13px', fontWeight: 700, margin: '0 0 8px' }}>{LEDGER_READY_COPY}</h3>
          {payload.length === 0 ? (
            <p style={{ ...quietText, margin: 0 }}>最近 30 条窗口是空的。贴图交叉读图或跑评审后会出现记录。</p>
          ) : (
            payload.map((record, index) => <LedgerRow key={`${record.time ?? ''}:${index}`} record={record} />)
          )}
        </div>
      )}
    </div>
  );
};
