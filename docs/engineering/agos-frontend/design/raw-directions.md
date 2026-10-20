# TASK-2026-08-20-002 附件:四路设计原始稿(未裁剪)

> 合成结论见 TASK-2026-08-20-002.md;本文件供实现时查细节。


---

<!-- 原始稿 1 -->

# 方向:「遥测甲板 TELEMETRY DECK」

界面是一块被点亮的航电仪表板:数据用等宽数字锁死在网格上,状态只用三色灯语说话,极淡的扫描网格给面板一层"机壳"质感。动效像开关卡入挡位——快、准、停得干脆;唯一允许"呼吸"的是正在运行的东西,静止的界面绝对静止。

---

## 动效 token(共 6 个,写入全局 CSS 字符串顶部)

```css
:root {
  --u-dur-tick: 90ms;   /* 按压反馈、灯位切换 */
  --u-dur-fast: 140ms;  /* hover 位移、veil 淡入 */
  --u-dur-base: 200ms;  /* 面板入场、内容落位 */
  --u-dur-scan: 2.4s;   /* 仅运行态常驻:呼吸环 / 进度条流光 */
  --u-ease-swift: cubic-bezier(0.3, 0, 0, 1);     /* 快出急停,仪表指针 */
  --u-ease-latch: cubic-bezier(0.2, 0.9, 0.1, 1); /* 微过冲后锁定,"卡入挡位" */
}
```

**两条纪律**(全套 CSS 都按此执行):
1. `transition` 属性列表里**只出现 transform 和 opacity**。颜色/背景切换一律 0ms 瞬变——灯语不渐变,亮就是亮,灭就是灭。
2. 全局降级块(放 CSS 字符串末尾):

```css
@media (prefers-reduced-motion: reduce) {
  .u-veil, .u-modal, .u-nav::before, .u-swarm-fill, .u-trigger { transition: none; }
  .u-dot--running::after, .u-trigger-alert--running::after,
  .u-swarm-card.is-running .u-swarm-bar::before { animation: none; }
  .u-modal.is-booting .u-modal-scan::before { animation: none; }
  .u-modal.is-booting .u-nav, .u-job-detail > * { animation: none; opacity: 1; transform: none; }
}
```

另立一个复用类(等宽数字是本方向的签名,所有数值必挂):

```css
.u-num { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums; }
.u-microlabel { font-size: 10px; line-height: 14px; letter-spacing: 0.1em;
  text-transform: uppercase; color: var(--dsw-alias-label-tertiary); }
```

---

## 面 1:AgOS 控制台

**1)面板机壳:硬边框 + 24px 扫描网格 + 品牌环境光。** 网格淡到只在大面积空白处隐约可见(2% currentColor),深浅主题自动成立。

```css
.u-modal {
  background-color: var(--dsw-alias-bg-layer-1);
  background-image:
    repeating-linear-gradient(0deg,  color-mix(in oklch, currentColor 2%, transparent) 0 1px, transparent 1px 24px),
    repeating-linear-gradient(90deg, color-mix(in oklch, currentColor 2%, transparent) 0 1px, transparent 1px 24px);
  border: 1px solid color-mix(in oklch, currentColor 14%, transparent);
  border-radius: 8px;
  box-shadow: 0 32px 80px color-mix(in oklch, var(--dsw-alias-state-business-primary) 10%, transparent);
}
```

**2)导航 rail:活动项是"通电"的——左缘 2px 灯条 scaleY 弹入,徽章等宽数字。**

```css
.u-rail { border-right: 1px solid color-mix(in oklch, currentColor 8%, transparent); }
.u-nav { position: relative; border-radius: 4px; }
.u-nav:hover { background: var(--dsw-alias-interactive-bg-hover); }
.u-nav::before { content: ""; position: absolute; left: 0; top: 6px; bottom: 6px; width: 2px;
  border-radius: 1px; background: var(--dsw-alias-state-business-primary);
  transform: scaleY(0); transition: transform var(--u-dur-fast) var(--u-ease-latch); }
.u-nav.is-active::before { transform: scaleY(1); }
.u-nav.is-active { color: var(--dsw-alias-state-business-primary);
  background: color-mix(in oklch, var(--dsw-alias-state-business-primary) 9%, transparent); }
.u-nav-badge { min-width: 16px; padding: 0 4px; border-radius: 3px;
  font-size: 10px; line-height: 16px; text-align: center;
  font-family: ui-monospace, Menlo, monospace; font-variant-numeric: tabular-nums;
  background: color-mix(in oklch, currentColor 10%, transparent); }
.u-nav-badge--error { color: var(--dsw-alias-state-error-primary);
  background: color-mix(in oklch, var(--dsw-alias-state-error-primary) 14%, transparent); }
```

**3)KPI 卡仪表化:上微标签、下 26px 等宽读数、顶部 1px 内高光。** 「需要关注」收件箱的错误项加左缘红条(灯语,非装饰)。

```css
.u-kpi-card { padding: 14px 16px; border-radius: 6px;
  background-color: var(--dsw-alias-bg-layer-1);
  border: 1px solid color-mix(in oklch, currentColor 10%, transparent);
  box-shadow: inset 0 1px 0 color-mix(in oklch, currentColor 4%, transparent); }
.u-kpi-value { margin-top: 2px; font-size: 26px; line-height: 32px; font-weight: 640;
  letter-spacing: -0.01em; /* 配合 .u-num 使用 */ }
.u-kpi-unit { margin-left: 3px; font-size: 12px; font-weight: 500;
  color: var(--dsw-alias-label-tertiary); }
.u-inbox-item--error { box-shadow: inset 2px 0 0 var(--dsw-alias-state-error-primary); }
```

**4)会话表:hover 瞬亮 + 左缘定位线,数字列右对齐等宽。** 不做 hover 过渡——扫过一行行地"点亮",这就是机房感。

```css
.u-page table { width: 100%; border-collapse: collapse; }
.u-page tbody tr { cursor: pointer; }
.u-page tbody tr:hover { background: var(--dsw-alias-interactive-bg-hover);
  box-shadow: inset 2px 0 0 var(--dsw-alias-state-business-primary); }
.u-page td { padding: 7px 10px; font-size: 12px;
  border-top: 1px solid color-mix(in oklch, currentColor 7%, transparent); }
.u-page td.is-num { text-align: right; color: var(--dsw-alias-label-secondary); } /* 加 .u-num */
```

**5)谱系页:垂直母线 + 水平引脚,把 Job 卡接成电路图。** 纯静态伪元素,零 JS。

```css
.u-lineage { position: relative; padding-left: 18px; }
.u-lineage::before { content: ""; position: absolute; left: 5px; top: 8px; bottom: 8px;
  width: 1px; background: color-mix(in oklch, var(--dsw-alias-state-business-primary) 30%, transparent); }
.u-job-card { position: relative; }
.u-job-card::before { content: ""; position: absolute; left: -13px; top: 18px;
  width: 13px; height: 1px;
  background: color-mix(in oklch, var(--dsw-alias-state-business-primary) 30%, transparent); }
```

**6)展开详情(谱系三段/计划页步骤):"挡位式"展开。** 禁 height 动画就不做假的——容器高度直接跳变(像拨开关),**内容**分三段 40ms 级联落位,观感反而更"仪表"。三段标题(状态/委派任务/最终回复)用 `.u-microlabel`。

```css
.u-job-detail > * { opacity: 0; transform: translateY(-4px);
  animation: u-settle var(--u-dur-base) var(--u-ease-swift) forwards; }
.u-job-detail > *:nth-child(2) { animation-delay: 40ms; }
.u-job-detail > *:nth-child(3) { animation-delay: 80ms; }
@keyframes u-settle { to { opacity: 1; transform: none; } }
```

---

## 面 2:swarm 进度卡

**1)分段刻度进度条:fill 用 scaleX + CSS 变量驱动,8 格刻度用卡底色"冲压"出来。** JS 侧 `style: {'--u-p': done/total}`,更新自动补间。

```css
.u-swarm-bar { position: relative; height: 4px; border-radius: 2px; overflow: hidden;
  background: color-mix(in oklch, currentColor 12%, transparent); }
.u-swarm-fill { position: absolute; inset: 0; background: var(--dsw-alias-state-business-primary);
  transform-origin: left center; transform: scaleX(var(--u-p, 0));
  transition: transform var(--u-dur-base) var(--u-ease-swift); }
.u-swarm-bar::after { content: ""; position: absolute; inset: 0;
  background: repeating-linear-gradient(90deg,
    transparent 0 calc(12.5% - 1px),
    var(--dsw-alias-bg-layer-1) calc(12.5% - 1px) 12.5%); }
```

**2)运行态流光(唯一的常驻动画之一,挂在 `.is-running` 下):**

```css
.u-swarm-card.is-running .u-swarm-bar::before { content: ""; position: absolute;
  top: 0; bottom: 0; left: 0; width: 40%;
  background: linear-gradient(90deg, transparent,
    color-mix(in oklch, var(--dsw-alias-bg-layer-1) 40%, transparent), transparent);
  animation: u-sweep var(--u-dur-scan) linear infinite; }
@keyframes u-sweep { from { transform: translateX(-100%); } to { transform: translateX(350%); } }
```

**3).u-dot 状态灯全局规格(严格四态,谱系/机器页共用):** 排队=空心、运行=蓝+扩散环(常驻,仅此态)、完成=绿实心、失败=红+静态晕圈。

```css
.u-dot { width: 8px; height: 8px; border-radius: 50%; position: relative; flex: none; }
.u-dot--queued { background: transparent;
  box-shadow: inset 0 0 0 1.5px var(--dsw-alias-label-dimmed); }
.u-dot--running { background: var(--dsw-alias-state-business-primary); }
.u-dot--running::after { content: ""; position: absolute; inset: 0; border-radius: 50%;
  border: 1.5px solid var(--dsw-alias-state-business-primary);
  animation: u-ping var(--u-dur-scan) var(--u-ease-swift) infinite; }
@keyframes u-ping { 0% { transform: scale(1); opacity: .7; }
  70%, 100% { transform: scale(2.4); opacity: 0; } }
.u-dot--done { background: var(--dsw-alias-state-success-primary); }
.u-dot--failed { background: var(--dsw-alias-state-error-primary);
  box-shadow: 0 0 0 3px color-mix(in oklch, var(--dsw-alias-state-error-primary) 20%, transparent); }
```

**4)行列表上网格:7 列定宽 grid,序号补零右对齐,耗时右对齐等宽,状态词大写字距。** JS:`String(i + 1).padStart(2, '0')`。

```css
.u-swarm-row { display: grid; align-items: center; gap: 8px; padding: 5px 0;
  grid-template-columns: 14px 24px minmax(0, 1fr) auto auto 56px 64px; font-size: 12px; }
.u-swarm-idx  { font-size: 10px; text-align: right; color: var(--dsw-alias-label-dimmed); } /* +.u-num */
.u-swarm-time { font-size: 11px; text-align: right; color: var(--dsw-alias-label-tertiary); } /* +.u-num */
.u-swarm-state { font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; text-align: right; }
.u-swarm-state--running { color: var(--dsw-alias-state-business-primary); }
.u-swarm-state--done    { color: var(--dsw-alias-state-success-primary); }
.u-swarm-state--failed  { color: var(--dsw-alias-state-error-primary); }
```

**5)角色 chips(🎭⤴⛓)与 provider 降噪成"机务铭牌":** 3px 圆角近方形、1px 边、10px 字号;技能页筛选 chips 复用同一规格,激活态即 `.is-on`。

```css
.u-chip { display: inline-flex; align-items: center; gap: 3px; height: 16px; padding: 0 5px;
  border-radius: 3px; font-size: 10px; line-height: 16px;
  border: 1px solid color-mix(in oklch, currentColor 14%, transparent);
  color: var(--dsw-alias-label-tertiary); }
.u-chip.is-on { color: var(--dsw-alias-state-business-primary);
  border-color: color-mix(in oklch, var(--dsw-alias-state-business-primary) 40%, transparent);
  background: color-mix(in oklch, var(--dsw-alias-state-business-primary) 10%, transparent); }
```

**6)CivStrip 计数器化:** 1px 上分隔线,三组「微标签 + 等宽粗数字」;否决 >0 亮红、晋升门通过亮绿,零值用 dimmed——一眼扫出异常。

```css
.u-civstrip { display: flex; gap: 16px; margin-top: 8px; padding-top: 8px;
  border-top: 1px solid color-mix(in oklch, currentColor 8%, transparent); }
.u-civstrip b { font-weight: 600; } /* +.u-num */
.u-civstrip .is-zero b      { color: var(--dsw-alias-label-dimmed); }
.u-civstrip .is-veto b      { color: var(--dsw-alias-state-error-primary); }
.u-civstrip .is-gate-pass b { color: var(--dsw-alias-state-success-primary); }
```

---

## 面 3:侧栏入口按钮(🧭 28px)

**1)按压挡位感:** hover 底色瞬亮(不过渡),按下 scale(0.92) 用 90ms 急回弹;控制台开着时挂 1px 品牌内环表示"在线"。

```css
.u-trigger { position: relative; width: 28px; height: 28px; border-radius: 6px;
  display: grid; place-items: center;
  transition: transform var(--u-dur-tick) var(--u-ease-swift); }
.u-trigger:hover { background: var(--dsw-alias-interactive-bg-hover); }
.u-trigger:active { transform: scale(0.92); }
.u-trigger.is-open { box-shadow: inset 0 0 0 1px
  color-mix(in oklch, var(--dsw-alias-state-business-primary) 55%, transparent); }
```

**2)注意力小点:6px,白圈(卡底色)描边把它从 emoji 上"抬"起来;优先级 JS 侧裁决——失败 > 运行,永远只渲染一颗。**

```css
.u-trigger-alert { position: absolute; top: 3px; right: 3px; width: 6px; height: 6px;
  border-radius: 50%; box-shadow: 0 0 0 2px var(--dsw-alias-bg-layer-1); }
.u-trigger-alert--error   { background: var(--dsw-alias-state-error-primary); }   /* 静态,红灯不闪 */
.u-trigger-alert--running { background: var(--dsw-alias-state-business-primary); }
```

**3)运行态扩散环(常驻动画,仅运行小点;失败红点刻意静止——静止的红比闪烁的红更严重):**

```css
.u-trigger-alert--running::after { content: ""; position: absolute; inset: 0; border-radius: 50%;
  border: 1px solid var(--dsw-alias-state-business-primary);
  animation: u-ping var(--u-dur-scan) var(--u-ease-swift) infinite; } /* 复用 u-ping */
```

---

## Wow 时刻:「开舱序列 Deck Boot」

打开控制台的 560ms 编排:遮罩亮 → 面板卡入 → 一道品牌色扫描线自上而下掠过 → 导航逐项通电 → KPI 数字滚动落位。全部 transform/opacity,一次性播放,半天可做完。

**时间轴:**

| t | 元素 | 动作 |
|---|---|---|
| 0ms | .u-veil | opacity 0→1,140ms swift |
| 40ms | .u-modal | opacity 0→1 + scale(0.98) translateY(8px)→none,200ms latch(微过冲=锁舱) |
| 160ms | 扫描线 | translateY(-100%)→(100%) 掠过一次,320ms |
| 180ms | .u-nav ×6 | 逐项 40ms 级联,translateX(-6px)+opacity 落位 |
| 240ms | KPI 数字 | rAF 从 0 滚到终值,320ms ease-out |

**CSS(追加到全局字符串):**

```css
.u-veil { opacity: 0; transition: opacity var(--u-dur-fast) var(--u-ease-swift); }
.u-veil.is-on { opacity: 1; }
.u-modal { opacity: 0; transform: scale(0.98) translateY(8px); }
.u-modal.is-on { opacity: 1; transform: none;
  transition: opacity var(--u-dur-base) var(--u-ease-swift),
              transform var(--u-dur-base) var(--u-ease-latch); }
.u-modal-scan { position: absolute; inset: 0; overflow: hidden;
  border-radius: inherit; pointer-events: none; }
.u-modal-scan::before { content: ""; position: absolute; inset: 0;
  background: linear-gradient(180deg, transparent 0 46%,
    color-mix(in oklch, var(--dsw-alias-state-business-primary) 14%, transparent) 50%,
    transparent 54% 100%);
  transform: translateY(-100%); }
.u-modal.is-booting .u-modal-scan::before {
  animation: u-scan 320ms 160ms var(--u-ease-swift) both; }
@keyframes u-scan { to { transform: translateY(100%); } }
.u-modal.is-booting .u-nav { opacity: 0; transform: translateX(-6px);
  animation: u-settle var(--u-dur-base) var(--u-ease-swift) both;
  animation-delay: calc(180ms + var(--u-i, 0) * 40ms); } /* 复用谱系的 u-settle */
```

**JS 要点(全部 createElement 内联,无依赖):**
1. 面板 mount 后 `requestAnimationFrame(() => el.classList.add('is-on'))`(保证初始帧先渲染);同时挂 `is-booting`,`setTimeout(700ms)` 摘除。每次"打开"只播一次,数据轮询重渲染不重播(用 ref 存 booted 标志)。
2. `.u-modal-scan` 是面板内第一个空 div,一行 `React.createElement('div', { className: 'u-modal-scan' })`。
3. 导航级联:渲染循环里 `style: { '--u-i': i }`,零硬编码延迟。
4. KPI 滚数(挂在 value 节点的 ref 回调上,滚动期间 tabular-nums 保证宽度不抖):

```js
function countUp(el, target, fmt) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = fmt(target); return; }
  const t0 = performance.now(), D = 320;
  (function tick(t) {
    const p = Math.min(1, (t - t0) / D), e = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt(Math.round(target * e));
    if (p < 1) requestAnimationFrame(tick);
  })(t0);
}
```

5. 纪律:滚数只在开舱时执行;后续轮询更新直接写终值——仪表读数不表演。reduced-motion 下整个序列走上文全局降级块,面板与数字瞬时呈现终态。

---

<!-- 原始稿 2 -->

# 方向名:「校样 PROOF」

把 agent 控制台当成一份**正在付印的报纸校样**:层级全部由排印建立——大号 tabular 数字、细规线(hairline column rules)、小号大写字距标签,色彩几乎退场,唯一的品牌蓝只出现在"正在活动"的地方。动效是标点而不是装饰:开场一次编排定调("落版"),之后整个界面静止,只有运行态在呼吸。

---

## 动效 token(全部 6 个)

定义一次,挂在三个根选择器上(样式在 JS 字符串里,直接并进现有 style 常量):

```css
.u-modal, .u-swarm, .u-agos-btn {
  --u-dur-tap:   120ms;                          /* hover / 按压微反馈 */
  --u-dur-flip:  240ms;                          /* 行、区块入场;指示条 */
  --u-dur-press: 320ms;                          /* 面板开场;进度条推进 */
  --u-ease-out:  cubic-bezier(0.22, 1, 0.36, 1); /* 一切入场:快出缓收 */
  --u-ease-loop: cubic-bezier(0.65, 0, 0.35, 1); /* 仅常驻循环(扫光/呼吸) */
  --u-stagger:   24ms;                           /* 级联步长 */
  /* 规线,双主题自动适配 */
  --u-hairline:        color-mix(in oklch, currentColor 12%, transparent);
  --u-hairline-strong: color-mix(in oklch, currentColor 22%, transparent);
}
```

---

## 一、AgOS 控制台

**1. 排印地基:面板去投影,tabular 数字全局生效。** 面板不用阴影,靠一条 strong hairline 和 veil 的明暗差立起来;所有数字等宽,后面 KPI 滚动、耗时跳动才不抖。

```css
.u-modal {
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--u-hairline-strong);
  border-radius: 10px;
  box-shadow: none;
  font-variant-numeric: tabular-nums;
}
```

**2. 导航 rail:emoji 换成「序号 + 纯文字」,活动指示条用 scaleY 展开。** 每项渲染为 `createElement('span',{className:'u-nav-index'},'01')` + 文字(概览/机器/会话/谱系/计划/技能),132px 宽度下文字比 emoji 信息密度更高。

```css
.u-nav {
  position: relative;
  display: flex; align-items: center; gap: 8px;
  padding: 7px 10px 7px 14px;
  font-size: 12px; font-weight: 500; letter-spacing: 0.02em;
  color: var(--dsw-alias-label-secondary);
  border-radius: 6px;
  transition: color var(--u-dur-tap), background var(--u-dur-tap);
}
.u-nav:hover { background: var(--dsw-alias-interactive-bg-hover); }
.u-nav-index {
  font-size: 10px;
  color: var(--dsw-alias-label-dimmed);
}
.u-nav::before {                       /* 活动指示条 */
  content: "";
  position: absolute; left: 0; top: 8px; bottom: 8px; width: 2px;
  border-radius: 1px;
  background: var(--dsw-alias-state-business-primary);
  transform: scaleY(0);
  transition: transform var(--u-dur-flip) var(--u-ease-out);
}
.u-nav.is-active { color: inherit; font-weight: 600; }
.u-nav.is-active::before { transform: scaleY(1); }
```

**3. 徽章从「填色药丸」降为「空心计数」,只有错误时上色。**

```css
.u-nav-badge {
  min-width: 16px; padding: 1px 5px;
  font-size: 10px; font-weight: 600; font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-secondary);
  background: none;
  box-shadow: inset 0 0 0 1px var(--u-hairline-strong);
  border-radius: 999px;
}
.u-nav-badge.is-error {
  color: var(--dsw-alias-state-error-primary);
  box-shadow: inset 0 0 0 1px color-mix(in oklch, currentColor 40%, transparent);
}
```

**4. KPI 卡改「报纸栏」:去底色去圆角,一条顶规线 + 34px 大数字。** 四栏放在 `grid-template-columns: repeat(4, 1fr)` 里,数字位数变化不影响外部布局。(新增类 .u-kpi*,套在现有卡容器上)

```css
.u-kpi {
  background: none; border: 0; border-radius: 0;
  border-top: 1px solid var(--u-hairline-strong);
  padding: 12px 0 0;
}
.u-kpi-label {
  font-size: 11px; font-weight: 500;
  letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--dsw-alias-label-tertiary);
}
.u-kpi-num {
  margin-top: 2px;
  font-size: 34px; line-height: 1.1;
  font-weight: 650; letter-spacing: -0.02em;
}
.u-kpi-num.is-error { color: var(--dsw-alias-state-error-primary); }
.u-kpi-sub { font-size: 11px; color: var(--dsw-alias-label-dimmed); }
```

**5. 会话表格:表头做成小号大写"栏题",行 hover 用 inset 蓝条(box-shadow,不动布局)。**

```css
.u-page thead th {
  font-size: 10px; font-weight: 600;
  letter-spacing: 0.08em; text-transform: uppercase; text-align: left;
  color: var(--dsw-alias-label-dimmed);
  padding: 0 12px 8px;
  border-bottom: 1px solid var(--u-hairline-strong);
}
.u-page tbody td {
  padding: 10px 12px; font-size: 12.5px;
  border-bottom: 1px solid var(--u-hairline);
}
.u-page tbody tr { cursor: pointer; transition: background var(--u-dur-tap); }
.u-page tbody tr:hover {
  background: var(--dsw-alias-interactive-bg-hover);
  box-shadow: inset 2px 0 0 var(--dsw-alias-state-business-primary);
}
```

**6. 谱系 Job 卡展开:布局瞬时切换(不违反禁令),三段详情做 24ms 级联入场;技能页筛选 chips 空心化,选中态用品牌蓝 10% 底。**

```css
.u-job-detail > section {
  animation: u-rise var(--u-dur-flip) var(--u-ease-out) both;
}
.u-job-detail > section:nth-child(2) { animation-delay: 24ms; }
.u-job-detail > section:nth-child(3) { animation-delay: 48ms; }
@keyframes u-rise { from { opacity: 0; transform: translateY(8px); } }

.u-chip {
  padding: 3px 10px; font-size: 11px; font-weight: 500; border-radius: 999px;
  background: none; color: var(--dsw-alias-label-secondary);
  box-shadow: inset 0 0 0 1px var(--u-hairline-strong);
  transition: color var(--u-dur-tap), background var(--u-dur-tap), box-shadow var(--u-dur-tap);
}
.u-chip:hover { background: var(--dsw-alias-interactive-bg-hover); }
.u-chip.is-on {
  color: var(--dsw-alias-state-business-primary);
  background: color-mix(in oklch, var(--dsw-alias-state-business-primary) 10%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in oklch, var(--dsw-alias-state-business-primary) 40%, transparent);
}
@media (prefers-reduced-motion: reduce) { .u-job-detail > section { animation: none; } }
```

---

## 二、swarm 进度卡

**1. 卡框 + 标题行:hairline 边框,任务计数排成「07/12」分数体。**

```css
.u-swarm {
  background: var(--dsw-alias-bg-layer-1);
  border: 1px solid var(--u-hairline-strong);
  border-radius: 8px;
  font-variant-numeric: tabular-nums;
}
.u-swarm-title { font-size: 12px; font-weight: 600; }
.u-swarm-count { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
```

**2. 进度条:2px 细线,scaleX 推进(JS 写 `style={{'--p': done/total}}`);扫光 sheen 是全卡唯一常驻动画,严格 gate 在运行态。**

```css
.u-bar {
  position: relative; height: 2px;
  background: var(--u-hairline);
  overflow: hidden;
}
.u-bar-fill {
  position: absolute; inset: 0;
  background: var(--dsw-alias-state-business-primary);
  transform: scaleX(var(--p, 0));
  transform-origin: left center;
  transition: transform var(--u-dur-press) var(--u-ease-out);
}
.u-swarm.is-running .u-bar::after {
  content: "";
  position: absolute; inset: 0;
  background: linear-gradient(90deg, transparent,
    color-mix(in oklch, var(--dsw-alias-state-business-primary) 45%, transparent), transparent);
  transform: translateX(-100%);
  animation: u-sweep 1.8s var(--u-ease-loop) infinite;
}
@keyframes u-sweep { to { transform: translateX(100%); } }
@media (prefers-reduced-motion: reduce) { .u-swarm.is-running .u-bar::after { content: none; } }
```

**3. 行列表改「台账」:grid 定列,序号右对齐 dimmed,状态词小号大写按状态上色;完成行整体降为 tertiary(注意力只留给失败与运行)。**

```css
.u-swarm-row {
  display: grid;
  grid-template-columns: 12px 24px 1fr auto auto auto;
  align-items: center; gap: 8px;
  padding: 6px 12px; font-size: 12px;
  border-top: 1px solid var(--u-hairline);
}
.u-swarm-row .u-idx { font-size: 10px; text-align: right; color: var(--dsw-alias-label-dimmed); }
.u-swarm-row.is-done .u-task { color: var(--dsw-alias-label-tertiary); }
.u-status {
  font-size: 10px; font-weight: 600;
  letter-spacing: 0.06em; text-transform: uppercase;
}
.u-swarm-row.is-running .u-status { color: var(--dsw-alias-state-business-primary); }
.u-swarm-row.is-done    .u-status { color: var(--dsw-alias-label-dimmed); }
.u-swarm-row.is-failed  .u-status { color: var(--dsw-alias-state-error-primary); }
```

**4. 状态点 .u-dot 四态:排队空心、运行呼吸环(唯一允许的第二个常驻动画)、成功/失败实心。**

```css
.u-dot { width: 6px; height: 6px; border-radius: 50%; position: relative; }
.u-dot.is-queued  { box-shadow: inset 0 0 0 1px color-mix(in oklch, currentColor 35%, transparent); }
.u-dot.is-running { background: var(--dsw-alias-state-business-primary); }
.u-dot.is-done    { background: var(--dsw-alias-state-success-primary); }
.u-dot.is-failed  { background: var(--dsw-alias-state-error-primary); }
.u-dot.is-running::after {
  content: "";
  position: absolute; inset: -3px; border-radius: 50%;
  border: 1px solid var(--dsw-alias-state-business-primary);
  animation: u-ping 1.6s var(--u-ease-out) infinite;
}
@keyframes u-ping {
  from { transform: scale(0.5); opacity: 0.9; }
  to   { transform: scale(1.4); opacity: 0; }
}
@media (prefers-reduced-motion: reduce) {
  .u-dot.is-running::after { animation: none; transform: none; opacity: 0.5; }
}
```

**5. 角色 chips / provider / 耗时全部降噪:emoji 缩小去饱和,元数据统一 10px dimmed。**

```css
.u-role-chip {
  font-size: 10px; padding: 1px 6px; border-radius: 4px;
  color: var(--dsw-alias-label-tertiary);
  box-shadow: inset 0 0 0 1px var(--u-hairline);
}
.u-role-chip .emoji { font-size: 9px; opacity: 0.65; filter: grayscale(1); }
.u-provider, .u-elapsed { font-size: 10px; color: var(--dsw-alias-label-dimmed); letter-spacing: 0.04em; }
```

**6. CivStrip 做成「版权页 colophon」:一条 strong 顶规线,统计写成行内句子,否决/晋升门数字按语义上色。**

```css
.u-civstrip {
  display: flex; gap: 16px;
  padding: 8px 12px;
  border-top: 1px solid var(--u-hairline-strong);
  font-size: 10.5px;
  color: var(--dsw-alias-label-tertiary);
}
.u-civstrip b { font-weight: 650; }
.u-civstrip .is-veto b      { color: var(--dsw-alias-state-error-primary); }
.u-civstrip .is-gate-pass b { color: var(--dsw-alias-state-success-primary); }
```

---

## 三、侧栏入口按钮

**1. 🧭 换成「Ag」字标(10px/700),与整套排印语言同源;hover 抬起 1px,按压 scale 0.94。**

```css
.u-agos-btn {
  width: 28px; height: 28px;
  display: grid; place-items: center;
  border-radius: 7px;
  font-size: 10px; font-weight: 700; letter-spacing: 0.03em;
  color: var(--dsw-alias-label-secondary);
  position: relative;
  transition: transform var(--u-dur-tap) var(--u-ease-out),
              background var(--u-dur-tap), color var(--u-dur-tap);
}
.u-agos-btn:hover  { background: var(--dsw-alias-interactive-bg-hover); color: inherit; transform: translateY(-1px); }
.u-agos-btn:active { transform: scale(0.94); transition-duration: 60ms; }
```

**2. 注意力小点:失败=红且**静止**(失败不是运行态,禁常驻动画);运行=蓝且呼吸,复用 u-ping。**

```css
.u-agos-btn .u-alert {
  position: absolute; top: 3px; right: 3px;
  width: 5px; height: 5px; border-radius: 50%;
}
.u-alert.is-error   { background: var(--dsw-alias-state-error-primary); }
.u-alert.is-running { background: var(--dsw-alias-state-business-primary); }
.u-alert.is-running::after {
  content: "";
  position: absolute; inset: -3px; border-radius: 50%;
  border: 1px solid var(--dsw-alias-state-business-primary);
  animation: u-ping 1.6s var(--u-ease-out) infinite;
}
@media (prefers-reduced-motion: reduce) { .u-alert.is-running::after { animation: none; opacity: 0.5; } }
```

**3. 优先级规则写死在 JS:同时有失败和运行时只渲染 is-error(红点静止 > 蓝点呼吸),不叠两个点。** 无 CSS,一行三元:`className: hasFailed ? 'u-alert is-error' : running ? 'u-alert is-running' : ''`。

---

## Wow 时刻:「落版」开场编排(半天~一天)

打开控制台的 600ms 是整个产品被看见次数最多的动效位。做一次完整编排:veil 淡入 → 面板从 12px 下方带 0.985 缩放"压"上来 → rail 六项 24ms 级联点亮 → 页面区块级联入场 → KPI 大数字 480ms 滚到位。之后界面完全静止——一次标点,全篇安静。

**CSS(全部 transform/opacity,keyframe 只写 from,`both` 补终态):**

```css
.u-veil  { animation: u-fade var(--u-dur-tap) linear both; }
@keyframes u-fade { from { opacity: 0; } }

.u-modal { animation: u-press var(--u-dur-press) var(--u-ease-out) both; }
@keyframes u-press { from { opacity: 0; transform: translateY(12px) scale(0.985); } }

.u-rail .u-nav {
  animation: u-rise var(--u-dur-flip) var(--u-ease-out) both;
  animation-delay: calc(120ms + var(--i, 0) * var(--u-stagger));
}
.u-page > * {
  animation: u-rise var(--u-dur-flip) var(--u-ease-out) both;
  animation-delay: calc(160ms + min(var(--i, 0), 12) * var(--u-stagger)); /* 封顶:长表不拖沓 */
}
/* u-rise 已在谱系节定义,全局只声明一次 */
@media (prefers-reduced-motion: reduce) {
  .u-veil, .u-modal, .u-rail .u-nav, .u-page > * { animation: none; }
}
```

**JS 要点:**
1. 级联索引:渲染子项时 `React.createElement('div', { className, style: { '--i': i } }, ...)`,零依赖。
2. 重放控制:`.u-page` 容器加 `key: activePageId`——切页时 React 重挂载,只重放页内级联(面板级 u-press 因 veil/modal 不重挂载而不重放);开场则全链路走一遍。
3. KPI 滚数(约 15 行,rAF + easeOutCubic;文本更新非布局动画,tabular-nums + 四等分 grid 保证零抖动):

```js
function countUp(el, to, ms = 480) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { el.textContent = to.toLocaleString(); return; }
  var t0 = performance.now();
  requestAnimationFrame(function tick(t) {
    var k = Math.min(1, (t - t0) / ms);
    var e = 1 - Math.pow(1 - k, 3);
    el.textContent = Math.round(to * e).toLocaleString();
    if (k < 1) requestAnimationFrame(tick);
  });
}
// 概览页挂载后延迟 300ms 调用,恰好接在区块入场之后
```

成本盘点:3 组 keyframes + 每个列表渲染处加一个 `--i`,加一个 15 行函数;无新依赖、无新资源,一天内含调参完成。辨识度来源:市面 agent 工具的浮层都是"闪现",这里是**一次有节奏的付印**,且此后全静——对比本身就是签名。

---

<!-- 原始稿 3 -->

# 设计方向:「活体机房 Vivarium」

把 agent 集群当成一只有生命体征的生物:凡是正在运行的部分都按同一套节律活动——一次呼吸(2600ms)恰好等于两次心跳(1300ms),全站只有这一种脉搏。凡是空闲的部分彻底静止如标本;辨识度不来自"到处有动画",而来自"活着的在动、闲着的纹丝不动"这一强对比。

## 动效 token(共 6 个)

声明在三个面的根节点上(`.u-modal`、swarm 卡根、入口按钮),或统一挂 `documentElement`:

| Token | 值 | 用途 |
|---|---|---|
| `--u-dur-fast` | `140ms` | hover / 按压 / 退场淡出 |
| `--u-dur-pop` | `380ms` | 入场弹簧配套时长 |
| `--u-dur-breath` | `2600ms` | 呼吸周期;心跳一律写 `calc(var(--u-dur-breath) / 2)` = 1300ms |
| `--u-ease-swift` | `cubic-bezier(0.30, 0.70, 0.40, 1)` | 退出 / 悬停 / 进度过渡,无过冲 |
| `--u-ease-spring` | `cubic-bezier(0.34, 1.42, 0.44, 1)` | 入场,实测过冲约 6% |
| `--u-ease-breathe` | `cubic-bezier(0.37, 0, 0.63, 1)` | 呼吸 / 心跳 keyframes,近似正弦 |

## 全局纪律(三条,所有片段共用)

**1. 动画与过渡只写 transform / opacity。** 需要"底色淡入"的地方不 transition background,用 opacity 蒙层;不需要淡入的(如真 `<table>` 行)直接瞬时切 background——瞬时切换不是动画,合规:

```css
.u-hit { position: relative; }
.u-hit::before { content: ''; position: absolute; inset: 0; border-radius: inherit;
  background: var(--dsw-alias-interactive-bg-hover); opacity: 0; pointer-events: none;
  transition: opacity var(--u-dur-fast) var(--u-ease-swift); }
.u-hit:hover::before { opacity: 1; }
```

**2. 所有 `infinite` 动画必须挂在状态类下**(`.is-running` / `.is-busy` / `.is-run`),由 JS 按真实运行态映射;无状态类 = 零动画。空闲界面截屏应与静态图无差别。

**3. reduced-motion 降级块**(追加在样式字符串末尾;运行态用静态光环替代脉搏,信息不丢):

```css
@media (prefers-reduced-motion: reduce) {
  [class^="u-"], [class*=" u-"],
  .u-nav::before, .u-kpi--live.is-running::after, .u-dot.is-run::after,
  .u-entry-dot.is-run::after, .u-job.is-child::before, .u-job.is-child::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
  .u-kpi--live.is-running::after { opacity: 0.35; }
  .u-dot.is-run, .u-entry-dot.is-run {
    box-shadow: 0 0 0 3px color-mix(in oklch, var(--dsw-alias-state-business-primary) 22%, transparent); }
}
```

## 面 1:AgOS 控制台

**1.1 Rail「脉络」导航。** 选中项左缘长出一根 3px 血管,spring 展开;徽章按语义着色,数字用等宽数字:

```css
.u-nav { position: relative; }
.u-nav::before { content: ''; position: absolute; left: 0; top: 6px; bottom: 6px; width: 3px;
  border-radius: 2px; background: var(--dsw-alias-state-business-primary);
  transform: scaleY(0); transition: transform var(--u-dur-pop) var(--u-ease-spring); }
.u-nav.is-active::before { transform: scaleY(1); }
.u-nav-badge { font-size: 10px; padding: 0 5px; border-radius: 999px;
  font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-state-business-primary);
  background: color-mix(in oklch, var(--dsw-alias-state-business-primary) 12%, transparent); }
.u-nav-badge.is-err { color: var(--dsw-alias-state-error-primary);
  background: color-mix(in oklch, var(--dsw-alias-state-error-primary) 12%, transparent); }
```

(悬停底色套用全局 `.u-hit` 蒙层。)

**1.2 KPI 卡「体征」化。** 发丝线描边 + 大号等宽数字 + 全大写小标签;"运行中"那张卡在有活跃任务时描边呼吸,空闲完全静止:

```css
.u-kpi { position: relative; background: var(--dsw-alias-bg-layer-1); border-radius: 10px;
  border: 1px solid color-mix(in oklch, currentColor 10%, transparent); padding: 14px 16px; }
.u-kpi-num { font-size: 26px; font-weight: 650; letter-spacing: -0.02em;
  font-variant-numeric: tabular-nums; }
.u-kpi-label { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase;
  color: var(--dsw-alias-label-tertiary); }
.u-kpi--live::after { content: ''; position: absolute; inset: 0; border-radius: 10px;
  border: 1px solid var(--dsw-alias-state-business-primary); opacity: 0; pointer-events: none; }
.u-kpi--live.is-running::after {
  animation: u-breathe var(--u-dur-breath) var(--u-ease-breathe) infinite; }
@keyframes u-breathe { 0%, 100% { opacity: 0.12; } 50% { opacity: 0.55; } }
```

**1.3 「需要关注」收件箱。** 错误色左端口 + 7% 染底,新条目 spring 滑入(一次性,任何状态可用):

```css
.u-inbox-item { border-left: 3px solid var(--dsw-alias-state-error-primary);
  border-radius: 0 8px 8px 0; padding: 10px 12px;
  background: color-mix(in oklch, var(--dsw-alias-state-error-primary) 7%, transparent);
  animation: u-slide-in var(--u-dur-pop) var(--u-ease-spring) both; }
@keyframes u-slide-in { from { opacity: 0; transform: translateX(-8px); } to { opacity: 1; transform: none; } }
```

**1.4 机器页机架卡「电源灯」。** 每张机架卡一枚 6px 状态灯;有任务在跑才呼吸,否则灰色死灯:

```css
.u-rack { background: var(--dsw-alias-bg-layer-1); border-radius: 12px; padding: 14px 16px;
  border: 1px solid color-mix(in oklch, currentColor 9%, transparent); }
.u-rack .u-lamp { width: 6px; height: 6px; border-radius: 50%;
  background: var(--dsw-alias-label-dimmed); }
.u-rack.is-busy .u-lamp { background: var(--dsw-alias-state-business-primary);
  animation: u-lamp var(--u-dur-breath) var(--u-ease-breathe) infinite; }
@keyframes u-lamp { 0%, 100% { opacity: 0.45; } 50% { opacity: 1; } }
```

**1.5 谱系页「血缘线」。** 子 Job 卡缩进 22px,用伪元素画竖脊 + 肘线(零图片资产);挂载时竖脊自上而下 scaleY 生长、肘线随后 scaleX 接上,层级感变成"长出来"的;运行中的子代理肘线染 accent 并随呼吸明暗——这就是"营养在输送":

```css
.u-job.is-child { position: relative; margin-left: 22px; }
.u-job.is-child::before { content: ''; position: absolute; left: -13px; top: -10px;
  width: 1.5px; height: calc(50% + 10px);
  background: color-mix(in oklch, currentColor 18%, transparent);
  transform-origin: 50% 0;
  animation: u-grow var(--u-dur-pop) var(--u-ease-swift) both;
  animation-delay: var(--u-stagger, 0ms); }
.u-job.is-child::after { content: ''; position: absolute; left: -13px; top: 50%;
  width: 13px; height: 1.5px; margin-top: -1px;
  background: color-mix(in oklch, currentColor 18%, transparent);
  transform-origin: 0 50%;
  animation: u-grow-x var(--u-dur-fast) var(--u-ease-swift) both;
  animation-delay: calc(var(--u-stagger, 0ms) + 120ms); }
.u-job.is-child.is-running::after {
  background: color-mix(in oklch, var(--dsw-alias-state-business-primary) 60%, transparent);
  animation: u-grow-x var(--u-dur-fast) var(--u-ease-swift) both,
             u-lamp var(--u-dur-breath) var(--u-ease-breathe) infinite; }
@keyframes u-grow   { from { transform: scaleY(0); } to { transform: scaleY(1); } }
@keyframes u-grow-x { from { transform: scaleX(0); } to { transform: scaleX(1); } }
```

JS 侧按行序注入错峰:`React.createElement('div', { className: 'u-job is-child', style: { '--u-stagger': (i * 50) + 'ms' } }, ...)`。行点开的三段详情复用 `u-rise`(见 Wow 节)做 60ms 级联:

```css
.u-job-detail > section { animation: u-rise var(--u-dur-pop) var(--u-ease-spring) both; }
.u-job-detail > section:nth-child(2) { animation-delay: 60ms; }
.u-job-detail > section:nth-child(3) { animation-delay: 120ms; }
```

**1.6 会话表与技能筛选 chips 的微反馈。** 表格行 hover 瞬时换底 + 2px 位移暗示可点;chip 选中态染 accent、按压回缩:

```css
.u-page tr:hover { background: var(--dsw-alias-interactive-bg-hover); }
.u-page tr { transition: transform var(--u-dur-fast) var(--u-ease-swift); }
.u-page tr:hover { transform: translateX(2px); }
.u-page tr:active { transform: translateX(2px) scale(0.995); }
.u-chip-filter { font-size: 11px; padding: 2px 10px; border-radius: 999px;
  color: var(--dsw-alias-label-secondary);
  border: 1px solid color-mix(in oklch, currentColor 14%, transparent);
  transition: transform var(--u-dur-fast) var(--u-ease-swift); }
.u-chip-filter:active { transform: scale(0.94); }
.u-chip-filter.is-on { color: var(--dsw-alias-state-business-primary);
  border-color: color-mix(in oklch, var(--dsw-alias-state-business-primary) 45%, transparent);
  background: color-mix(in oklch, var(--dsw-alias-state-business-primary) 10%, transparent); }
```

## 面 2:swarm 进度卡

**2.1 卡壳运行态镶边。** 运行中整卡描边染 accent 35%(瞬时切换,非动画),完成/失败回到中性发丝线:

```css
.u-swarm-card { background: var(--dsw-alias-bg-layer-1); border-radius: 12px; padding: 12px 14px;
  border: 1px solid color-mix(in oklch, currentColor 9%, transparent); }
.u-swarm-card.is-running {
  border-color: color-mix(in oklch, var(--dsw-alias-state-business-primary) 35%, transparent); }
```

**2.2 进度条:scaleX 填充 + 运行态流光。** 填充永远用 transform(禁 width);流光是一条 40% 宽的亮带在轨道内平移循环,仅运行态存在:

```css
.u-swarm-bar { position: relative; overflow: hidden; height: 4px; border-radius: 2px;
  background: color-mix(in oklch, currentColor 12%, transparent); }
.u-swarm-fill { position: absolute; inset: 0; border-radius: 2px;
  background: var(--dsw-alias-state-business-primary);
  transform-origin: 0 50%; transition: transform 420ms var(--u-ease-swift); }
/* JS 每次进度更新: fillEl.style.transform = 'scaleX(' + done / total + ')' */
.u-swarm-bar .u-swarm-flow { display: none; }
.u-swarm-bar.is-running .u-swarm-flow { display: block; position: absolute;
  top: 0; bottom: 0; left: -40%; width: 40%;
  background: linear-gradient(90deg, transparent,
    color-mix(in oklch, var(--dsw-alias-bg-layer-1) 45%, transparent), transparent);
  animation: u-flow 1400ms linear infinite; }
@keyframes u-flow { to { transform: translateX(350%); } }
```

**2.3 状态点心跳(双搏)。** 运行中的 `.u-dot` 外圈按"扑-通"节奏扩散两次(第二跳更弱),周期 = 半个呼吸;成功/失败/等待全部静止:

```css
.u-dot { position: relative; width: 8px; height: 8px; border-radius: 50%;
  background: var(--dsw-alias-label-dimmed); }
.u-dot.is-ok  { background: var(--dsw-alias-state-success-primary); }
.u-dot.is-err { background: var(--dsw-alias-state-error-primary); }
.u-dot.is-run { background: var(--dsw-alias-state-business-primary); }
.u-dot.is-run::after { content: ''; position: absolute; inset: -3px; border-radius: 50%;
  border: 1px solid var(--dsw-alias-state-business-primary);
  animation: u-heartbeat calc(var(--u-dur-breath) / 2) var(--u-ease-breathe) infinite; }
@keyframes u-heartbeat {
  0%   { transform: scale(0.6);  opacity: 0.9; }
  45%  { transform: scale(1.35); opacity: 0; }
  55%  { transform: scale(0.6);  opacity: 0.7; }
  80%  { transform: scale(1.15); opacity: 0; }
  100% { transform: scale(0.6);  opacity: 0; } }
```

这个组件同时供谱系页 Job 卡与机器页复用——全站心跳只有一种。

**2.4 完成「定格」。** 行从 running 变 done 的那一帧,状态点从 1.5 倍 spring 收回原位(一次性),JS 在状态翻转时加 `just-done` 类、`animationend` 后移除:

```css
.u-row.just-done .u-dot { animation: u-settle var(--u-dur-pop) var(--u-ease-spring) both; }
@keyframes u-settle { from { transform: scale(1.5); } to { transform: scale(1); } }
```

**2.5 行内层级压制。** 任务文本是唯一主角;序号/provider/耗时全部降为 dimmed 等宽小字,角色 chips 缩成 10px 胶囊,状态词按语义着色:

```css
.u-row .u-idx, .u-row .u-provider, .u-row .u-elapsed {
  color: var(--dsw-alias-label-dimmed); font-size: 11px; font-variant-numeric: tabular-nums; }
.u-row .u-role-chip { font-size: 10px; padding: 1px 6px; border-radius: 999px;
  color: var(--dsw-alias-label-tertiary);
  background: color-mix(in oklch, currentColor 8%, transparent); }
.u-row-state { font-size: 11px; }
.u-row.is-run .u-row-state { color: var(--dsw-alias-state-business-primary); }
.u-row.is-ok  .u-row-state { color: var(--dsw-alias-state-success-primary); }
.u-row.is-err .u-row-state { color: var(--dsw-alias-state-error-primary); }
```

**2.6 CivStrip「门」统计。** 发丝线分隔,晋升绿/否决红/投票中性;计数增加时数字向上弹跳一次(加 `bump` 类,`animationend` 移除):

```css
.u-civstrip { display: flex; gap: 14px; margin-top: 8px; padding-top: 8px;
  border-top: 1px solid color-mix(in oklch, currentColor 8%, transparent);
  font-size: 11px; font-variant-numeric: tabular-nums;
  color: var(--dsw-alias-label-tertiary); }
.u-civstrip .u-stat--promote .u-stat-num { color: var(--dsw-alias-state-success-primary); }
.u-civstrip .u-stat--veto    .u-stat-num { color: var(--dsw-alias-state-error-primary); }
.u-civstrip .u-stat-num.bump { display: inline-block;
  animation: u-bump var(--u-dur-pop) var(--u-ease-spring); }
@keyframes u-bump { 30% { transform: translateY(-3px) scale(1.15); } }
```

## 面 3:侧栏入口按钮

**3.1 按压手感。** hover 放大 8%、按下缩回 8%,swift 曲线:

```css
.u-entry { position: relative; transition: transform var(--u-dur-fast) var(--u-ease-swift); }
.u-entry:hover  { transform: scale(1.08); }
.u-entry:active { transform: scale(0.92); }
```

**3.2 注意力点的优先级与节律。** 失败(红)压过运行(蓝);红点是静止的伤口——失败不是运行态,禁常驻动画;蓝点复用全站心跳:

```css
.u-entry-dot { position: absolute; top: 2px; right: 2px; width: 6px; height: 6px;
  border-radius: 50%; background: var(--dsw-alias-state-business-primary);
  animation: u-pop-in var(--u-dur-pop) var(--u-ease-spring) both; }
.u-entry-dot.is-fail { background: var(--dsw-alias-state-error-primary); }
.u-entry-dot.is-run:not(.is-fail)::after { content: ''; position: absolute; inset: -3px;
  border-radius: 50%; border: 1px solid var(--dsw-alias-state-business-primary);
  animation: u-heartbeat calc(var(--u-dur-breath) / 2) var(--u-ease-breathe) infinite; }
@keyframes u-pop-in { from { transform: scale(0); } to { transform: scale(1); } }
```

**3.3 挖孔环。** 小点与 28px 按钮之间垫一圈 2px 底色(静态 box-shadow,非动画),避免贴边糊掉:

```css
.u-entry-dot { box-shadow: 0 0 0 2px var(--dsw-alias-bg-layer-1); }
```

无事件时不渲染 `.u-entry-dot` 节点——空闲即静止,DOM 层面也是。

## Wow 时刻:「苏醒序列」——AgOS 面板开场编排

**选它的理由:** 每次打开 AgOS 必看的 700ms;纯 CSS keyframes + 每元素 `animationDelay` + 一个 60 行的数字滚动组件,一天内可完成;并且它把"活体"的第一印象定死了——面板不是"弹出",是"醒来"。

**时间轴(总长约 700ms):**

| t | 元素 | 动作 |
|---|---|---|
| 0 | `.u-veil` | opacity 0→1,140ms swift |
| 40ms | `.u-modal` | scale(0.965) + translateY(12px) → 原位,380ms spring |
| 120ms + i×30ms | `.u-nav` 第 i 项 | translateX(-10px) + opacity → 原位,spring |
| 180ms + i×40ms | `.u-kpi` 第 i 张 | translateY(14px) scale(0.98) → 原位,spring |
| 180ms 起 | KPI 数字 | rAF 从 0 滚到真值,600ms easeOutCubic |

**关键 CSS:**

```css
.u-veil  { animation: u-fade var(--u-dur-fast) var(--u-ease-swift) both; }
@keyframes u-fade { from { opacity: 0; } to { opacity: 1; } }
.u-modal { animation: u-wake var(--u-dur-pop) var(--u-ease-spring) 40ms both; }
@keyframes u-wake {
  from { opacity: 0; transform: scale(0.965) translateY(12px); }
  to   { opacity: 1; transform: none; } }
.u-nav   { animation: u-wake-item var(--u-dur-pop) var(--u-ease-spring) both; }
@keyframes u-wake-item { from { opacity: 0; transform: translateX(-10px); } to { opacity: 1; transform: none; } }
.u-kpi   { animation: u-rise var(--u-dur-pop) var(--u-ease-spring) both; }
@keyframes u-rise { from { opacity: 0; transform: translateY(14px) scale(0.98); } to { opacity: 1; transform: none; } }
```

**关键 JS 要点(React.createElement 风格):**

1. 错峰用 inline style 注入,`both` 保证延迟期间停在首帧不闪现:
   `React.createElement('div', { className: 'u-nav', style: { animationDelay: (120 + i * 30) + 'ms' } }, ...)`
2. 只在开启时重播:面板根节点 `key: openCount`(每次打开自增),数据轮询刷新不会触发重挂载、不会重播编排。
3. 数字滚动组件用 ref + rAF 直写 `textContent`,不走每帧 setState:

```js
function CountUp(props) {
  var ref = React.useRef(null);
  React.useEffect(function () {
    var el = ref.current, target = props.value;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.textContent = String(target); return; }
    var t0 = performance.now(), dur = 600, raf;
    function tick(now) {
      var t = Math.min(1, (now - t0) / dur), e = 1 - Math.pow(1 - t, 3);
      el.textContent = String(Math.round(target * e));
      if (t < 1) raf = requestAnimationFrame(tick); }
    raf = requestAnimationFrame(tick);
    return function () { cancelAnimationFrame(raf); };
  }, [props.value]);
  return React.createElement('span',
    { ref: ref, className: 'u-kpi-num', style: { fontVariantNumeric: 'tabular-nums' } }, '0');
}
```

4. `tabular-nums` 防止滚动中数字宽度抖动;滚动只在挂载那一次,后续轮询更新直接写终值。
5. 页内切换免费复得同款质感:每个 `.u-page` 的卡片列表天然带 `u-rise` + 错峰,切到机器页/谱系页时内容同样"长出来";谱系页与 1.5 的血缘线生长动画叠加,即整套"苏醒—生长"叙事闭环。
6. 关闭不做对称编排:veil 与 modal 同时 opacity→0 + scale(0.98),140ms swift 收掉——入睡要快,苏醒才值钱。

---

<!-- 原始稿 4:动效编排规范 -->

# 动效编排规范 —— 方向名:「共息」(Breathe as One)

整个控制台共享一套节拍:进场是一次自上而下、总长不超过 450ms 的吸气,运行是全局同相位的 2400ms 心跳,完成与失败是一次不超过 360ms 的短促呼气。辨识度不来自色块而来自节奏——聊天流里的 swarm 卡、浮层里的谱系点、侧栏入口的小蓝点在同一拍上起伏,这就是 DSH 的签名。

---

## 0. 动效 Token(全 6 个,挂在 .u-modal 与 swarm 卡根节点上即可)

```css
:root {
  --u-dur-fast: 140ms;   /* 微交互:按压、离场、状态词 */
  --u-dur-base: 220ms;   /* 入场:面板、卡片、行 */
  --u-dur-slow: 360ms;   /* 进度条推进、一次性强调 */
  --u-stagger: 24ms;     /* 全局唯一级联步长 */
  --u-ease-swift: cubic-bezier(0.33, 1, 0.68, 1);   /* easeOutCubic:一切入场/位移 */
  --u-ease-pop: cubic-bezier(0.34, 1.56, 0.64, 1);  /* 过冲:状态点、徽章弹入 */
}
/* 全局微交互底噪:可点元素按压回馈,唯一允许的 hover/active 位移 */
.u-nav, .u-page tr, .u-swarm .u-row {
  transition: transform var(--u-dur-fast) var(--u-ease-swift);
}
.u-nav:active { transform: scale(0.97); }
```

约束自查:全部动画仅 transform/opacity;色彩换挡一律瞬时(颜色不在白名单里,不做 color transition,动作感交给缩放);常驻动画仅出现在 `.is-running` 之下。

---

## ① 面板开场时序表(总长恰好 450ms)

| # | 元素 | 属性 | delay | duration | 曲线 | 结束于 |
|---|------|------|-------|----------|------|--------|
| 1 | `.u-veil` | opacity 0→1 | 0ms | 140ms | linear | 140ms |
| 2 | `.u-modal` | opacity 0→1; translateY(10px) scale(.965)→none | 30ms | 220ms | swift | 250ms |
| 3 | `.u-rail .u-nav` 逐个 | opacity 0→1; translateX(-8px)→0 | 110ms + n×20ms(n=0..5 封顶) | 160ms | swift | 370ms |
| 4 | `.u-page` 内容级联 | opacity 0→1; translateY(8px)→0 | 150ms + n×24ms(n=0..5 封顶) | 180ms | swift | 450ms |

节奏逻辑:遮罩先落定,面板在遮罩半程时浮起,rail 在面板落位前开始从上往下点亮,内容压着 rail 的尾巴进——四层首尾咬合,无一刻静止,也无两层同时抢戏。

```css
.u-veil { animation: u-fade-in 140ms linear both; }
@keyframes u-fade-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}

.u-modal { animation: u-panel-in var(--u-dur-base) var(--u-ease-swift) 30ms both; }
.u-modal.is-opening { --u-lead: 150ms; will-change: transform, opacity; }
@keyframes u-panel-in {
  from { opacity: 0; transform: translateY(10px) scale(0.965); }
  60%  { opacity: 1; }
  to   { opacity: 1; transform: none; }
}

.u-rail .u-nav { animation: u-nav-in 160ms var(--u-ease-swift) both; }
.u-rail .u-nav:nth-child(1) { animation-delay: 110ms; }
.u-rail .u-nav:nth-child(2) { animation-delay: 130ms; }
.u-rail .u-nav:nth-child(3) { animation-delay: 150ms; }
.u-rail .u-nav:nth-child(4) { animation-delay: 170ms; }
.u-rail .u-nav:nth-child(5) { animation-delay: 190ms; }
.u-rail .u-nav:nth-child(n+6) { animation-delay: 210ms; }
@keyframes u-nav-in {
  from { opacity: 0; transform: translateX(-8px); }
  to   { opacity: 1; transform: none; }
}
```

**JS 挂点**:浮层挂载时给 `.u-modal` 加 `.is-opening`、给 `.u-page` 加 `.is-entering`,setTimeout 700ms 后一起摘除(ref callback 或 effect 里做,不依赖 JSX)。摘类是为了让后续数据刷新不重播进场——所有入场 keyframes 都圈在这两个类之下。

---

## ② 列表 stagger 数学

规则只有三条,全局通用:

1. **唯一步长 `--u-stagger: 24ms`,上限 N=6**。第 7 项起共用第 6 项的 delay,整批同帧进场。6×24=120ms 级联窗口 + 180ms 时长,保证尾项不破 450ms 总长;N 若随行数增长,100 行会话表会变成 2.5s 的拉幕。
2. **每页只许一层级联**。级联作用于"该页最重复的单元":概览页=顶层块(4 KPI 卡+收件箱),会话页=tr,谱系页=Job 卡,技能页=发现行。嵌套双层级联是时长失控的头号来源。实现上给该容器挂 `.u-stagger-host`,块内其余内容随块整体进场。
3. **超长列表不做视口检测**。第 7+ 行同帧进场,transform/opacity 全在合成层,100 行无布局成本,不值得引 IntersectionObserver。

```css
.is-entering .u-stagger-host > * { animation: u-rise 180ms var(--u-ease-swift) both; }
.is-entering .u-stagger-host > :nth-child(1) { animation-delay: calc(var(--u-lead, 0ms) + 0ms); }
.is-entering .u-stagger-host > :nth-child(2) { animation-delay: calc(var(--u-lead, 0ms) + 24ms); }
.is-entering .u-stagger-host > :nth-child(3) { animation-delay: calc(var(--u-lead, 0ms) + 48ms); }
.is-entering .u-stagger-host > :nth-child(4) { animation-delay: calc(var(--u-lead, 0ms) + 72ms); }
.is-entering .u-stagger-host > :nth-child(5) { animation-delay: calc(var(--u-lead, 0ms) + 96ms); }
.is-entering .u-stagger-host > :nth-child(n+6) { animation-delay: calc(var(--u-lead, 0ms) + 120ms); }
@keyframes u-rise {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: none; }
}

/* swarm 卡在聊天流里,不走浮层 lead,行数少,N=4、步长 20ms */
.u-swarm.is-entering .u-row { animation: u-rise 180ms var(--u-ease-swift) both; }
.u-swarm.is-entering .u-row:nth-child(1) { animation-delay: 0ms; }
.u-swarm.is-entering .u-row:nth-child(2) { animation-delay: 20ms; }
.u-swarm.is-entering .u-row:nth-child(3) { animation-delay: 40ms; }
.u-swarm.is-entering .u-row:nth-child(n+4) { animation-delay: 60ms; }
```

`--u-lead` 的妙处:开场时 `.u-modal.is-opening` 提供 150ms 前置,页内切换时该类不在、lead 自动归零,同一套 ladder 两用。

**轮询新增行**:`.is-entering` 摘除后插入的行不播级联,只播单独一次 `u-rise`(无 delay)——JS 给新行加 `.is-new`,animationend 后摘除:

```css
.u-stagger-host > .is-new { animation: u-rise 180ms var(--u-ease-swift) both; }
```

---

## ③ 页面切换(rail 点导航)

不做真离场动画(无 JSX、无动画库,延迟卸载要写双缓冲,不值)。做"假两段":

1. 点击导航,旧 `.u-page` 加 `.is-leaving`(90ms 纯淡出 + pointer-events 锁死);
2. setTimeout 90ms 后换内容、换 `key`(保证 React 重挂载)、`scrollTop=0`、加 `.is-entering`;
3. 新页首帧必然 opacity:0(`animation-fill-mode: both` 保证),卸载与挂载同帧完成,中间无空帧——这三点就是"不闪"的全部。

```css
.u-page.is-leaving {
  animation: u-page-out 90ms cubic-bezier(0.4, 0, 1, 1) both;
  pointer-events: none;
}
@keyframes u-page-out {
  to { opacity: 0; transform: translateY(-4px); }
}

/* 方向感:JS 比较新旧导航 index,往下走 dir=fwd(默认,从下方 8px 进),往上走 dir=back */
.u-page[data-dir="back"].is-entering .u-stagger-host > * { animation-name: u-rise-down; }
@keyframes u-rise-down {
  from { opacity: 0; transform: translateY(-8px); }
  to   { opacity: 1; transform: none; }
}
```

切换总账:90ms 离场 + 120ms 级联窗口 + 180ms 时长 = 390ms,比开场轻一档,符合"第二次见面话少一点"。

**展开/收起**(谱系行三段详情、计划页步骤):高度动画被禁,策略是**高度瞬时跳变 + 内容三段 30ms 级联淡入**——高度跳变被紧跟的内容动效掩护,观感是"打开"而非"跳动"。收起瞬时,无离场。

```css
.u-detail.is-open > * { animation: u-rise 160ms var(--u-ease-swift) both; }
.u-detail.is-open > :nth-child(1) { animation-delay: 0ms; }
.u-detail.is-open > :nth-child(2) { animation-delay: 30ms; }
.u-detail.is-open > :nth-child(3) { animation-delay: 60ms; }
```

---

## ④ 状态变迁(排队→运行→完成/失败)

状态类四件套 `.is-queued / .is-running / .is-ok / .is-fail` 同时挂在 `.u-dot` 和所在行上。**每个状态的 animation-name 不同,类切换即自动重播一次性动效,零 JS 重触发**。

**点(.u-dot,需 position: relative)**:

```css
.u-dot.is-queued { opacity: 0.4; }  /* 静止,低存在感 */

.u-dot.is-running {
  color: var(--dsw-alias-state-business-primary);
  animation: u-heartbeat 2400ms ease-in-out infinite;  /* 常驻,仅运行态 */
}
.u-dot.is-running::after {  /* 扩散环,与心跳同周期 */
  content: ""; position: absolute; inset: -2px; border-radius: 50%;
  border: 1px solid currentColor;
  animation: u-ring 2400ms var(--u-ease-swift) infinite;
}
@keyframes u-heartbeat {
  0%, 100% { transform: scale(1); opacity: 1; }
  50%      { transform: scale(0.82); opacity: 0.65; }
}
@keyframes u-ring {
  from { transform: scale(1); opacity: 0.5; }
  to   { transform: scale(2.2); opacity: 0; }
}

.u-dot.is-ok {
  color: var(--dsw-alias-state-success-primary);
  animation: u-pop 300ms var(--u-ease-pop) 1;  /* 一次过冲后静止 */
}
@keyframes u-pop {
  0%   { transform: scale(0.4); }
  70%  { transform: scale(1.25); }
  100% { transform: scale(1); }
}

.u-dot.is-fail {
  color: var(--dsw-alias-state-error-primary);
  animation: u-shake 360ms var(--u-ease-swift) 1;
}
@keyframes u-shake {
  0%, 100% { transform: translateX(0); }
  20% { transform: translateX(-3px); }
  40% { transform: translateX(3px); }
  60% { transform: translateX(-2px); }
  80% { transform: translateX(2px); }
}
```

**行(swarm 行 / 谱系 Job 卡)**:终态一次性底色闪光,用 ::before 叠层做 opacity 动画绕开背景色动画禁令:

```css
.u-row { position: relative; }
.u-row::before {
  content: ""; position: absolute; inset: 0; border-radius: inherit;
  pointer-events: none; opacity: 0;
  background: color-mix(in oklch, var(--dsw-alias-state-success-primary) 12%, transparent);
}
.u-row.is-fail::before {
  background: color-mix(in oklch, var(--dsw-alias-state-error-primary) 14%, transparent);
}
.u-row.is-ok::before  { animation: u-row-flash 600ms ease-out 1; }
.u-row.is-fail::before { animation: u-row-flash 600ms ease-out 1; }
@keyframes u-row-flash {
  0%   { opacity: 0; }
  25%  { opacity: 1; }
  100% { opacity: 0; }
}
```

**状态词**(排队中/运行中/已完成):JS 在文本变更时给词 span 加 `.is-bump`,animationend 摘除:

```css
.u-status-word { display: inline-block; }
.u-status-word.is-bump { animation: u-word-in 200ms var(--u-ease-swift) 1; }
@keyframes u-word-in {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: none; }
}
```

**进度条**:填充用 scaleX(宽度动画被禁),JS 只写一个 CSS 变量;运行中微光挂在轨道上、仅 `.is-running` 存在:

```css
.u-progress { position: relative; overflow: hidden; }
.u-progress-fill {
  transform-origin: left center;
  transform: scaleX(var(--u-p, 0));  /* JS: el.style.setProperty('--u-p', done/total) */
  transition: transform var(--u-dur-slow) var(--u-ease-swift);
}
.u-progress.is-running::after {
  content: ""; position: absolute; inset: 0;
  background: linear-gradient(90deg, transparent,
    color-mix(in oklch, var(--dsw-alias-state-business-primary) 25%, transparent), transparent);
  transform: translateX(-100%);
  animation: u-sheen 2400ms ease-in-out infinite;
}
@keyframes u-sheen {
  from { transform: translateX(-100%); }
  to   { transform: translateX(100%); }
}
```

**侧栏入口按钮小点**:弹入一次;运行=蓝+心跳;失败=红+静止(失败不是运行态,常驻动画禁用,这条红线要在 code review 里守住):

```css
.u-entry { position: relative; }
.u-entry-dot {
  position: absolute; top: 2px; right: 2px;
  width: 7px; height: 7px; border-radius: 50%;
  animation: u-pop 300ms var(--u-ease-pop) 1;
}
.u-entry-dot.is-running {
  background: var(--dsw-alias-state-business-primary);
  animation: u-pop 300ms var(--u-ease-pop) 1,
             u-heartbeat 2400ms ease-in-out 300ms infinite;
}
.u-entry-dot.is-fail {
  background: var(--dsw-alias-state-error-primary);
  animation: u-pop 300ms var(--u-ease-pop) 1;  /* 弹入后静止 */
}
```

---

## Wow 时刻:全局同频心跳(半天可落地)

**效果**:所有"运行中"指示——swarm 卡里的 `.u-dot`、谱系页 Job 卡的点、rail 上的 `.u-nav-badge`、侧栏入口的小蓝点——**在同一相位上脉动**。用户开着浮层瞥一眼聊天流,两处蓝点同起同落;这在别的工具里从未见过,一眼读出"这是同一个活系统",且零新增依赖、keyframes 全部复用上面已有的 `u-heartbeat`。

**实现**:CSS 动画各自 start time 不同导致相位散乱,用负 animation-delay 把所有实例锁到同一条虚拟时间线:

```js
const U_PULSE_MS = 2400;  // 与 CSS 周期常量保持一致,只此一处硬编码

// 任何元素获得 .is-running 时调用一次(ref callback / 挂载回调里,不依赖 JSX)
function syncPulse(el) {
  const phase = -(performance.now() % U_PULSE_MS);
  el.style.animationDelay = `${phase}ms`;
}
```

三个注意点:
1. **多动画元素**(入口小点是 pop+heartbeat 两条)delay 要逐条给:`el.style.animationDelay = '0ms, ' + phase + 'ms'`,顺序对应 animation 简写里的声明序。
2. **::after 扩散环**收不到内联 delay,把相位写到元素 CSS 变量再引用:JS 写 `el.style.setProperty('--u-phase', phase + 'ms')`,CSS 里 `.u-dot.is-running, .u-dot.is-running::after { animation-delay: var(--u-phase, 0ms); }`。
3. React 重挂载会重置相位,所以 syncPulse 必须在挂载回调里调而不是只在状态切换时调。

rail 徽章加入同一节拍:

```css
.u-nav-badge.is-running { animation: u-heartbeat 2400ms ease-in-out infinite; }
```

`u-sheen`(进度微光)周期同为 2400ms,经同一 syncPulse 处理后与心跳同呼吸,进度条的光扫过恰逢点的收缩——这是整个方向名「共息」的字面兑现。

---

## ⑤ prefers-reduced-motion 降级完整清单

| 动效 | 降级 |
|------|------|
| 开场四层时序 | 全部退化为 90ms 纯淡入,delay 归零(同帧出现) |
| 列表级联 / 新行进场 / 展开三段 | 同上,无位移无级联 |
| 页面切换离场 | 移除;JS 定时器无需分支,旧页多显示 90ms 后瞬切 |
| 心跳 / 扩散环 / 进度微光(全部常驻) | 移除;运行态靠满不透明度品牌蓝 vs 排队态 0.4 透明度 + 状态词区分 |
| pop / shake / 行闪 / 状态词 bump(一次性) | 移除;状态靠颜色与文字表达 |
| 进度条 scaleX 过渡 | 移除,直接跳变 |
| 按压 transition | 移除 |

```css
@media (prefers-reduced-motion: reduce) {
  /* 1. 入场全部退化为纯淡入,取消级联与位移 */
  .u-veil, .u-modal, .u-rail .u-nav,
  .is-entering .u-stagger-host > *, .u-stagger-host > .is-new,
  .u-swarm.is-entering .u-row, .u-detail.is-open > * {
    animation-name: u-fade-in !important;
    animation-duration: 90ms !important;
    animation-delay: 0ms !important;
  }
  /* 2. 常驻动画一律移除 */
  .u-dot.is-running, .u-dot.is-running::after,
  .u-entry-dot.is-running, .u-nav-badge.is-running { animation: none !important; }
  .u-progress.is-running::after { animation: none !important; content: none !important; }
  /* 3. 一次性状态动效移除 */
  .u-dot.is-ok, .u-dot.is-fail, .u-entry-dot,
  .u-row.is-ok::before, .u-row.is-fail::before,
  .u-status-word.is-bump, .u-page.is-leaving { animation: none !important; }
  /* 4. 过渡类移除 */
  .u-progress-fill, .u-nav, .u-page tr, .u-swarm .u-row { transition: none !important; }
}
```

---

## 面 × 规范映射(工程对照用)

| 面 | 命中条目 |
|----|----------|
| AgOS 控制台 | ① 开场时序全部;② `.u-stagger-host` 每页一层;③ 页面切换 + 展开三段;④ `.u-dot` 状态机、`.u-nav-badge` 心跳;wow 同频 |
| swarm 进度卡 | ② N=4 短级联;④ 进度条 scaleX+sheen、行闪、状态词 bump、点状态机;wow 同频 |
| 侧栏入口按钮 | ④ `.u-entry-dot` 弹入/心跳/失败静止;wow 同频(与浮层内所有点同相) |

**JS 挂点汇总**(共 5 处):浮层挂载加/摘 `.is-opening`+`.is-entering`(700ms);导航 onClick 的 90ms 假两段 + `data-dir`;新行 `.is-new` 加/摘;状态词 `.is-bump` 加/摘;`syncPulse()` 于一切 `.is-running` 挂载处。