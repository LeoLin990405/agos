import React, { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import {
  LEXICAL_EVAL_COPY,
  RERANK_UNAVAILABLE_COPY,
  runLexicalTriggerEvals,
  suggestDescription,
  type LexicalEvalReport,
} from './skills-ranking';
import {
  CALL_IS_NOT_VERDICT_COPY,
  parseEvolveReport,
  POSTERIOR_METHOD_COPY,
  RERANK_OPT_IN_COPY,
} from './skills-evolve';
import { getStudioSkill, postSkillDescription, postSkillDraft, postSkillOutcome, postSkillRerank } from './skills-studio-api';
import {
  CLAUDE_ROOT_DISPLAY,
  MODEL_ROOT_DISPLAY,
  catalogCollision,
  emptyStudioDraft,
  emptyTriggerEvals,
  evalsPath,
  modelRootPath,
  normalizeSkillName,
  pluginStubPath,
  renderSkillMarkdown,
  validateDraft,
  validateTriggerEvals,
  type SkillStudioDraft,
  type TriggerEvalCase,
} from './skills-studio-model';

export const SkillsStudio: React.FC<{
  catalogNames: readonly string[];
  initialName?: string;
  onCreated?: () => void;
}> = ({ catalogNames, initialName, onCreated }) => {
  const [draft, setDraft] = useState<SkillStudioDraft>(() => (
    initialName ? { ...emptyStudioDraft(), name: initialName } : emptyStudioDraft()
  ));
  const [evals, setEvals] = useState<TriggerEvalCase[]>(emptyTriggerEvals);
  const [confirmed, setConfirmed] = useState(false);
  const [confirmPatch, setConfirmPatch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [report, setReport] = useState<LexicalEvalReport | undefined>();
  const [suggestion, setSuggestion] = useState<string | undefined>();
  const [evolveLabel, setEvolveLabel] = useState('');
  const [confirmOutcome, setConfirmOutcome] = useState(false);
  const [confirmRerank, setConfirmRerank] = useState(false);
  const [evolveNote, setEvolveNote] = useState<string | undefined>();

  const name = normalizeSkillName(draft.name);
  const named = { ...draft, name };
  const draftErrors = validateDraft(named);
  const evalReport = validateTriggerEvals(evals);
  const collision = name !== '' && catalogCollision(name, catalogNames);
  const preview = draftErrors.length === 0 ? renderSkillMarkdown(named) : '';
  const blocked = useMemo(() => {
    const reasons = [...draftErrors, ...evalReport.errors];
    if (collision) reasons.push(`目录里已有 ${name}，拒绝覆盖。用「只改 description」或换名。`);
    return reasons;
  }, [collision, draftErrors, evalReport.errors, name]);

  const setField = <K extends keyof SkillStudioDraft>(key: K, value: SkillStudioDraft[K]): void => {
    setDraft((current) => ({ ...current, [key]: value }));
    setNotice(undefined);
    setError(undefined);
    setReport(undefined);
    setSuggestion(undefined);
  };

  useEffect(() => {
    const next = initialName?.trim() ?? '';
    if (next === '') return;
    setDraft((current) => (current.name === next ? current : { ...current, name: next }));
    void (async () => {
      setBusy(true);
      setError(undefined);
      try {
        const result = await getStudioSkill(next);
        if ('created' in result && result.created === false) {
          setError(result.error);
          return;
        }
        if (!('description' in result)) {
          setError('模型根没有这个技能。');
          return;
        }
        setDraft({
          name: result.name,
          description: result.description,
          whenToUse: result.whenToUse,
          body: result.body,
          needsPlugin: Boolean(result.pluginHint),
          pluginHint: result.pluginHint ?? '',
        });
        setEvals(result.evals.length >= 4 ? result.evals : [...result.evals, ...emptyTriggerEvals()].slice(0, Math.max(4, result.evals.length)));
        setNotice(`已读入 ${result.path}${result.pluginStub ? ` · stub ${result.pluginStub}` : ''}`);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : '读取失败');
      } finally {
        setBusy(false);
      }
    })();
  }, [initialName]);

  const load = async (): Promise<void> => {
    if (name === '') return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await getStudioSkill(name);
      if ('created' in result && result.created === false) {
        setError(result.error);
        return;
      }
      if (!('description' in result)) {
        setError('模型根没有这个技能。');
        return;
      }
      setDraft({
        name: result.name,
        description: result.description,
        whenToUse: result.whenToUse,
        body: result.body,
        needsPlugin: Boolean(result.pluginHint),
        pluginHint: result.pluginHint ?? '',
      });
      setEvals(result.evals.length >= 4 ? result.evals : [...result.evals, ...emptyTriggerEvals()].slice(0, Math.max(4, result.evals.length)));
      setNotice(`已读入 ${result.path}${result.pluginStub ? ` · stub ${result.pluginStub}` : ''}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '读取失败');
    } finally {
      setBusy(false);
    }
  };

  const write = async (): Promise<void> => {
    if (blocked.length > 0 || !confirmed) return;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await postSkillDraft(named, evals);
      if (!result.created) {
        setError(result.error);
        return;
      }
      const stub = result.pluginStub ? ` 插件 stub ${result.pluginStub}（未安装）。` : '';
      setNotice(`已写入 ${result.path}${result.evalsPath ? `，评测集 ${result.evalsPath}` : ''}。${stub}`);
      onCreated?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '写入失败');
    } finally {
      setBusy(false);
    }
  };

  const patch = async (): Promise<void> => {
    const descError = draftErrors.find((item) => item.includes('description') || item.includes('何时'));
    if (name === '' || descError || !confirmPatch) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await postSkillDescription(name, named.description);
      if ('created' in result && result.created === false) {
        setError(result.error);
        return;
      }
      if ('ok' in result && result.ok) {
        setNotice(`已改 description：${result.path}。正文未动。`);
        onCreated?.();
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '改写失败');
    } finally {
      setBusy(false);
    }
  };

  const recordOutcome = async (result: 'ok' | 'fail'): Promise<void> => {
    if (name === '' || !confirmOutcome) return;
    setBusy(true);
    setEvolveNote(undefined);
    try {
      const recorded = await postSkillOutcome({ label: evolveLabel, skill: name, result });
      if ('created' in recorded && recorded.created === false) {
        setEvolveNote(recorded.error);
        return;
      }
      setEvolveNote(`已记 ${name} / ${evolveLabel || 'unlabeled'} = ${result}。${CALL_IS_NOT_VERDICT_COPY}。`);
    } catch (caught) {
      setEvolveNote(caught instanceof Error ? caught.message : '记录失败');
    } finally {
      setBusy(false);
    }
  };

  const rerank = async (): Promise<void> => {
    if (!confirmRerank) return;
    setBusy(true);
    setEvolveNote(undefined);
    try {
      const payload = await postSkillRerank(named.description, evolveLabel);
      if ('created' in payload && payload.created === false) {
        setEvolveNote(typeof payload.error === 'string' ? payload.error : '提案失败');
        return;
      }
      const report = parseEvolveReport(payload);
      const pick = report.rerank?.pick;
      const copy = report.rerank?.copy ?? RERANK_UNAVAILABLE_COPY;
      setEvolveNote(pick ? `${copy}。提案 ${pick}。` : copy);
    } catch (caught) {
      setEvolveNote(caught instanceof Error ? caught.message : '提案失败');
    } finally {
      setBusy(false);
    }
  };

  const runEvals = (): void => {
    const next = runLexicalTriggerEvals(named.description, evals);
    setReport(next);
    const suggested = suggestDescription(named.description, evals);
    setSuggestion(suggested.changed ? suggested.next : undefined);
    setNotice(suggested.changed ? suggested.reasons.join(' ') : `${LEXICAL_EVAL_COPY}。${suggested.reasons[0] ?? ''}`);
  };

  return (
    <div className="surface-stack skills-studio">
      <p className="surface-lede">
        工作室只写模型根 <code>{MODEL_ROOT_DISPLAY}</code>。不写 <code>{CLAUDE_ROOT_DISPLAY}</code>。
        插件 stub 只写 <code>~/.dsh/agos/plugin-stubs</code>，未装进 profile。
        评测是{LEXICAL_EVAL_COPY}。{RERANK_UNAVAILABLE_COPY}。{POSTERIOR_METHOD_COPY}。{CALL_IS_NOT_VERDICT_COPY}。
      </p>

      <section className="surface-section" aria-label="意图">
        <h3 className="surface-h3">意图</h3>
        <label className="skills-studio-field">
          <span className="u-microlabel">名称</span>
          <div className="surface-cluster">
            <input
              className="form-input"
              value={draft.name}
              onChange={(event) => setField('name', event.target.value)}
              placeholder="inbox-triage"
            />
            <Button size="sm" variant="ghost" disabled={busy || name === ''} onClick={() => void load()}>
              从模型根读入
            </Button>
          </div>
        </label>
        <label className="skills-studio-field">
          <span className="u-microlabel">description（何时触发）</span>
          <textarea
            className="form-input skills-studio-area"
            rows={4}
            value={draft.description}
            onChange={(event) => setField('description', event.target.value)}
            placeholder="每当用户要清理收件箱、分拣邮件或说 inbox 时使用本技能。"
          />
        </label>
        <label className="skills-studio-field">
          <span className="u-microlabel">whenToUse（可选）</span>
          <input
            className="form-input"
            value={draft.whenToUse}
            onChange={(event) => setField('whenToUse', event.target.value)}
          />
        </label>
        <label className="skills-studio-field">
          <span className="u-microlabel">正文</span>
          <textarea
            className="form-input skills-studio-area"
            rows={8}
            value={draft.body}
            onChange={(event) => setField('body', event.target.value)}
            placeholder="步骤、判断、失败回退。"
          />
        </label>
        <label className="skills-studio-check">
          <input
            type="checkbox"
            checked={draft.needsPlugin}
            onChange={(event) => setField('needsPlugin', event.target.checked)}
          />
          需要插件动词（写 stub，不装进 profile）
        </label>
        {draft.needsPlugin && (
          <label className="skills-studio-field">
            <span className="u-microlabel">插件提示名</span>
            <input
              className="form-input"
              value={draft.pluginHint}
              onChange={(event) => setField('pluginHint', event.target.value)}
              placeholder="gmail-inbox"
            />
          </label>
        )}
      </section>

      <section className="surface-section" aria-label="触发评测">
        <h3 className="surface-h3">触发评测集</h3>
        <p className="surface-quiet">
          官方闭环要「该触发 / 不该触发」近邻负例。这里用词面重合打分，不跑大模型对照。
        </p>
        <div className="surface-cluster">
          <Badge state="queued">该触发 {evalReport.should}</Badge>
          <Badge state="queued">不该触发 {evalReport.shouldNot}</Badge>
          {report && (
            <Badge state={report.should.passed === report.should.total && report.shouldNot.passed === report.shouldNot.total ? 'done' : 'running'}>
              词面 {report.should.passed}/{report.should.total} · {report.shouldNot.passed}/{report.shouldNot.total}
            </Badge>
          )}
        </div>
        <ul className="skills-studio-evals">
          {evals.map((row, index) => (
            <li key={index} className="skills-studio-eval">
              <select
                className="form-input form-input--sm"
                value={row.shouldTrigger ? 'yes' : 'no'}
                onChange={(event) => {
                  const next = [...evals];
                  next[index] = { ...row, shouldTrigger: event.target.value === 'yes' };
                  setEvals(next);
                  setReport(undefined);
                }}
              >
                <option value="yes">该触发</option>
                <option value="no">不该触发</option>
              </select>
              <input
                className="form-input"
                value={row.query}
                onChange={(event) => {
                  const next = [...evals];
                  next[index] = { ...row, query: event.target.value };
                  setEvals(next);
                  setReport(undefined);
                }}
                placeholder={row.shouldTrigger ? '用户会怎么说' : '相近但不该用本技能'}
              />
            </li>
          ))}
        </ul>
        <div className="surface-cluster">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setEvals((rows) => [...rows, { query: '', shouldTrigger: false }])}
          >
            加一条
          </Button>
          <Button size="sm" variant="ghost" disabled={evalReport.errors.length > 0 || named.description === ''} onClick={runEvals}>
            跑词面评测
          </Button>
          {suggestion && (
            <Button size="sm" variant="ghost" onClick={() => setField('description', suggestion)}>
              采用建议 description
            </Button>
          )}
        </div>
        {report && (
          <ul className="surface-list">
            {report.rows.map((row) => (
              <li key={row.query} className="surface-quiet">
                {row.pass ? '过' : '漏'} · {row.shouldTrigger ? '该触发' : '不该触发'} · 重合 {row.score.toFixed(2)} · {row.query}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="surface-section" aria-label="预览">
        <h3 className="surface-h3">将写入</h3>
        <p className="surface-quiet">
          <code>{name ? modelRootPath(name) : `${MODEL_ROOT_DISPLAY}/<name>/SKILL.md`}</code>
          {evalReport.should + evalReport.shouldNot > 0 && name && (
            <>
              {' · '}
              <code>{evalsPath(name)}</code>
            </>
          )}
          {draft.needsPlugin && draft.pluginHint && (
            <>
              {' · '}
              <code>{pluginStubPath(draft.pluginHint)}</code>
            </>
          )}
        </p>
        {preview && <pre className="skills-studio-preview">{preview}</pre>}
      </section>

      {blocked.length > 0 && (
        <ul className="surface-list">
          {blocked.map((item) => (
            <li key={item} className="surface-quiet">{item}</li>
          ))}
        </ul>
      )}

      <label className="skills-studio-check">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(event) => setConfirmed(event.target.checked)}
        />
        确认新建 {name ? modelRootPath(name) : MODEL_ROOT_DISPLAY}，已存在则失败
      </label>
      <div className="surface-cluster">
        <Button size="sm" disabled={busy || !confirmed || blocked.length > 0} onClick={() => void write()}>
          {busy ? '写入中…' : '写入模型根'}
        </Button>
      </div>

      <label className="skills-studio-check">
        <input
          type="checkbox"
          checked={confirmPatch}
          onChange={(event) => setConfirmPatch(event.target.checked)}
        />
        确认只改已有技能的 description，正文不动
      </label>
      <div className="surface-cluster">
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || !confirmPatch || name === '' || Boolean(draftErrors.find((item) => item.includes('description') || item.includes('何时')))}
          onClick={() => void patch()}
        >
          只改 description
        </Button>
      </div>
      <section className="surface-section" aria-label="经验后验">
        <h3 className="surface-h3">{POSTERIOR_METHOD_COPY}</h3>
        <p className="surface-quiet">
          {CALL_IS_NOT_VERDICT_COPY}。小模型只提案短名单，不调用路由 decide。{RERANK_OPT_IN_COPY}。
        </p>
        <label className="skills-studio-field">
          <span className="u-microlabel">任务类 label</span>
          <input
            className="form-input"
            value={evolveLabel}
            onChange={(event) => setEvolveLabel(event.target.value)}
            placeholder="inbox / docs / coding"
          />
        </label>
        <label className="skills-studio-check">
          <input
            type="checkbox"
            checked={confirmOutcome}
            onChange={(event) => setConfirmOutcome(event.target.checked)}
          />
          确认把「{name || '当前技能'} / {evolveLabel || 'unlabeled'}」记成人工胜负
        </label>
        <div className="surface-cluster">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || !confirmOutcome || name === ''}
            onClick={() => void recordOutcome('ok')}
          >
            记成功
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || !confirmOutcome || name === ''}
            onClick={() => void recordOutcome('fail')}
          >
            记失败
          </Button>
        </div>
        <label className="skills-studio-check">
          <input
            type="checkbox"
            checked={confirmRerank}
            onChange={(event) => setConfirmRerank(event.target.checked)}
          />
          确认用小模型提案（失败回退词面+后验，不写路由账本）
        </label>
        <div className="surface-cluster">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || !confirmRerank || named.description === ''}
            onClick={() => void rerank()}
          >
            用小模型提案
          </Button>
        </div>
        {evolveNote && <p role="status" className="surface-quiet">{evolveNote}</p>}
      </section>

      {notice && <p role="status" className="surface-quiet">{notice}</p>}
      {error && <p role="alert" className="surface-alert">{error}</p>}
    </div>
  );
};
