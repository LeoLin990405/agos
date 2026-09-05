# AgOS 动效规范 —— 对齐 Kimi / Manus(从 App 真实产物提取)

2026-09-05 · 数据源:`Kimi.app` / `Manus.app` 的 `app.asar` 实提取(cubic-bezier / @keyframes / duration+easing 配对),非目测。live 驱动被 Leo 当前全屏 Space 挡住,但 bundle 提取本就是动效的权威真值(精确到曲线参数)。

## 一、两家的动效"基因"(实测)

### Kimi(签名 = 快、干脆的减速)
| 层级 | 时长 × 缓动(命中次数) | 用途 |
|---|---|---|
| 微交互(hover/press/focus) | **.12s / .15s ease**(42/64) | 按钮、图标、列表项状态 |
| 标准过渡 | **.2s ease / .2s ease-in-out** | 显隐、tab |
| 面板/大过渡 | **.3s ease-in-out** | 抽屉、侧栏 |
| **签名入场** | **.18–.24s `cubic-bezier(.2,0,0,1)`**(Kimi 主曲线,命中最高) | 卡片/消息/浮层入场 |
| 戏剧化揭示 | **.18s `cubic-bezier(.23,1,.32,1)`**(ease-out-quint) | 强调性揭示 |
| 循环 | **.8s / 1s linear** | spinner、shimmer |

签名关键帧(实体):
- `rise-enter` = `opacity 0→1 + translateY(10px)→0 + scale(.98)→1`(**上浮+落定**,消息/卡片/浮层)
- `surface-enter/exit` = 纯 opacity 淡入淡出,`.24s cubic-bezier(.2,0,0,1)`
- `shimmer` = `background-position 100%→-100%`(骨架加载扫光)
- `fade-in` = `opacity .6→1`(聊天消息,克制)
- 还有:`composerShadowOrbit`/`beam-orbit`(输入区光环)、`dictation-burst`(语音)、`circle-reveal`(主题切换圆形揭示)、`conversation-title-marquee`、大量 `*-shimmer`(plan/tool/think/swarm 各态加载)

### Manus(签名 = 慢、顺滑 + 偶尔回弹)
| 层级 | 时长 × 缓动(命中次数) | 用途 |
|---|---|---|
| 微交互 | **.1s ease-out** | 极快反馈 |
| 标准 | **.2s ease-out / .25s ease-in-out** | 显隐、tab |
| 面板 | **.4–.5s `cubic-bezier(.33,1,.68,1)`**(ease-out-cubic) | 抽屉展开/收起 |
| **签名顺滑** | **.8s `cubic-bezier(.26,.86,.44,.985)`**(慢速高级感减速) | 大面积转场 |
| 回弹强调 | **`cubic-bezier(.34,1.56,.64,1)`**(back,>1 过冲) | 徽章/成功态 |
| 环境循环 | **2s–4s linear / ease-in-out** | 呼吸、渐变漂移 |

签名关键帧(实体):
- `db-fade-in-up` = `opacity 0→1 + translateY(4px)→0`(比 Kimi 更小位移,更含蓄)
- `scale-fade-in` = `100px→100%` 尺寸生长(画布/面板展开)
- `ap-pop` = `scale(0)→1.2→1`(**过冲弹出**,配 back 曲线,徽章/标记)
- `breathe` = `opacity 0→.05→0`(极淡环境脉动背景)
- `tipIn` = tooltip `translateY(8px) scale(.92)→(0) scale(1)` + fade
- `ap-*` 一整套媒体动画预设(fade/grow/ken-burns/pan/pop/slide/spin/wipe/zoom…)、`drawerExpand/Collapse`、`recording-pulse`

## 二、两家对比(定调)

| 维度 | Kimi | Manus | AgOS 取向 |
|---|---|---|---|
| 性格 | 快、干脆、工具感 | 慢、顺滑、产品感 | **以 Kimi 为主干**(AgOS 是重工具面板),Manus 的顺滑/回弹用于**少数强调点** |
| 主曲线 | `cubic-bezier(.2,0,0,1)` | `cubic-bezier(.4,0,.2,1)` + 顺滑自定义 | 主曲线取 **Kimi 的 .2,0,0,1** |
| 入场位移 | 10px + scale(.98) | 4px | 取中:**8px + scale(.98)** |
| 回弹 | 几乎不用 | ap-pop 过冲 | **仅成功/徽章**用一次 back |
| 加载 | 大量 shimmer 扫光 | shimmer + breathe | shimmer 为主(AgOS 已有 swarm/plan shimmer 语汇) |

## 三、AgOS 统一动效 token(建议写入 design-system/tokens.css)

```css
:root {
  /* 时长 */
  --dur-micro: 130ms;     /* hover/press/focus —— Kimi .12–.15s 折中 */
  --dur-fast: 180ms;      /* 小显隐 */
  --dur-base: 220ms;      /* 标准过渡(AgOS 默认) */
  --dur-panel: 300ms;     /* 抽屉/侧栏/大面板 */
  --dur-slow: 460ms;      /* 大转场(慎用) */
  --dur-ambient: 2400ms;  /* 呼吸/环境循环 */
  --dur-loop: 1000ms;     /* spinner */
  --dur-shimmer: 1400ms;  /* 骨架扫光 */

  /* 缓动 */
  --ease-out: cubic-bezier(.2, 0, 0, 1);        /* AgOS 主曲线(Kimi 签名):入场/显隐/移动默认 */
  --ease-reveal: cubic-bezier(.23, 1, .32, 1);  /* 戏剧化揭示(ease-out-quint) */
  --ease-smooth: cubic-bezier(.26, .86, .44, .985); /* Manus 顺滑,大转场 */
  --ease-back: cubic-bezier(.34, 1.56, .64, 1); /* 回弹过冲,仅成功/徽章 */
  --ease-standard: cubic-bezier(.4, 0, .2, 1);  /* 双向对称(展开+收起同用) */
}

/* 签名入场:上浮+落定(Kimi rise-enter × Manus 含蓄位移的折中) */
@keyframes agos-rise-in { from { opacity: 0; transform: translateY(8px) scale(.98) } to { opacity: 1; transform: none } }
/* 纯淡入(消息级,克制) */
@keyframes agos-fade-in { from { opacity: .6 } to { opacity: 1 } }
/* 骨架扫光 */
@keyframes agos-shimmer { from { background-position: 100% } to { background-position: -100% } }
/* 成功/徽章过冲弹出(唯一 back 用处) */
@keyframes agos-pop { 0% { transform: scale(0) } 70% { transform: scale(1.2) } 100% { transform: scale(1) } }
/* 环境呼吸(背景/在跑态,极淡) */
@keyframes agos-breathe { 0%,100% { opacity: .0 } 50% { opacity: .06 } }
```

用法约定:
- 卡片/浮层/消息入场 → `animation: agos-rise-in var(--dur-base) var(--ease-out) both`
- hover/press → `transition: … var(--dur-micro) var(--ease-out)`
- 抽屉/侧栏 → `transition: … var(--dur-panel) var(--ease-standard)`(展开收起对称)
- 大面积转场(如控制台切页)→ `var(--dur-slow) var(--ease-smooth)`
- 加载:shimmer 扫光 `var(--dur-shimmer) linear infinite`;spinner `var(--dur-loop) linear infinite`;在跑态背景 `agos-breathe var(--dur-ambient) ease-in-out infinite`
- **`prefers-reduced-motion`**:所有位移/缩放降级为纯 opacity 或直接终态(AgOS 现有灯语/共息纪律已有此约束,延续)

## 四、待补(需 Leo 退出全屏 Space 后 live 采集)
- 逐交互的**在场录制**(消息流式、模式切换圆形揭示、语音 dictation-burst、swarm 单元 shimmer 编排)——bundle 给了参数与关键帧,live 能补"哪个元素、什么触发、连贯观感"。
- Manus 的"虚拟电脑"任务态动效(需跑任务,会耗额度,单独确认再采)。
