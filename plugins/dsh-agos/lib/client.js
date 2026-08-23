window.__ModuleLoader__.load({
	id: "@dsh-local/agos",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const React = require("react");
		const h = React.createElement;

		// ── AgOS-lite 控制台(C4,2026-08-20)──────────────────────────────────
		// 会话无关的 OS 级入口:sidebar.footer.action(list/root,Settings 旁的动作位)放按钮,
		// shell.overlay(list/root,AppFrame 的全帧浮层,click-through)放全屏控制台面板。
		// 面板 register 时在 children 表声明自己的子槽 **agos.section**(list/root)——
		// 各插件(fleet 的「机器」、本插件的「会话总览」,以后谱系/计划)往里注册 section,
		// 面板按 order 堆叠渲染。0 shell patch:两个宿主槽位 rc.6 与 HEAD 都存在(源码 recon 实证)。
		// ⚠️ renderSlot 授权是 owner 化的:只有声明者能渲染自己的 child —— 所以 agos.section
		//    必须由本面板声明、本面板渲染;别的插件只投稿。

		// ── i18n(照抄 fleet:宿主 locale 服务 + 回落字典)──────────────────
		const NS = "dsh-agos";
		let LOCALE = null;
		const DICT = {
			zh: {
				"btn": "AgOS",
				"btn.aria": "打开 AgOS 控制台",
				"title": "AgOS 控制台",
				"subtitle": "会话无关的全局视图:机器、会话、计划。各 section 由对应插件贡献。",
				"close": "关闭",
				"empty": "还没有任何 section(插件通过 agos.section 槽贡献内容)",
				"sess.title": "会话总览",
				"sess.refresh": "刷新",
				"sess.loading": "读取中…",
				"sess.error": "读不到会话列表:{err}",
				"sess.empty": "还没有会话",
				"sess.col.title": "标题",
				"sess.col.model": "模型",
				"sess.col.turns": "轮·步",
				"sess.col.tokens": "↑入 ↓出",
				"sess.col.cost": "费用",
				"sess.col.when": "时间",
				"sess.untitled": "(未命名)",
				"sess.count": "{n} 个会话 · 显示最近 {m}",
				"sess.col.dur": "用时",
				"sess.openHint": "点击打开该会话",
				"lin.title": "活跃谱系",
				"lin.sub": "最近 10 分钟内 swarm / civ / fleet / plan_run 派出的子代理(谁派的、谁在跑、跑在哪)",
				"lin.refresh": "刷新",
				"lin.empty": "最近 10 分钟没有子代理活动 —— swarm/civ/fleet 一开跑,这里就能看到派单谱系",
				"lin.call": "调用 {id}",
				"lin.parent": "父会话 {sid}",
				"lin.ago": "{s} 秒前",
				"lin.agoMin": "{m} 分钟前",
				"lin.statPlain": "{done}/{total} 完成 · {running} 在跑",
				"lin.alive": "活",
				"lin.stopped": "已停",
				"plan.title": "计划",
				"plan.refresh": "刷新",
				"plan.loading": "读取中…",
				"plan.error": "读不到计划:{err}",
				"plan.empty": "还没有计划(plan_run 出计划或计划模式批准后,这里能看到档案)",
				"plan.src.planmode": "计划模式",
				"plan.src.planrun": "plan_run",
				"plan.st.executed": "已执行",
				"plan.st.approved": "已批准",
				"plan.st.draft": "草稿",
				"plan.steps": "{n} 步",
				"plan.col.goal": "目标",
				"plan.col.src": "来源",
				"plan.col.planner": "计划者",
				"plan.col.state": "状态",
				"plan.col.when": "时间",
				"plan.review": "验收",
				"plan.noGoal": "(未写目标)",
				"sk.title": "技能",
				"sk.sub": "skill-librarian 审计:重复 / 碰撞 / 死链 / 弱描述 / stub(只读,不改文件)",
				"sk.refresh": "重新审计",
				"sk.loading": "审计中…",
				"sk.error": "审计失败:{err}",
				"sk.skills": "{n} 个技能",
				"sk.clean": "全部通过 ✓",
				"sk.all": "全部",
				"sk.more": "还有 {n} 条(按类别筛选查看)",
				"nav.overview": "概览",
				"nav.machines": "机器",
				"nav.sessions": "会话",
				"nav.lineage": "谱系",
				"nav.plans": "计划",
				"nav.skills": "技能",
				"ov.attention": "需要关注",
				"ov.attentionEmpty": "没有需要关注的任务",
				"ov.running": "{n} 个子任务在跑",
				"ov.failedRow": "失败",
				"ov.runningRow": "在跑",
				"ov.kpi.sessions": "会话",
				"ov.kpi.plans": "计划",
				"ov.kpi.plansSub": "{e} 已执行",
				"ov.kpi.skills": "技能",
				"ov.kpi.skillsSub": "warn {w}",
				"ov.kpi.lineage": "活跃派单",
				"ov.kpi.lineageSub": "{r} 在跑",
				"ov.ext": "扩展",
				"lin.st.queued": "等待中",
				"lin.st.running": "处理中",
				"lin.st.completed": "已完成",
				"lin.st.failed": "未成功",
				"lin.st.aborted": "已中止",
				"lin.queuedN": "{n} 排队",
				"lin.detail.status": "状态",
				"lin.detail.task": "委派的任务",
				"lin.detail.result": "最终回复",
				"lin.detail.resultLoading": "正在加载最终回复…",
				"lin.detail.resultNone": "暂无最终响应。",
				"lin.detail.resultRunning": "子任务仍在处理中,完成后可查看最终回复。",
				"lin.stop": "停止",
				"lin.stopAll": "全部停止",
			},
			en: {
				"btn": "AgOS",
				"btn.aria": "Open the AgOS console",
				"title": "AgOS Console",
				"subtitle": "Session-independent global views: machines, sessions, plans. Sections are contributed by their owning plugins.",
				"close": "Close",
				"empty": "No sections yet (plugins contribute via the agos.section slot)",
				"sess.title": "Sessions",
				"sess.refresh": "Refresh",
				"sess.loading": "Loading…",
				"sess.error": "Cannot read sessions: {err}",
				"sess.empty": "No sessions yet",
				"sess.col.title": "Title",
				"sess.col.model": "Model",
				"sess.col.turns": "Turns·Steps",
				"sess.col.tokens": "↑in ↓out",
				"sess.col.cost": "Cost",
				"sess.col.when": "When",
				"sess.untitled": "(untitled)",
				"sess.count": "{n} sessions · showing latest {m}",
				"sess.col.dur": "Took",
				"sess.openHint": "Click to open this session",
				"lin.title": "Live lineage",
				"lin.sub": "Subagents dispatched by swarm / civ / fleet / plan_run in the last 10 minutes (who spawned what, running where)",
				"lin.refresh": "Refresh",
				"lin.empty": "No subagent activity in the last 10 minutes — dispatch lineage shows up here as soon as swarm/civ/fleet runs",
				"lin.call": "call {id}",
				"lin.parent": "parent session {sid}",
				"lin.ago": "{s}s ago",
				"lin.agoMin": "{m}m ago",
				"lin.statPlain": "{done}/{total} done · {running} running",
				"lin.alive": "alive",
				"lin.stopped": "stopped",
				"plan.title": "Plans",
				"plan.refresh": "Refresh",
				"plan.loading": "Loading…",
				"plan.error": "Cannot read plans: {err}",
				"plan.empty": "No plans yet (plan_run drafts and approved plan-mode plans are archived here)",
				"plan.src.planmode": "plan mode",
				"plan.src.planrun": "plan_run",
				"plan.st.executed": "executed",
				"plan.st.approved": "approved",
				"plan.st.draft": "draft",
				"plan.steps": "{n} steps",
				"plan.col.goal": "Goal",
				"plan.col.src": "Source",
				"plan.col.planner": "Planner",
				"plan.col.state": "State",
				"plan.col.when": "When",
				"plan.review": "Review",
				"plan.noGoal": "(no goal)",
				"sk.title": "Skills",
				"sk.sub": "skill-librarian audit: dups / collisions / dead links / weak descriptions / stubs (read-only)",
				"sk.refresh": "Re-audit",
				"sk.loading": "Auditing…",
				"sk.error": "Audit failed: {err}",
				"sk.skills": "{n} skills",
				"sk.clean": "all clean ✓",
				"sk.all": "all",
				"sk.more": "{n} more (filter by check to see)",
				"nav.overview": "Overview",
				"nav.machines": "Machines",
				"nav.sessions": "Sessions",
				"nav.lineage": "Lineage",
				"nav.plans": "Plans",
				"nav.skills": "Skills",
				"ov.attention": "Needs attention",
				"ov.attentionEmpty": "Nothing needs your attention",
				"ov.running": "{n} subtasks running",
				"ov.failedRow": "failed",
				"ov.runningRow": "running",
				"ov.kpi.sessions": "Sessions",
				"ov.kpi.plans": "Plans",
				"ov.kpi.plansSub": "{e} executed",
				"ov.kpi.skills": "Skills",
				"ov.kpi.skillsSub": "warn {w}",
				"ov.kpi.lineage": "Active dispatch",
				"ov.kpi.lineageSub": "{r} running",
				"ov.ext": "Extensions",
				"lin.st.queued": "Waiting",
				"lin.st.running": "Working",
				"lin.st.completed": "Done",
				"lin.st.failed": "Failed",
				"lin.st.aborted": "Aborted",
				"lin.queuedN": "{n} queued",
				"lin.detail.status": "Status",
				"lin.detail.task": "Delegated task",
				"lin.detail.result": "Final response",
				"lin.detail.resultLoading": "Loading final response…",
				"lin.detail.resultNone": "No final response yet.",
				"lin.detail.resultRunning": "Subtask is still working; the final response appears once it finishes.",
				"lin.stop": "Stop",
				"lin.stopAll": "Stop all",
			},
		};
		const fallbackT = (k, params) => {
			let v = DICT.zh[k] ?? k;
			if (params) v = v.replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m));
			return v;
		};
		function useT() {
			React.useSyncExternalStore(
				(fn) => (LOCALE ? LOCALE.subscribe(fn) : () => {}),
				() => (LOCALE ? LOCALE.getSnapshot() : null),
				() => null,
			);
			return LOCALE ? LOCALE.bind(NS) : fallbackT;
		}

		// ── 宿主 sessions 服务(v5:会话行 Job 卡化——点行 open() 切会话;apply 时捕获)──
		let SESSIONS = null;
		// ── 开关态(模块级 pub/sub:按钮与面板是两个不同槽里的组件,共享这份)──
		let OPEN = false;
		const openListeners = new Set();
		const setOpen = (v) => { OPEN = !!v; for (const fn of openListeners) fn(); };
		const useOpen = () => React.useSyncExternalStore(
			(fn) => { openListeners.add(fn); return () => openListeners.delete(fn); },
			() => OPEN, () => false,
		);

		// ──「共息」锁相(TASK-2026-08-20-002):运行态循环动画负 delay 对齐全站相位 ──
		const U_PULSE_MS = 2400; // 与 ui-kit --u-t-loop 一致
		function syncPulse(el) { el.style.setProperty("--u-phase", -(performance.now() % U_PULSE_MS) + "ms"); }
		const pulseRef = (el) => { if (el) syncPulse(el); };
		// ── KPI 滚数:仅元素挂载时滚一次,之后轮询重渲染直写终值 ──
		function countUp(el, target) {
			if (matchMedia("(prefers-reduced-motion: reduce)").matches) { el.textContent = String(target); return; }
			const t0 = performance.now(), D = 320;
			requestAnimationFrame(function tick(t) {
				const p = Math.min(1, (t - t0) / D), e = 1 - Math.pow(1 - p, 3);
				el.textContent = String(Math.round(target * e));
				if (p < 1) requestAnimationFrame(tick);
			});
		}

		// ── 样式(独立 style 标签;全部取 ui-kit/宿主令牌,零硬编码色)─────────
		const CSS = [
			// v3 起面板/导航/页/区块原语全部来自 ui-kit(u-veil/u-modal/u-rail/u-nav/u-page/u-sec…),
			// 本插件只留自己特有的:侧栏入口按钮。
			".agos-btn{ position:relative;display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;min-width:28px;padding:0 8px;border:1px solid transparent;border-radius:var(--u-r-md,7px);background:transparent;color:var(--u-fg3,inherit);cursor:pointer;font:inherit;font-size:var(--u-fz-b,12px);transition:transform 90ms var(--u-ease,ease-out);}",
			".agos-btn:active{ transform:scale(.92);}",
			".agos-btn.is-open{ box-shadow:inset 0 0 0 1px color-mix(in oklch,var(--u-accent) 55%,transparent);}",
			".agos-btn:hover{ background:var(--u-hover,rgba(127,127,127,.12));color:var(--u-fg,inherit);}",
			".agos-btn:focus-visible{ outline:2px solid var(--u-accent);outline-offset:1px;}",
			".agos-btn.is-rail{ padding:0;width:28px;}",
		].join("\n");
		const injectStyle = () => {
			const tagId = "@dsh-local/agos/console.css";
			if (typeof document === "undefined" || document.querySelector('style[data-plugin-css="' + tagId + '"]') !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-agos";
			tag.dataset.pluginCss = tagId;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		};

		// ── 侧栏按钮(sidebar.footer.action;owner props = { wide })────────────
		// v4 注意力点(Claude idle 通知/Trae 托盘思路的最小版):30s 轻轮询 overview,
		// 有 failed 子任务 → 红点;有 running → 蓝呼吸点;都无 → 不显示。
		// overview 是纯内存+小文件读的廉价端点,30s 一次可忽略不计。
		function AgosButton({ wide }) {
			const t = useT();
			const openNow = useOpen();
			const [att, setAtt] = React.useState({ running: 0, failed: 0 });
			React.useEffect(() => {
				let alive = true;
				const poll = () => fetch("/api/agos/overview").then((r) => r.json())
					.then((d) => { if (alive && d.lineage) setAtt({ running: d.lineage.running || 0, failed: d.lineage.failed || 0 }); })
					.catch(() => {});
				poll();
				const id = setInterval(poll, 30000);
				return () => { alive = false; clearInterval(id); };
			}, []);
			const dot = att.failed > 0 ? "u-alert is-bad" : att.running > 0 ? "u-alert is-run" : null;
			return h("button", {
				type: "button",
				className: "agos-btn" + (wide ? "" : " is-rail") + (openNow ? " is-open" : ""),
				"aria-label": t("btn.aria"),
				title: t("btn.aria"),
				onClick: () => setOpen(!OPEN),
			}, "🧭",
				wide ? h("span", null, t("btn")) : null,
				dot ? h("span", { className: dot, ref: pulseRef }) : null);
		}

		// ── 会话总览 section(本插件自己贡献进 agos.section)─────────────────
		const fmtWhen = (ts) => {
			if (!ts) return "—";
			const d = new Date(ts);
			const p = (n) => String(n).padStart(2, "0");
			return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
		};
		const fmtDur = (ms) => {
			const n = Number(ms) || 0;
			if (n <= 0) return "—";
			if (n < 60000) return (n / 1000).toFixed(0) + "s";
			if (n < 3600000) return (n / 60000).toFixed(1) + "m";
			return (n / 3600000).toFixed(1) + "h";
		};
		const fmtTok = (n) => {
			if (!n) return "0";
			if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
			if (n >= 1e3) return (n / 1e3).toFixed(0) + "k";
			return String(n);
		};
		const SESS_SHOW = 15;
		function SessionsSection() {
			const t = useT();
			const [state, setState] = React.useState({ loading: true, error: null, sessions: [] });
			const load = React.useCallback(() => {
				setState((s) => ({ ...s, loading: true, error: null }));
				fetch("/api/trace/sessions")
					.then((r) => r.json())
					.then((d) => setState({ loading: false, error: d.error || null, sessions: Array.isArray(d.sessions) ? d.sessions : [] }))
					.catch((e) => setState({ loading: false, error: String((e && e.message) || e), sessions: [] }));
			}, []);
			React.useEffect(() => { load(); }, [load]);
			const rows = state.sessions.slice(0, SESS_SHOW);
			return h("div", { className: "u-sec" },
				h("div", { className: "u-row", style: { justifyContent: "space-between" } },
					h("span", { className: "u-title" }, t("sess.title")),
					h("span", { className: "u-meta u-num" },
						state.sessions.length ? t("sess.count", { n: state.sessions.length, m: rows.length }) : "",
						" ",
						h("button", { type: "button", className: "u-btn", onClick: load, disabled: state.loading }, t("sess.refresh")),
					),
				),
				h("div", { className: "u-sec-body" },
					state.loading ? h("div", { className: "u-empty" }, t("sess.loading"))
					: state.error ? h("div", { className: "u-empty u-err" }, t("sess.error", { err: state.error }))
					: rows.length === 0 ? h("div", { className: "u-empty" }, t("sess.empty"))
					: h("div", { className: "u-tablewrap" },
						h("table", { className: "u-table" },
							h("thead", null, h("tr", null,
								h("th", null, t("sess.col.title")),
								h("th", null, t("sess.col.model")),
								h("th", { className: "u-num" }, t("sess.col.turns")),
								h("th", { className: "u-num" }, t("sess.col.tokens")),
								h("th", { className: "u-num" }, t("sess.col.cost")),
								h("th", { className: "u-num" }, t("sess.col.dur")),
								h("th", { className: "u-num" }, t("sess.col.when")),
							)),
							h("tbody", { className: "u-stagger-host" }, rows.map((s) => h("tr", {
								key: s.id,
								// v5 Job 卡化(Codex taskRow):点行 = 打开该会话(宿主 sessions.open,id 须在列表 store;
								// 裸 id 不认就试 rawId),并收起控制台 —— 控制台兼作会话切换器。
								style: SESSIONS ? { cursor: "pointer" } : undefined,
								title: SESSIONS ? t("sess.openHint") : undefined,
								onClick: SESSIONS ? () => {
									try { SESSIONS.open(s.id); } catch { try { SESSIONS.open(s.rawId); } catch {} }
									setOpen(false);
								} : undefined,
							},
								h("td", { className: "u-grow", style: { maxWidth: "320px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: s.title || "" }, s.title || t("sess.untitled")),
								h("td", { className: "u-mono u-meta" }, s.model || "—"),
								h("td", { className: "u-num" }, (s.stats && s.stats.turns) || 0, " · ", (s.stats && s.stats.steps) || 0),
								h("td", { className: "u-num u-meta" }, "↑", fmtTok(s.tokens && s.tokens.input), " ↓", fmtTok(s.tokens && s.tokens.output)),
								h("td", { className: "u-num" }, s.cost != null ? "¥" + Number(s.cost).toFixed(2) : "—"),
								h("td", { className: "u-num u-meta" }, fmtDur(s.stats && (s.stats.settledMs || (s.stats.llmMs || 0) + (s.stats.toolMs || 0)))),
								h("td", { className: "u-num u-meta" }, fmtWhen(s.createdAt)),
							))),
						),
					),
				),
			);
		}

		// ── 活跃谱系 section(v2):/api/swarm/progress 全量 dump(10min TTL 的进程内表)──
		// 数据源 = swarm 的 PROGRESS(swarm/civ/fleet/plan_run 全走它发布进度)。
		// 只在面板打开(即本组件挂载)时每 4s 轮询;路由是纯内存读,零开销。
		const ago = (t, at) => {
			const s = Math.max(0, Math.round((Date.now() - (at || 0)) / 1000));
			return s < 60 ? t("lin.ago", { s }) : t("lin.agoMin", { m: Math.round(s / 60) });
		};
		const LIN_DOT = (st) => st === "running" ? "u-dot is-run" : st === "completed" ? "u-dot is-ok" : (st === "failed" || st === "aborted") ? "u-dot is-bad" : "u-dot";
		// 四态词表(Codex 官方中文:等待中/处理中/已完成/未成功;aborted 补已中止)
		const LIN_ST = (t, st) => st === "running" ? t("lin.st.running") : st === "completed" ? t("lin.st.completed") : st === "failed" ? t("lin.st.failed") : st === "aborted" ? t("lin.st.aborted") : t("lin.st.queued");
		const LIN_BADGE = (st) => st === "running" ? "u-badge is-accent" : st === "completed" ? "u-badge is-ok" : (st === "failed" || st === "aborted") ? "u-badge is-bad" : "u-badge";
		function LineageSection() {
			const t = useT();
			const [calls, setCalls] = React.useState(null);
			const [expanded, setExpanded] = React.useState(null); // "callId:index"
			const [results, setResults] = React.useState({});     // agentId -> {loading,text}
			const load = React.useCallback(() => {
				fetch("/api/swarm/progress").then((r) => r.json())
					.then((d) => setCalls(d.calls && typeof d.calls === "object" ? d.calls : {}))
					.catch(() => setCalls({}));
			}, []);
			React.useEffect(() => { load(); const id = setInterval(load, 4000); return () => clearInterval(id); }, [load]);
			// 展开详情时按需拉最终回复(每 agentId 只拉一次;Codex 三段式第三段)
			const fetchResult = React.useCallback((agentId) => {
				if (!agentId || results[agentId]) return;
				setResults((p) => ({ ...p, [agentId]: { loading: true, text: "" } }));
				fetch("/api/swarm/result?agentId=" + encodeURIComponent(agentId)).then((r) => r.json())
					.then((d) => setResults((p) => ({ ...p, [agentId]: { loading: false, text: String(d.text || "") } })))
					.catch(() => setResults((p) => ({ ...p, [agentId]: { loading: false, text: "" } })));
			}, [results]);
			const stopOne = (agentId, parentSessionId) => {
				fetch("/api/swarm/interrupt", { method: "POST", headers: { "content-type": "application/json" },
					body: JSON.stringify({ subagentId: agentId, parentSessionId }) }).then(load).catch(() => {});
			};
			const entries = calls ? Object.entries(calls).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)) : [];
			return h("div", { className: "u-sec" },
				h("div", { className: "u-row", style: { justifyContent: "space-between" } },
					h("span", null,
						h("span", { className: "u-title" }, t("lin.title")), " ",
						h("span", { className: "u-meta" }, t("lin.sub")),
					),
					h("button", { type: "button", className: "u-btn", onClick: load }, t("lin.refresh")),
				),
				h("div", { className: "u-sec-body" + (entries.length ? " u-lineage u-stagger-host" : "") },
					calls === null ? h("div", { className: "u-empty" }, "…")
					: entries.length === 0 ? h("div", { className: "u-empty" }, t("lin.empty"))
					: entries.map(([callId, v]) => {
						const rows = Array.isArray(v.rows) ? v.rows : [];
						const done = rows.filter((r) => r.status === "completed").length;
						const running = rows.filter((r) => r.status === "running").length;
						const queued = rows.filter((r) => r.status === "queued").length;
						const aliveRows = rows.filter((r) => r.alive && r.agentId && !r.stopped);
						const hasRun = rows.some((r) => r.status === "running");
							return h("div", { key: callId, className: "u-box u-job-card" + (hasRun ? " is-run" : ""), style: { margin: "8px 12px 8px 0" }, ref: hasRun ? pulseRef : undefined },
							h("div", { className: "u-row", style: { padding: 0, marginBottom: "6px", flexWrap: "wrap" } },
								h("span", { className: "u-strong u-mono" }, t("lin.call", { id: String(callId).slice(0, 8) })),
								v.parentSessionId ? h("span", { className: "u-meta u-mono" }, t("lin.parent", { sid: String(v.parentSessionId).slice(0, 8) })) : null,
								h("span", { className: "u-meta u-num" }, t("lin.statPlain", { done, total: rows.length, running })),
								queued ? h("span", { className: "u-badge u-num" }, t("lin.queuedN", { n: queued })) : null,
								aliveRows.length ? h("button", { type: "button", className: "u-btn is-stop", onClick: () => aliveRows.forEach((r) => stopOne(r.agentId, v.parentSessionId)) }, t("lin.stopAll")) : null,
								v.at ? h("span", { className: "u-meta u-num", style: { marginLeft: "auto" } }, ago(t, v.at)) : null,
							),
							h("div", { className: "u-list" }, rows.flatMap((r) => {
								const key = callId + ":" + r.index;
								const open = expanded === key;
								const rowEl = h("div", {
									key, className: "u-li" + (r.status === "failed" ? " is-bad" : "") + (open ? " is-on" : ""),
									style: { cursor: "pointer" }, "aria-expanded": open,
									onClick: () => { setExpanded(open ? null : key); if (!open && r.agentId && r.status === "completed") fetchResult(r.agentId); },
								},
									h("span", { className: LIN_DOT(r.status), ref: r.status === "running" ? pulseRef : undefined }),
									h("span", { className: "u-num u-meta" }, "#", r.index),
									r.type ? h("span", { className: "u-badge" }, r.type) : null,
									h("span", { className: "u-grow", title: r.item || "" }, r.item || "—"),
									r.host ? h("span", { className: "u-badge is-accent" }, "@", r.host)
										: (r.provider || r.model) ? h("span", { className: "u-meta u-mono" }, [r.provider, r.model].filter(Boolean).join("/")) : null,
									r.alive && !r.stopped ? h("span", { className: "u-badge is-ok" }, t("lin.alive")) : null,
									r.stopped ? h("span", { className: "u-badge is-bad" }, t("lin.stopped")) : null,
									r.elapsedMs ? h("span", { className: "u-meta u-num" }, (r.elapsedMs / 1000).toFixed(1), "s") : null,
								);
								if (!open) return [rowEl];
								// 三段式详情(Codex Subagents 面板:Status / Delegated task / Final response)
								const res2 = r.agentId ? results[r.agentId] : null;
								const detail = h("div", { key: key + ":d", className: "u-sub u-job-detail", style: { margin: "2px 8px 8px 22px" } },
									h("div", { className: "u-kv" }, h("span", { className: "u-k" }, t("lin.detail.status")),
										h("span", { className: "u-v" }, h("span", { className: LIN_BADGE(r.status) }, LIN_ST(t, r.status)),
											r.agentId && r.alive && !r.stopped ? h("button", { type: "button", className: "u-btn is-stop", style: { marginLeft: "8px" }, onClick: (e) => { e.stopPropagation(); stopOne(r.agentId, v.parentSessionId); } }, t("lin.stop")) : null)),
									h("div", { className: "u-microlabel", style: { marginTop: "8px" } }, t("lin.detail.task")),
									h("div", { className: "u-note", style: { whiteSpace: "pre-wrap" } }, r.item || "—"),
									h("div", { className: "u-microlabel", style: { marginTop: "8px" } }, t("lin.detail.result")),
									r.status === "running" || r.status === "queued"
										? h("div", { className: "u-note" }, t("lin.detail.resultRunning"))
										: !r.agentId ? h("div", { className: "u-note" }, t("lin.detail.resultNone"))
										: res2 && res2.loading ? h("div", { className: "u-note" }, t("lin.detail.resultLoading"))
										: res2 && res2.text ? h("div", { className: "u-pre" }, res2.text)
										: h("div", { className: "u-note" }, t("lin.detail.resultNone")),
								);
								return [rowEl, detail];
							})),
						);
					}),
				),
			);
		}

		// ── 计划 section(v2):/api/cn/plans 档案(plan_run 草稿 + 计划模式批准件)──
		function PlansSection() {
			const t = useT();
			const [state, setState] = React.useState({ loading: true, error: null, plans: [] });
			const [openFiles, setOpenFiles] = React.useState(() => new Set());
			const load = React.useCallback(() => {
				setState((s) => ({ ...s, loading: true, error: null }));
				fetch("/api/cn/plans").then((r) => r.json())
					.then((d) => setState({ loading: false, error: d.error || null, plans: Array.isArray(d.plans) ? d.plans : [] }))
					.catch((e) => setState({ loading: false, error: String((e && e.message) || e), plans: [] }));
			}, []);
			React.useEffect(() => { load(); }, [load]);
			const toggle = (file) => setOpenFiles((prev) => { const n = new Set(prev); n.has(file) ? n.delete(file) : n.add(file); return n; });
			const srcBadge = (p) => {
				const src = p.source || (p.planner === "plan-mode" ? "plan-mode" : "plan_run");
				return src === "plan-mode" ? t("plan.src.planmode") : t("plan.src.planrun");
			};
			const stBadge = (p) => p.executedAt ? ["is-ok", t("plan.st.executed")] : p.approvedAt ? ["is-accent", t("plan.st.approved")] : ["", t("plan.st.draft")];
			return h("div", { className: "u-sec" },
				h("div", { className: "u-row", style: { justifyContent: "space-between" } },
					h("span", { className: "u-title" }, t("plan.title")),
					h("button", { type: "button", className: "u-btn", onClick: load, disabled: state.loading }, t("plan.refresh")),
				),
				h("div", { className: "u-sec-body" },
					state.loading ? h("div", { className: "u-empty" }, t("plan.loading"))
					: state.error ? h("div", { className: "u-empty u-err" }, t("plan.error", { err: state.error }))
					: state.plans.length === 0 ? h("div", { className: "u-empty" }, t("plan.empty"))
					: h("div", { className: "u-tablewrap" },
						h("table", { className: "u-table" },
							h("thead", null, h("tr", null,
								h("th", null, t("plan.col.goal")),
								h("th", null, t("plan.col.src")),
								h("th", null, t("plan.col.planner")),
								h("th", { className: "u-num" }, ""),
								h("th", null, t("plan.col.state")),
								h("th", { className: "u-num" }, t("plan.col.when")),
							)),
							h("tbody", null, state.plans.flatMap((p) => {
								const [stCls, stTxt] = stBadge(p);
								const steps = Array.isArray(p.steps) ? p.steps : [];
								const open = openFiles.has(p.file);
								const main = h("tr", { key: p.file, onClick: () => toggle(p.file), style: { cursor: "pointer" }, "aria-expanded": open },
									h("td", { className: "u-grow", style: { maxWidth: "340px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }, title: p.goal || p.name }, p.goal || t("plan.noGoal")),
									h("td", null, h("span", { className: "u-badge" }, srcBadge(p))),
									h("td", { className: "u-mono u-meta" }, p.planner || "—"),
									h("td", { className: "u-num u-meta" }, t("plan.steps", { n: steps.length })),
									h("td", null, h("span", { className: "u-badge " + stCls }, stTxt)),
									h("td", { className: "u-num u-meta" }, fmtWhen(Date.parse(p.executedAt || p.approvedAt || p.editedAt || "") || null)),
								);
								if (!open) return [main];
								const detail = h("tr", { key: p.file + ":d" }, h("td", { colSpan: 6 },
									h("div", { className: "u-list", style: { padding: "4px 0" } }, steps.map((st2) => h("div", { key: st2.id, className: "u-li" },
										h("span", { className: "u-num u-meta" }, st2.id, "."),
										h("span", { className: "u-grow" }, st2.title || ""),
										st2.type ? h("span", { className: "u-badge" }, st2.type) : null,
									))),
									p.review ? h("div", { className: "u-note", style: { padding: "4px 8px 8px" } }, t("plan.review"), ":", String(p.review).slice(0, 260), String(p.review).length > 260 ? "…" : "") : null,
								));
								return [main, detail];
							})),
						),
					),
				),
			);
		}

		// ── 技能 section(v2.1):skill-librarian 审计两个技能根(/api/agos/skills)──
		// 引擎 = Leo 的 github.com/LeoLin990405/skill-librarian(单文件只读审计器,9 项检查);
		// 覆盖 ~/.claude/skills(360+)与 ~/.dsh/skills(DSH 原生 + civ 自动沉淀件)。
		const SEV_DOT = (sev) => sev === "error" ? "u-dot is-bad" : sev === "warn" ? "u-dot is-run" : "u-dot";
		const SK_SHOW = 30;
		function SkillsSection() {
			const t = useT();
			const [state, setState] = React.useState({ loading: true, error: null, roots: [] });
			const [filter, setFilter] = React.useState(null); // 按 check 筛选,null=全部
			const load = React.useCallback((force) => {
				setState((s2) => ({ ...s2, loading: true, error: null }));
				fetch("/api/agos/skills" + (force ? "?refresh=1" : ""))
					.then((r) => r.json())
					.then((d) => setState({ loading: false, error: d.error || null, roots: Array.isArray(d.roots) ? d.roots : [] }))
					.catch((e) => setState({ loading: false, error: String((e && e.message) || e), roots: [] }));
			}, []);
			React.useEffect(() => { load(false); }, [load]);
			return h("div", { className: "u-sec" },
				h("div", { className: "u-row", style: { justifyContent: "space-between" } },
					h("span", null,
						h("span", { className: "u-title" }, t("sk.title")), " ",
						h("span", { className: "u-meta" }, t("sk.sub")),
					),
					h("button", { type: "button", className: "u-btn", onClick: () => load(true), disabled: state.loading }, t("sk.refresh")),
				),
				h("div", { className: "u-sec-body" },
					state.loading && state.roots.length === 0 ? h("div", { className: "u-empty" }, t("sk.loading"))
					: state.error ? h("div", { className: "u-empty u-err" }, t("sk.error", { err: state.error }))
					: state.roots.map((r0) => {
						if (r0.error) return h("div", { key: r0.root, className: "u-box", style: { margin: "8px 12px" } },
							h("span", { className: "u-mono u-meta" }, r0.root), h("div", { className: "u-err" }, r0.error));
						const findings = Array.isArray(r0.findings) ? r0.findings : [];
						// 各 check 计数(做筛选 chips)
						const byCheck = {};
						for (const f0 of findings) byCheck[f0.check] = (byCheck[f0.check] || 0) + 1;
						const shown = (filter ? findings.filter((f0) => f0.check === filter) : findings).slice(0, SK_SHOW);
						const total = filter ? (byCheck[filter] || 0) : findings.length;
						return h("div", { key: r0.root, className: "u-box", style: { margin: "8px 12px" } },
							h("div", { className: "u-row", style: { padding: 0, marginBottom: "6px", flexWrap: "wrap" } },
								h("span", { className: "u-strong u-mono", title: r0.root }, r0.root.replace(/^.*\/(\.[a-z]+\/skills)$/, "~/$1")),
								h("span", { className: "u-badge is-accent u-num" }, t("sk.skills", { n: r0.skills })),
								(r0.counts && r0.counts.error) ? h("span", { className: "u-badge is-bad u-num" }, "error ", r0.counts.error) : null,
								(r0.counts && r0.counts.warn) ? h("span", { className: "u-badge is-warn u-num" }, "warn ", r0.counts.warn) : null,
								(r0.counts && r0.counts.info) ? h("span", { className: "u-badge u-num" }, "info ", r0.counts.info) : null,
								findings.length === 0 ? h("span", { className: "u-badge is-ok" }, t("sk.clean")) : null,
							),
							findings.length > 0 ? h("div", { className: "u-chips", style: { marginBottom: "6px" } },
								h("button", { type: "button", className: "u-chip" + (filter === null ? " is-on" : ""), onClick: () => setFilter(null) }, t("sk.all"), " ", h("span", { className: "u-num" }, findings.length)),
								Object.entries(byCheck).sort((a, b) => b[1] - a[1]).map(([ck, n2]) =>
									h("button", { key: ck, type: "button", className: "u-chip" + (filter === ck ? " is-on" : ""), onClick: () => setFilter(filter === ck ? null : ck) }, ck, " ", h("span", { className: "u-num" }, n2))),
							) : null,
							h("div", { className: "u-list u-stagger-host" }, shown.map((f0, i2) => h("div", { key: i2, className: "u-li" + (f0.sev === "error" ? " is-bad" : "") },
								h("span", { className: SEV_DOT(f0.sev), ref: f0.sev === "warn" ? pulseRef : undefined }),
								h("span", { className: "u-badge" }, f0.check),
								h("span", { className: "u-mono u-meta", style: { flex: "none" } }, f0.skill),
								h("span", { className: "u-grow", title: f0.msg }, f0.msg),
							))),
							total > SK_SHOW ? h("div", { className: "u-note", style: { padding: "4px 8px" } }, t("sk.more", { n: total - SK_SHOW })) : null,
						);
					}),
				),
			);
		}

		// ── 概览页(v3):注意力收件箱 + KPI 卡(证据:Codex priorityThreads「活动视图」、
		// Claude input_required 一等态、Trae Needs Input 过滤;空态文案借 Codex「没有需要关注的任务」)──
		function OverviewPage({ overview, calls, go }) {
			const t = useT();
			const ov = overview || {};
			// 「需要关注」= 活跃派单里 failed / running 的行(failed 优先)
			const attention = [];
			for (const [callId, v] of Object.entries(calls || {})) {
				for (const r of (Array.isArray(v.rows) ? v.rows : [])) {
					if (r.status === "failed") attention.push({ callId, r, kind: "failed" });
					else if (r.status === "running") attention.push({ callId, r, kind: "running" });
				}
			}
			attention.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "failed" ? -1 : 1));
			const kpis = [
				ov.sessions ? { id: "sessions", n: ov.sessions.total, l: t("ov.kpi.sessions"), sub: null } : null,
				ov.lineage ? { id: "lineage", n: ov.lineage.calls, l: t("ov.kpi.lineage"), sub: t("ov.kpi.lineageSub", { r: ov.lineage.running }), hot: ov.lineage.running > 0 } : null,
				ov.plans ? { id: "plans", n: ov.plans.total, l: t("ov.kpi.plans"), sub: t("ov.kpi.plansSub", { e: ov.plans.executed }) } : null,
				ov.skills ? { id: "skills", n: ov.skills.skills, l: t("ov.kpi.skills"), sub: t("ov.kpi.skillsSub", { w: ov.skills.warn }), warn: ov.skills.warn > 0 } : null,
			].filter(Boolean);
			return h(React.Fragment, null,
				h("div", { className: "u-kpis" }, kpis.map((k) => h("button", {
					key: k.id, type: "button", className: "u-kpi", style: { cursor: "pointer", textAlign: "left", font: "inherit", background: "transparent" },
					onClick: () => go(k.id === "lineage" ? "lineage" : k.id),
				},
					h("div", { className: "u-kpi-label" }, k.l),
					h("div", { className: "u-kpi-num u-num", ref: (el) => { if (el && !el.dataset.cu) { el.dataset.cu = "1"; countUp(el, Number(k.n) || 0); } } }, k.n),
					k.sub ? h("div", { className: "u-kpi-sub" }, k.sub) : null,
				))),
				h("div", { className: "u-sec" },
					h("div", { className: "u-row" }, h("span", { className: "u-title" }, t("ov.attention"))),
					h("div", { className: "u-sec-body" },
						attention.length === 0
							? h("div", { className: "u-empty" }, t("ov.attentionEmpty"))
							: h("div", { className: "u-list", style: { padding: "4px 8px" } }, attention.slice(0, 12).map((a, i2) => h("div", { key: i2, className: "u-li" + (a.kind === "failed" ? " is-bad" : "") },
								h("span", { className: a.kind === "failed" ? "u-dot is-bad" : "u-dot is-run", ref: a.kind === "running" ? pulseRef : undefined }),
								h("span", { className: "u-badge" + (a.kind === "failed" ? " is-bad" : " is-accent") }, a.kind === "failed" ? t("ov.failedRow") : t("ov.runningRow")),
								h("span", { className: "u-grow", title: a.r.item || "" }, a.r.item || "—"),
								a.r.host ? h("span", { className: "u-badge" }, "@", a.r.host) : null,
								h("button", { type: "button", className: "u-btn", onClick: () => go("lineage") }, "→"),
							))),
					),
				),
			);
		}

		// ── 控制台面板(shell.overlay;声明并渲染 agos.section)────────────────
		function AgosOverlay(props) {
			const t = useT();
			const open = useOpen();
			const [page, setPage] = React.useState("overview");
			// overview + lineage 数据在面板级取(概览/徽章/谱系页共用),面板开着才轮询
			const [overview, setOverview] = React.useState(null);
			const [calls, setCalls] = React.useState({});
			React.useEffect(() => {
				if (!open) return;
				const loadOv = () => fetch("/api/agos/overview").then((r) => r.json()).then(setOverview).catch(() => {});
				const loadLin = () => fetch("/api/swarm/progress").then((r) => r.json()).then((d) => setCalls(d.calls && typeof d.calls === "object" ? d.calls : {})).catch(() => {});
				loadOv(); loadLin();
				const id = setInterval(() => { loadOv(); loadLin(); }, 5000);
				const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
				window.addEventListener("keydown", onKey);
				return () => { clearInterval(id); window.removeEventListener("keydown", onKey); };
			}, [open]);
			// 开场编排(TASK-2026-08-20-002):打开挂 is-opening/is-entering,700ms 后摘除;
			// booted 保证每次打开只播一次,数据轮询重渲染不重播。
			const [opening, setOpening] = React.useState(false);
			const booted = React.useRef(false);
			React.useEffect(() => {
				if (!open) { booted.current = false; return; }
				if (booted.current) return;
				booted.current = true;
				setOpening(true);
				const id = setTimeout(() => setOpening(false), 700);
				return () => clearTimeout(id);
			}, [open]);
			if (!open) return null;
			const running = Object.values(calls).reduce((n2, v) => n2 + (Array.isArray(v.rows) ? v.rows.filter((r) => r.status === "running").length : 0), 0);
			const failedN = Object.values(calls).reduce((n2, v) => n2 + (Array.isArray(v.rows) ? v.rows.filter((r) => r.status === "failed").length : 0), 0);
			const skillsWarn = overview && overview.skills ? (overview.skills.warn || 0) + (overview.skills.error || 0) : 0;
			const NAV = [
				{ id: "overview", icon: "◉", label: t("nav.overview") },
				{ id: "machines", icon: "🖥", label: t("nav.machines") },
				{ id: "sessions", icon: "💬", label: t("nav.sessions"), badge: overview && overview.sessions ? overview.sessions.total : null },
				{ id: "lineage", icon: "🧬", label: t("nav.lineage"), badge: failedN || running || null, badgeCls: failedN ? "is-bad" : running ? "is-run" : "" },
				{ id: "plans", icon: "📋", label: t("nav.plans"), badge: overview && overview.plans ? overview.plans.total : null },
				{ id: "skills", icon: "📚", label: t("nav.skills"), badge: skillsWarn || null, badgeCls: skillsWarn ? "is-warn" : "" },
			];
			const renderPage = () => {
				switch (page) {
					case "overview": return h(React.Fragment, null,
						h(OverviewPage, { overview, calls, go: setPage }),
						// 扩展区:第三方插件注册进 agos.section(list)的内容仍渲染在这里(开放性保留)
						typeof props.renderSlot === "function" ? props.renderSlot("agos.section", {}) : null,
					);
					case "machines": return typeof props.renderSlot === "function"
						? h("div", { className: "u-page--fill", style: { flex: 1, minHeight: 0 } }, props.renderSlot("agos.page.machines", {}))
						: null;
					case "sessions": return h(SessionsSection, null);
					case "lineage": return h(LineageSection, null);
					case "plans": return h(PlansSection, null);
					case "skills": return h(SkillsSection, null);
					default: return null;
				}
			};
			return h(React.Fragment, null,
				h("div", { className: "u-veil", onClick: () => setOpen(false) }),
				h("div", { className: "u-modal" + (opening ? " is-opening" : ""), role: "dialog", "aria-modal": "true", "aria-label": t("title") },
					h("div", { className: "u-modal-head" },
						h("span", { style: { fontSize: "16px" } }, "🧭"),
						h("div", { style: { flex: 1, minWidth: 0 } },
							h("div", { className: "u-title" }, t("title")),
							h("div", { className: "u-meta" }, t("subtitle")),
						),
						h("button", { type: "button", className: "u-btn", onClick: () => setOpen(false), "aria-label": t("close") }, "✕"),
					),
					h("div", { className: "u-modal-main" },
						h("nav", { className: "u-rail" }, NAV.map((n2) => h("button", {
							key: n2.id, type: "button",
							className: "u-nav" + (page === n2.id ? " is-on" : ""),
							"aria-current": page === n2.id ? "page" : undefined,
							onClick: () => setPage(n2.id),
						}, h("span", null, n2.icon), h("span", null, n2.label),
							n2.badge != null ? h("span", { className: "u-nav-badge " + (n2.badgeCls || "") }, n2.badge) : null))),
						h("div", { className: "u-page" + (opening ? " is-entering" : "") + (opening && page === "overview" ? " u-stagger-host" : "") }, renderPage()),
					),
				),
			);
		}

		// ── 装配 ────────────────────────────────────────────────────────────
		function apply(ctx) {
			const slots = ctx.get("slots");
			if (slots === undefined) return;
			const locale = ctx.get("locale");
			if (locale) {
				LOCALE = locale;
				try { ctx.effect(() => locale.register(NS, DICT), "agos i18n"); }
				catch (e) { console.warn("[dsh-agos] locale.register failed:", e); }
			}
			// v5:宿主 sessions 服务(open/clear)——拿不到就不给点击行为,表照常显示
			try { SESSIONS = ctx.get("sessions") ?? null; } catch { SESSIONS = null; }
			injectStyle();
			// 侧栏入口(list 槽,Settings 旁)
			slots.inject("sidebar.footer.action", () =>
				slots.register({ name: "sidebar.footer.action", locale: NS, id: "agos", order: 10 }, AgosButton),
			);
			// 控制台面板(list 槽,全帧浮层)——同一次 register 声明 agos.section 子槽,
			// 声明即渲染授权:只有本 entry 能 renderSlot('agos.section')(owner 化授权)。
			slots.inject("shell.overlay", () =>
				slots.register({
					name: "shell.overlay", locale: NS, id: "agos-console", order: 10,
					children: { "agos.section": { kind: "list", scope: "root" }, "agos.page.machines": { kind: "single", scope: "root" } },
				}, AgosOverlay),
			);
			// v3:自有页(会话/谱系/计划/技能)直连组件,不再走 agos.section 槽——
			// 该槽保留给第三方扩展(渲染在概览页底部「扩展」区);机器页走专槽 agos.page.machines(fleet 投稿)。
		}

		exports.apply = apply;
		exports.inject = ["slots", "locale"];
		return module.exports;
	},
});
