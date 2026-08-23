/**
 * W17 影子选择器在 DispatchModal 的边界锁(017「明确不做」第 2/7 条):
 *  - 影子结果只展示、只写台账:AST 上 setForm / change / setPending / toggleHost / onDispatch 的实参子树里不得出现 shadow 标识符;
 *  - 成本句与建议句由状态算出;同签名不重复调用;
 *  - 词汇:不出现「派活」(仓级锁另管)、不出现三档字面值(routes-model.test 管)。
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { shadowCostCopy, shadowIntroCopy, shadowRelationCopy, shadowSignature } from './dispatch-shadow';
import type { FleetDispatchRequest } from './dispatch-form';

const here = dirname(fileURLToPath(import.meta.url));
const file = join(here, 'DispatchModal.tsx');

test('AST 锁:影子状态不得流进 setForm/change/setPending/toggleHost/onDispatch 的实参', () => {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const WRITERS = new Set(['setForm', 'change', 'setPending', 'toggleHost', 'onDispatch', 'validateDispatchForm']);
  const SHADOW_IDS = /^(shadow|shadowCopy|runShadow|setShadow|postShadowSelection|postShadowLink|shadowSuggestionCopy)$/;
  const offenders: string[] = [];
  const mentionsShadow = (node: ts.Node): boolean => {
    let hit = false;
    const walk = (n: ts.Node): void => { if (ts.isIdentifier(n) && SHADOW_IDS.test(n.text)) hit = true; if (!hit) ts.forEachChild(n, walk); };
    walk(node);
    return hit;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
      if (WRITERS.has(name) && node.arguments.some(mentionsShadow)) {
        offenders.push(`${name}@${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  // 别名绕过:把影子结果先存进普通变量再传给 writer。锁所有「初始化表达式含影子标识符」的变量声明,
  // 只放行已知的展示/关联用途(它们不会进 writer),并把这些名字也纳入影子标识符集合再跑一遍。
  const ALLOWED_DERIVED = new Set(['shadowCopy', 'shadowRelation', 'shadowInFlight', 'latest', 'signature', 'hostsHit']);
  const derived: string[] = [];
  const visitDecl = (node: ts.Node): void => {
    // 只看「值别名」:初始化表达式是函数的(组件/回调)不算别名,它们的实参流向由 visit 那一轮查
    if (ts.isVariableDeclaration(node) && node.initializer !== undefined && !ts.isArrowFunction(node.initializer) && !ts.isFunctionExpression(node.initializer) && mentionsShadow(node.initializer)) {
      const name = ts.isIdentifier(node.name) ? node.name.text : node.name.getText();
      if (!ALLOWED_DERIVED.has(name) && !/^shadow/.test(name)) offenders.push(`alias ${name}@${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
      derived.push(name);
    }
    ts.forEachChild(node, visitDecl);
  };
  visitDecl(sf);
  const DERIVED_RE = new RegExp(`^(${[...derived, 'hostsHit', 'latest'].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`);
  const mentionsDerived = (node: ts.Node): boolean => {
    let hit = false;
    const walk = (n: ts.Node): void => { if (ts.isIdentifier(n) && DERIVED_RE.test(n.text)) hit = true; if (!hit) ts.forEachChild(n, walk); };
    walk(node);
    return hit;
  };
  const visit2 = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
      if (WRITERS.has(name) && node.arguments.some(mentionsDerived)) offenders.push(`derived→${name}@${sf.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
    }
    ts.forEachChild(node, visit2);
  };
  visit(sf);
  visit2(sf);
  assert.deepEqual(offenders, []);
  // 影子调用必须存在且只在 review 路径(校验通过后),确认路径只做关联
  const text = readFileSync(file, 'utf8');
  assert.equal((text.match(/runShadow\(result\.request\)/g) ?? []).length, 1);
  assert.equal((text.match(/postShadowSelection\(/g) ?? []).length, 1);
  assert.equal((text.match(/postShadowLink\(/g) ?? []).length, 1);
  assert.match(text, /const latest = shadowRef\.current;\s*if \(latest\.status === 'done' && latest\.result\.kind === 'decided'\) \{\s*const hostsHit/);
  // 影子在途时确认按钮禁用;影子状态不随 open 重置
  assert.match(text, /disabled=\{submitting \|\| shadowInFlight\}/);
  assert.doesNotMatch(text, /setShadow\(\{ status: 'idle' \}\)/);
});

test('同签名不重复调用:同一选择器输入(任务/标签/批次名/候选池)签名相同;勾选不进签名', () => {
  const base: FleetDispatchRequest = { items: ['a', 'b'], hosts: ['leo-01'], tag: '', wake: true, label: 'x' };
  const pool = ['leo-01', 'leo-02'];
  assert.equal(shadowSignature(base, pool), shadowSignature({ ...base }, [...pool].reverse()));
  assert.equal(shadowSignature(base, pool), shadowSignature({ ...base, hosts: [] }, pool), '只改勾选不再烧一次:勾选不进选择器输入');
  assert.notEqual(shadowSignature(base, pool), shadowSignature({ ...base, items: ['a'] }, pool));
  assert.notEqual(shadowSignature(base, pool), shadowSignature(base, ['leo-01']));
  assert.equal(shadowSignature({ items: ['a'], wake: true }, []), shadowSignature({ items: ['a'], wake: false }, []), 'wake/timeout 不影响选择器输入,不算新签名');
});

test('成本句由影子状态算出:idle 才说「尚未调用」;calling/done/failed 各自如实', () => {
  assert.equal(shadowCostCopy({ status: 'idle' }), '确认前尚未调用派发接口，也不会唤醒机器。');
  assert.match(shadowCostCopy({ status: 'calling', signature: 's' }), /正在做一次选择器影子调用/);
  assert.match(shadowCostCopy({ status: 'done', signature: 's', result: { kind: 'decided', id: 'dec-1', pick: null, reason: undefined, confidence: undefined, source: 'fallback', fallbackReason: 'UNPARSEABLE', agreed: null, candidates: [] } }), /已做一次选择器影子调用（已记台账）/);
  assert.match(shadowCostCopy({ status: 'done', signature: 's', result: { kind: 'skipped', message: 'x' } }), /未调用选择器/);
  assert.match(shadowCostCopy({ status: 'failed', signature: 's', error: 'e' }), /影子调用失败（不影响派发）/);
  for (const s of [{ status: 'idle' as const }, { status: 'calling' as const, signature: 's' }, { status: 'failed' as const, signature: 's', error: 'e' }]) {
    assert.match(shadowCostCopy(s), /派发接口尚未调用|尚未调用派发接口/);
  }
});

test('成本/说明/关系句由数据算出:零候选不许诺调用;NOT_CONFIGURED 说「没有真正打出去」;关系按当前勾选', () => {
  assert.match(shadowIntroCopy(0), /不会调用选择器（零额度）/);
  assert.match(shadowIntroCopy(5), /对这 5 台候选做一次选择器影子调用/);
  const nc = shadowCostCopy({ status: 'done', signature: 's', result: { kind: 'decided', id: 'dec-1', pick: null, reason: undefined, confidence: undefined, source: 'fallback', fallbackReason: 'NOT_CONFIGURED', agreed: null, candidates: [] } });
  assert.match(nc, /没有真正打出去（NOT_CONFIGURED，零模型调用/);
  assert.equal(shadowRelationCopy('knowledge-m4', ['leo-01']), '与你勾选的机器不一致；派发仍按你的勾选');
  assert.equal(shadowRelationCopy('knowledge-m4', ['knowledge-m4', 'leo-01']), '与你勾选的机器一致');
  assert.equal(shadowRelationCopy('knowledge-m4', []), '你没有勾选机器，派发由调度器分配；建议只记台账');
  assert.equal(shadowRelationCopy(null, ['leo-01']), undefined);
});
