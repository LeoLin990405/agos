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
  inconclusiveBanner,
  INCONCLUSIVE_COPY,
  kindChip,
  panelOkCount,
  parseVisionLedger,
  type CouncilRecord,
} from './council-ledger-model';

export const LEDGER_READY_COPY = '读图台账已采集';

function formatWhen(iso: string | undefined): string {
  if (iso === undefined) return '时间未采集';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('zh-CN', { hour12: false });
}

function DisagreementsBlock({ record }: { record: CouncilRecord }) {
  const banner = inconclusiveBanner(record);
  if (banner !== undefined) {
    return (
      <div>
        <p className="surface-status--amber">{banner}</p>
        {record.verdict !== undefined && (
          <div className="surface-pre">
            {record.verdict}
          </div>
        )}
      </div>
    );
  }
  const collected = collectedDisagreements(record);
  if (collected.status === 'absent') {
    return (
      <div>
        <div className="u-microlabel">分歧</div>
        <p className="surface-quiet">未采集(本条记录早于该字段)</p>
        {record.verdict !== undefined && (
          <div className="surface-pre">
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
          <div className="u-microlabel">仲裁结论</div>
          <div className="surface-pre">
            {record.verdict}
          </div>
        </div>
      )}
      {collected.status === 'present' && (
        <div>
          <div className="u-microlabel surface-status--amber">仍有分歧</div>
          {collected.items.map((item, index) => (
            <div key={index} className="surface-body">
              {index + 1}. {item}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function LedgerRow({ record, index }: { record: CouncilRecord; index: number }) {
  const [open, setOpen] = useState(false);
  const { ok, total } = panelOkCount(record);
  return (
    <section
      className="surface-section viz-enter"
      style={{ ['--i' as string]: index }}
      aria-label={record.question ?? '台账记录'}
    >
      <div className="surface-cluster">
        <Dot state={ok === total && total > 0 ? 'done' : ok === 0 ? 'failed' : 'running'} size={6} />
        {total > 0 && (
          <span className="viz-track skills-budget-track" aria-hidden="true">
            <span
              className={`viz-fill${ok === total ? ' is-done' : ok === 0 ? ' is-failed' : ''}`}
              style={{ ['--u-p' as string]: ok / total }}
            />
          </span>
        )}
        <span className="u-num surface-body">{formatWhen(record.time)}</span>
        <Chip>{kindChip(record.kind)}</Chip>
        <strong className="surface-strong">
          {record.question ?? '(无题注)'}
        </strong>
        <span className="surface-toolbar">
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
      {record.inconclusive === true && (
        <p className="surface-quiet surface-status--amber">{INCONCLUSIVE_COPY}</p>
      )}
      {open && (
        <div className="surface-stack">
          <DisagreementsBlock record={record} />
          {record.imagePath !== undefined && (
            <img
              src={mediaRouteUrl(record.imagePath)}
              alt={record.question ?? '台账原图'}
              className="surface-image"
            />
          )}
          {record.panelists.map((p, i) => (
            <div key={`${p.provider}:${i}`} className="surface-panel">
              <div className="surface-panel-head">
                <Dot state={p.ok ? 'done' : 'failed'} size={6} />
                <Chip>{p.provider}</Chip>
                {p.model !== undefined && <span className="u-num surface-quiet">{p.model}</span>}
                {p.ms !== undefined && <span className="u-num surface-quiet">{p.ms} ms</span>}
                {p.error !== undefined && <span className="surface-alert">{p.error}</span>}
              </div>
              {p.text !== undefined && (
                <div className="surface-pre">
                  {p.text}
                </div>
              )}
            </div>
          ))}
          {record.panelists.length === 0 && <p className="surface-quiet">这条记录没有面板明细。</p>}
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
    <div className="surface-page">
      <header className="surface-header">
        <div>
          <h2 className="surface-title">读图台账</h2>
          <p className="surface-lede">
            只读数据源 <code>/api/cn/council-records</code> · 最近 30 条全类型记录,倒序
          </p>
        </div>
        <Button size="sm" disabled={isBusy} onClick={() => resource.refresh()}>
          {isBusy ? '读取中…' : '刷新'}
        </Button>
      </header>

      {isBusy && payload === undefined && (
        <p aria-live="polite" className="surface-quiet">正在读取读图台账…</p>
      )}

      {resource.status === 'error' && resource.error && payload === undefined && (
        <div role="alert" className="surface-section surface-alert">
          <p>台账未响应:{resource.error.message}</p>
          <Button size="sm" onClick={() => resource.refresh()}>重试</Button>
        </div>
      )}

      {payload !== undefined && (
        <div>
          <h3 className="success-anchor">{LEDGER_READY_COPY}</h3>
          {payload.length === 0 ? (
            <p className="surface-quiet">最近 30 条窗口是空的。贴图交叉读图或跑评审后会出现记录。</p>
          ) : (
            payload.map((record, index) => <LedgerRow key={`${record.time ?? ''}:${index}`} record={record} index={index} />)
          )}
        </div>
      )}
    </div>
  );
};
