window.__ModuleLoader__.load({
	id: "@dsh-local/fleet",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;

		const React = require("react");
		const h = React.createElement;

		// ── i18n ─────────────────────────────────────────────────────────────
		// 自带 NS,照抄 trace-view:直接拿宿主 locale 服务(exports.inject 声明),
		// apply() 里 ctx.effect(() => locale.register(NS, DICT))。组件只在 apply 注册
		// 之后才渲染,所以首帧 LOCALE 一定就位;不碰 ui-kit 的 DICTS。
		// en 缺键宿主 translate() 自动回落 zh;这里 en 仍尽量给全。
		const NS = "dsh-fleet";
		let LOCALE = null;
		const DICT = {
			zh: {
				"tab": "机器",
				"title": "机器 · 虚拟电脑机架",
				"subtitle": "homelab 每台 worker 都是一台常驻虚拟电脑,带自己的工作区。这里看全队实时状态(与当前会话无关)。",
				"stat.online": "在线",
				"stat.running": "在跑",
				"kind.local": "本机",
				"kind.remote": "远端",
				"label.kind": "类型",
				"label.model": "默认模型",
				"label.version": "版本",
				"label.conc": "并发",
				"label.task": "任务",
				"label.last": "刚结束",
				"busy": "忙",
				"idle": "闲",
				"ws.files": "{n} 个文件",
				"ws.refresh": "刷新",
				"ws.empty": "工作区为空",
				"ws.readFail": "读文件失败:{err}",
				"err.load": "读不到机器列表:{err}",
				"health.down": "离线 / 探测失败",
				"os.mac": "mac",
				"os.linux": "linux",
				"probing": "探测中…",
				"enter": "进入电脑",
				"back": "返回机架",
				"live": "实时",
				"persist": "留存",
				"computer": "{name} 的电脑",
				"noStream": "worker 一次性执行,不吐实时终端流;这里看的是真·实时落地到工作区的产物。",
				"pickHint": "点文件看内容",
				// 生命周期四态(Kimi)
				"state.booting": "开机中",
				"state.running": "执行中",
				"state.done.ok": "刚结束 ✓",
				"state.done.err": "刚结束 ✗",
				"state.idle": "空闲",
				"state.offline": "离线",
				// 「正在使用 ‹工具›」动词表(Kimi/Manus)
				"verb.terminal": "正在运行终端",
				"verb.read": "正在阅读",
				"verb.edit": "正在编辑文件",
				"verb.browser": "正在使用浏览器",
				"verb.search": "正在检索",
				"verb.plan": "正在整理进度清单",
				"verb.other": "正在使用 {name}",
				"verb.think": "思考中",
				"verb.boot": "开机中…",
				"verb.last": "上次:{verb}",
				"verb.none": "暂无工具活动",
				"past.terminal": "终端",
				"past.read": "阅读",
				"past.edit": "编辑文件",
				"past.browser": "浏览器",
				"past.search": "检索",
				"past.plan": "进度清单",
				"past.other": "{name}",
				// run 分 tab
				"runs.label": "运行",
				"run.prompt": "任务",
				"run.started": "起于 {t}",
				"run.elapsed": "已跑 {d}",
				"run.took": "用时 {d}",
				"run.error": "错误:{err}",
				"run.traceOnly": "仅有轨迹文件(fleet 记录已随重启丢失)",
				// 三段
				"seg.traj": "轨迹",
				"seg.ws": "工作区",
				"seg.art": "产物",
				"traj.empty": "还没有轨迹事件(worker 一开跑,工具调用会实时流入这里)",
				"traj.result.ok": "结果",
				"traj.result.err": "失败",
				"traj.note": "明文会话日志实时落盘 → tail 出来的真·工具级轨迹(headless 不吐流,靠 compression:none 写盘)。",
				"traj.step": "第 {turn} 轮 · 步 {step}",
				"traj.todo": "更新进度清单({n} 项)",
				"traj.count": "{n} 行 / 共 {total}",
				"art.note": "产物 = worker 在 tasks/<runId>/ 下落的文件(3s 轮询,新文件滑入)。",
				"art.cur": "本次 run",
				"art.other": "其它 run",
				"art.empty": "本次 run 还没有产物",
				"art.noRun": "还没有选中的 run",
				// 进度清单(Manus/Kimi)
				"progress.title": "当前进度",
				"progress.todo": "来自 worker 的进度清单",
				"progress.empty": "还没有步骤(worker 开跑后,每次工具调用会在这里逐条打勾)",
				"step.running": "进行中",
				"step.cut": "未返回",
				"step.pending": "待做",
				// local
				"local.note": "本机(local)跑的是进程内子代理:轨迹与结果在对话里的 swarm 卡片看;这里只列 fleet 记录到的运行。",
				"local.noRuns": "还没有经 fleet 派到本机的运行",
				// 回放条
				"replay.play": "播放回放",
				"replay.pause": "暂停",
				"replay.live": "跟随",
				"replay.badge": "回放",
			},
			en: {
				"tab": "Machines",
				"title": "Machines · virtual-computer rack",
				"subtitle": "Every homelab worker is a persistent virtual computer with its own workspace. Live fleet state (ignores the current session).",
				"stat.online": "online",
				"stat.running": "running",
				"kind.local": "local",
				"kind.remote": "remote",
				"label.kind": "Kind",
				"label.model": "Model",
				"label.version": "Version",
				"label.conc": "Concurrency",
				"label.task": "Task",
				"label.last": "Just finished",
				"busy": "busy",
				"idle": "idle",
				"ws.files": "{n} files",
				"ws.refresh": "Refresh",
				"ws.empty": "Workspace is empty",
				"ws.readFail": "Failed to read file: {err}",
				"err.load": "Cannot read the host list: {err}",
				"health.down": "offline / probe failed",
				"os.mac": "mac",
				"os.linux": "linux",
				"probing": "Probing…",
				"enter": "Open computer",
				"back": "Back to rack",
				"live": "live",
				"persist": "persisted",
				"computer": "{name}'s computer",
				"noStream": "One-shot worker — no live terminal stream; this watches real files land in the workspace.",
				"pickHint": "Click a file to view",
				"state.booting": "Booting",
				"state.running": "Running",
				"state.done.ok": "Just finished ✓",
				"state.done.err": "Just failed ✗",
				"state.idle": "Idle",
				"state.offline": "Offline",
				"verb.terminal": "Running the terminal",
				"verb.read": "Reading",
				"verb.edit": "Editing files",
				"verb.browser": "Using the browser",
				"verb.search": "Searching",
				"verb.plan": "Updating the task list",
				"verb.other": "Using {name}",
				"verb.think": "Thinking",
				"verb.boot": "Booting…",
				"verb.last": "Last: {verb}",
				"verb.none": "No tool activity yet",
				"past.terminal": "terminal",
				"past.read": "reading",
				"past.edit": "editing files",
				"past.browser": "browser",
				"past.search": "search",
				"past.plan": "task list",
				"past.other": "{name}",
				"runs.label": "Runs",
				"run.prompt": "Task",
				"run.started": "started {t}",
				"run.elapsed": "{d} elapsed",
				"run.took": "took {d}",
				"run.error": "error: {err}",
				"run.traceOnly": "trace file only (fleet record lost on restart)",
				"seg.traj": "Trajectory",
				"seg.ws": "Workspace",
				"seg.art": "Artifacts",
				"traj.empty": "No trajectory events yet (tool calls stream in here once the worker starts)",
				"traj.result.ok": "result",
				"traj.result.err": "failed",
				"traj.note": "Plaintext session log lands live on disk → tailed into a real tool-level trajectory (headless doesn't stream; compression:none writes it out).",
				"traj.step": "turn {turn} · step {step}",
				"traj.todo": "task list updated ({n} items)",
				"traj.count": "{n} rows / {total} total",
				"art.note": "Artifacts = files the worker drops under tasks/<runId>/ (polled every 3s, new files slide in).",
				"art.cur": "This run",
				"art.other": "Other runs",
				"art.empty": "No artifacts for this run yet",
				"art.noRun": "No run selected",
				"progress.title": "Task progress",
				"progress.todo": "from the worker's task list",
				"progress.empty": "No steps yet (once the worker starts, each tool call gets ticked off here)",
				"step.running": "running",
				"step.cut": "no result",
				"step.pending": "pending",
				"local.note": "local runs in-process subagents: watch trajectory and results in the swarm card of the conversation; only fleet-recorded runs are listed here.",
				"local.noRuns": "No fleet runs on this machine yet",
				"replay.play": "Play replay",
				"replay.pause": "Pause",
				"replay.live": "Live",
				"replay.badge": "replay",
			},
		};
		const fallbackT = (k, params) => {
			let v = DICT.zh[k] ?? k;
			if (params) v = v.replace(/\{(\w+)\}/g, (m, n) => (n in params ? String(params[n]) : m));
			return v;
		};
		// 单个 hook,数量恒定;LOCALE 为空时订阅是 no-op、t 退回 zh。照抄 trace-view。
		function useT() {
			React.useSyncExternalStore(
				(fn) => (LOCALE ? LOCALE.subscribe(fn) : () => {}),
				() => (LOCALE ? LOCALE.getSnapshot() : null),
				() => null,
			);
			return LOCALE ? LOCALE.bind(NS) : fallbackT;
		}

		// ── 常量 ────────────────────────────────────────────────────────────
		const DONE_HOLD_MS = 8000;   // "刚结束 ✓|✗" 驻留
		const BOOT_WINDOW_MS = 8000; // 机架 Tile 没有轨迹可看时的"开机中"窗口(ssh 连接 + dsh 启动)
		const RUNS_MAX = 12;
		// runId → 该 run 的轨迹是否已有行。电脑视图轮询时写入,机架 Tile 读它把"开机中/执行中"判准;
		// 没看过的 run 退回时间窗口启发式(见 lifecycleOfHost)。
		const TRACE_HAS_LINES = new Map();

		// ── 格式化 ──────────────────────────────────────────────────────────
		const enc = encodeURIComponent;
		const pad2 = (n) => (n < 10 ? "0" : "") + n;
		const fmtSize = (n) => {
			if (!n || n <= 0) return "0";
			if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
			if (n >= 1000) return Math.round(n / 1000) + "k";
			return String(n);
		};
		const fmtClock = (ts) => {
			if (!ts) return "";
			const d = new Date(ts < 1e12 ? ts * 1000 : ts);
			if (isNaN(d.getTime())) return "";
			return pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
		};
		const fmtDur = (ms) => {
			if (ms == null || !isFinite(ms) || ms < 0) return "—";
			if (ms < 1000) return Math.round(ms) + "ms";
			const s = Math.round(ms / 1000);
			if (s < 60) return s + "s";
			const m = Math.floor(s / 60), r = s % 60;
			if (m < 60) return m + "m" + (r ? pad2(r) + "s" : "");
			return Math.floor(m / 60) + "h" + pad2(m % 60) + "m";
		};
		const osTag = (tags) => (Array.isArray(tags) ? tags.find((x) => x === "mac" || x === "linux") : null);
		const prefersReduced = () => { try { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); } catch { return false; } };
		const getJSON = (url) => fetch(url).then((r) => (r.ok ? r.json() : r.json().catch(() => ({})).then((j) => Promise.reject(new Error((j && j.error) || ("HTTP " + r.status))))));
		// 轮询闸:上一轮没回来就跳过这一轮(ssh 慢时不堆积),页签隐藏时不发(浏览器会把后台 fetch 排队几十秒,
		// 回前台一并放行 → 瞬间十几个请求;实测过)。busyRef 为 useRef 对象。
		const pollGuard = (busyRef, fn) => {
			if (busyRef.current) return;
			if (typeof document !== "undefined" && document.hidden) return;
			busyRef.current = true;
			const done = () => { busyRef.current = false; };
			try { const p = fn(); if (p && typeof p.then === "function") p.then(done, done); else done(); } catch { done(); }
		};
		// 轮询器:立刻一次 + 定时 + 页签回到前台立刻补一次。返回 dispose。
		const startPoll = (busyRef, fn, ms) => {
			pollGuard(busyRef, fn);
			const id = setInterval(() => pollGuard(busyRef, fn), ms);
			const onVis = () => { if (!document.hidden) pollGuard(busyRef, fn); };
			if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVis);
			return () => { clearInterval(id); if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVis); };
		};

		// ── 工具名 → 动词(Kimi/Manus 「正在使用 ‹工具›」)─────────────────────
		const VERB_RULES = [
			["terminal", /^(bash|shell|sh|zsh|terminal|exec|command|run_command|run_shell|powershell|execute)(?![a-z])/],
			["read", /^(read|cat|view|open_file|get_file|show_file)(?![a-z])|^read_/],
			["edit", /^(write|edit|apply_patch|patch|create_file|write_file|str_replace|multi_edit|notebook_edit|replace|insert)(?![a-z])|^(write|edit)_/],
			["browser", /^(web_search|websearch|web_fetch|fetch|browser|open_url|browse|http|curl|navigate|search_web|webfetch)/],
			["search", /^(grep|glob|find|list|ls|search|rg|locate|tree|list_dir)(?![a-z])|^(grep|glob|find|list|search)_/],
			["plan", /^(todo|todo_write|update_plan|plan)(?![a-z])|^todo_/],
		];
		const verbKey = (name) => { const n = String(name || "").toLowerCase(); for (const [k, re] of VERB_RULES) if (re.test(n)) return k; return "other"; };
		const verbText = (t, name, past) => t((past ? "past." : "verb.") + verbKey(name), { name: String(name || "") });

		// 工具参数 → 一行摘要(步骤标题用):优先挑 command/path/pattern/url 这类主参
		const ARG_KEYS = ["command", "cmd", "pattern", "query", "url", "path", "file_path", "filePath", "file", "glob", "prompt", "content", "text"];
		const oneLine = (s, n) => String(s).replace(/\s+/g, " ").trim().slice(0, n);
		const argsSummary = (args) => {
			if (!args) return "";
			let o = null; try { o = JSON.parse(args); } catch {}
			if (o && typeof o === "object" && !Array.isArray(o)) {
				for (const k of ARG_KEYS) { const v = o[k]; if (typeof v === "string" && v.trim()) return oneLine(v, 80); }
				const first = Object.values(o).find((v) => typeof v === "string" && v.trim());
				return first ? oneLine(first, 80) : "";
			}
			return oneLine(args, 80);
		};

		// ── 轨迹事件解析 ───────────────────────────────────────────────────
		// 容错解析一条原始会话事件行 → 轨迹行。schema(真跑校准):顶层 {type,seq,time,data};
		//   tool/call → data.{callId,name,arguments(字符串),turn,step}
		//   tool/result → data.message.content[{type:"tool-result",toolCallId,isError,content:[{type:"text",text}]}]
		//   assistant/message → data.message.content[{type:"text"|"reasoning"|"tool-call"}](只取 text)
		//   step/start → data.{turn,step}(轨迹里出一条标记行);todo/write → data.todos[{content,status}]
		//   忽略流式碎片 assistant/chunk · tool-call-chunks · reasoning-chunks 与 session/turn 元事件。
		// 弱依赖字段名:取不到就降级,绝不抛。
		const textOfBlocks = (blocks) => (Array.isArray(blocks) ? blocks : []).filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("").trim();
		const parseTraceEvent = (line) => {
			let o; try { o = JSON.parse(line); } catch { return null; }
			if (!o || typeof o !== "object") return null;
			const type = String(o.type || "");
			const d = o.data || {};
			const seq = o.seq != null ? o.seq : (o.seq0 != null ? o.seq0 : d.seq);
			const time = typeof o.time === "number" ? o.time : (typeof o.time === "string" ? (Date.parse(o.time) || null) : null);
			if (type === "tool/call") {
				let args = "";
				if (typeof d.arguments === "string") args = d.arguments;
				else if (d.arguments != null) { try { args = JSON.stringify(d.arguments); } catch {} }
				else if (d.args != null) { try { args = typeof d.args === "string" ? d.args : JSON.stringify(d.args); } catch {} }
				return { seq, time, kind: "tool", name: String(d.name || d.toolName || "tool"), args: args.slice(0, 400), callId: d.callId != null ? String(d.callId) : null, turn: d.turn, step: d.step };
			}
			if (type === "tool/result") {
				const blocks = (d.message && Array.isArray(d.message.content)) ? d.message.content : [];
				const tr = blocks.find((b) => b && b.type === "tool-result") || {};
				const rt = Array.isArray(tr.content) ? textOfBlocks(tr.content) : (typeof tr.content === "string" ? tr.content : "");
				const src = d.message && d.message.source;
				const callId = tr.toolCallId != null ? String(tr.toolCallId) : (src && src.callId != null ? String(src.callId) : null);
				return { seq, time, kind: "result", isError: tr.isError === true, text: String(rt).slice(0, 200), callId };
			}
			if (type === "assistant/message") {
				const blocks = (d.message && Array.isArray(d.message.content)) ? d.message.content : [];
				const t = textOfBlocks(blocks);
				return t ? { seq, time, kind: "text", text: t.slice(0, 400) } : null;
			}
			if (type === "step/start") return { seq, time, kind: "step", turn: d.turn, step: d.step };
			if (type === "todo/write") {
				const todos = (Array.isArray(d.todos) ? d.todos : []).filter((x) => x && typeof x.content === "string").map((x) => ({ content: x.content, status: String(x.status || "pending") }));
				return { seq, time, kind: "todo", todos };
			}
			return null;
		};

		// tool/call ↔ tool/result 配对成步骤(按 callId;缺 callId 退回"最早未配对"顺序配)
		const deriveSteps = (events, runEnded) => {
			const steps = []; const byId = new Map();
			for (const e of events) {
				if (e.kind === "tool") {
					const summ = argsSummary(e.args);
					const s = { key: e._k, callId: e.callId, name: e.name, args: e.args, title: e.name + (summ ? " " + summ : ""), status: "running", t0: e.time, ms: null, result: "" };
					steps.push(s); if (e.callId) byId.set(e.callId, s);
				} else if (e.kind === "result") {
					let s = e.callId ? byId.get(e.callId) : null;
					if (!s || s.status !== "running") s = steps.find((x) => x.status === "running") || null;
					if (!s) continue;
					s.status = e.isError ? "err" : "ok"; s.result = e.text;
					s.ms = (typeof s.t0 === "number" && typeof e.time === "number") ? Math.max(0, e.time - s.t0) : null;
				}
			}
			if (runEnded) for (const s of steps) if (s.status === "running") s.status = "cut";
			return steps;
		};
		const mergeRuns = (hostRuns, traceRuns) => {
			const out = [];
			for (const r of (Array.isArray(hostRuns) ? hostRuns : [])) { if (r && r.runId && !out.some((x) => x.runId === r.runId)) out.push({ ...r, hasTrace: false }); }
			const tr = (Array.isArray(traceRuns) ? traceRuns.slice() : []).sort((a, b) => (Number(b.mtime) || 0) - (Number(a.mtime) || 0));
			for (const x of tr) {
				if (!x || !x.runId) continue;
				const ex = out.find((r) => r.runId === x.runId);
				if (ex) { ex.hasTrace = true; ex.mtime = x.mtime; continue; }
				out.push({ runId: x.runId, prompt: "", startedAt: null, endedAt: null, ok: null, error: null, hasTrace: true, mtime: x.mtime, fromTrace: true });
			}
			return out.slice(0, RUNS_MAX);
		};

		// ── 生命周期四态 ────────────────────────────────────────────────────
		const LIFE = {
			booting: { cls: "is-warn", key: "state.booting" },
			running: { cls: "is-accent", key: "state.running" },
			doneOk: { cls: "is-ok", key: "state.done.ok" },
			doneErr: { cls: "is-bad", key: "state.done.err" },
			idle: { cls: "", key: "state.idle" },
			offline: { cls: "is-bad", key: "state.offline" },
		};
		// 机架 Tile:host 级(没有轨迹可看 → 用 TRACE_HAS_LINES 缓存,否则退回启动时间窗口)
		const lifecycleOfHost = (host) => {
			if (host.ok === false) return "offline";
			const now = Date.now();
			const runs = Array.isArray(host.runs) ? host.runs : [];
			const newest = runs.find((r) => r && !r.endedAt) || null;
			if ((Number(host.inflight) || 0) > 0 || newest) {
				if (newest && TRACE_HAS_LINES.get(newest.runId) === true) return "running";
				if (newest && typeof newest.startedAt === "number" && now - newest.startedAt < BOOT_WINDOW_MS) return "booting";
				return "running";
			}
			const last = runs[0];
			if (last && last.endedAt && now - last.endedAt < DONE_HOLD_MS) return last.ok ? "doneOk" : "doneErr";
			return "idle";
		};
		// 电脑视图:run 级(有轨迹行数可看,精确)
		const lifecycleOfRun = (host, run, hasLines) => {
			if (host.ok === false) return "offline";
			const now = Date.now();
			if (!run) return (Number(host.inflight) || 0) > 0 ? "running" : "idle";
			if (run.startedAt && !run.endedAt) return hasLines ? "running" : "booting";
			if (run.endedAt && now - run.endedAt < DONE_HOLD_MS) return run.ok ? "doneOk" : "doneErr";
			return "idle";
		};

		// ── 插件私有样式(只补 ui-kit v2 没有的布局微件;颜色一律令牌)───────────
		// 幂等注入一次。动效只两处:头部动词交叉淡入(opacity)、复用 ui-kit 的 .u-land;reduced-motion 给最终态。
		const STYLE_ID = "dsh-fleet-machines-style";
		const injectStyle = () => {
			if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
			const el = document.createElement("style");
			el.id = STYLE_ID;
			el.textContent = [
				".u-tile.dsh-fleet-tile.is-off{opacity:.55;cursor:default}",
				".u-tile.dsh-fleet-tile.is-off:hover{border-color:var(--u-a12)}",
				".dsh-fleet-tilehead{display:flex;align-items:center;gap:8px;margin-bottom:10px;min-width:0}",
				".dsh-fleet-tname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:700;font-size:var(--u-fz-b);line-height:16px}",
				".dsh-fleet-wsrow{margin-top:8px;padding-top:8px;border-top:1px solid var(--u-a8)}",
				".dsh-fleet-foot{margin-top:10px;display:flex;justify-content:flex-end}",
				".dsh-fleet-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;margin:0 0 8px}",
				".dsh-fleet-ml{margin-left:auto}",
				".dsh-fleet-ell{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
				".dsh-fleet-scroll{max-height:320px;overflow-y:auto}",
				".dsh-fleet-sect{margin-top:12px}",
				".dsh-fleet-dim{opacity:.6}",
				".dsh-fleet-runs{flex:1 1 auto;min-width:0;overflow-x:auto}",
				".dsh-fleet-runs > .u-segs{width:max-content}",
				".u-li.dsh-fleet-rowbtn{appearance:none;width:100%;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}",
				".u-li.dsh-fleet-rowbtn:hover{background:var(--u-a5)}",
				".u-li.dsh-fleet-rowbtn.is-on{background:var(--u-a8);color:var(--u-fg)}",
				".dsh-fleet-xfade{animation:dsh-fleet-xfade var(--u-t2) var(--u-ease) both}",
				"@keyframes dsh-fleet-xfade{from{opacity:0}to{opacity:1}}",
				"@media (prefers-reduced-motion:reduce){.dsh-fleet-xfade{animation-duration:1ms}}",
			].join("\n");
			document.head.appendChild(el);
		};

		// 列表跟随:长度增加时把末尾锚点 scrollIntoView(首填只把容器拉到底,不惊动外层滚动)。
		function useFollow(endRef, boxRef, len, enabled) {
			const prev = React.useRef(0);
			React.useEffect(() => {
				const was = prev.current; prev.current = len;
				if (!enabled || len <= was) return;
				if (was === 0) { if (boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight; return; }
				const el = endRef.current; if (!el) return;
				try { el.scrollIntoView({ block: "nearest", behavior: prefersReduced() ? "auto" : "smooth" }); } catch {}
			}, [len, enabled]);
		}

		const kv = (k, v, accent, title) => h("div", { className: "u-kv" },
			h("span", { className: "u-k" }, k),
			h("span", { className: "u-v" + (accent ? " is-accent" : ""), title: title != null ? title : (typeof v === "string" ? v : "") }, v));

		// ── 聚焦某台机 = 一块"电脑"(Kimi × Manus)──────────────────────────────
		// 头部「正在使用 ‹工具›」+ run 分 tab + 轨迹|工作区|产物 三段 + Task progress 步骤清单 + 回放条。
		// 全部从 /api/fleet/{hosts,ws,trace} 派生,零 worker 改动。
		function ComputerPane(props) {
			const t = props.t;
			const hd = props.host || {};
			const name = hd.name;
			const isLocal = hd.kind === "local";
			const hostRuns = Array.isArray(hd.runs) ? hd.runs : [];
			const inflightN = Number(hd.inflight) || 0;

			const [, setTick] = React.useState(0); // 1s 心跳:驱动"已跑 Ns"/"刚结束"驻留过期
			const [files, setFiles] = React.useState(null);
			const [wsErr, setWsErr] = React.useState(null);
			const [justAdded, setJustAdded] = React.useState(() => new Set());
			const [pick, setPick] = React.useState(null);
			const [content, setContent] = React.useState(null);
			const [readErr, setReadErr] = React.useState(null);
			const [surfTab, setSurfTab] = React.useState("traj");
			const [traj, setTraj] = React.useState([]);
			const [trajErr, setTrajErr] = React.useState(null);
			const [trajNew, setTrajNew] = React.useState(() => new Set());
			const [todoNew, setTodoNew] = React.useState(() => new Set()); // 本轮 todo/write 新增的条目标题(滑入用)
			const [trajMeta, setTrajMeta] = React.useState({ runId: null, total: 0, runs: [] });
			const [pickedRun, setPickedRun] = React.useState(null);
			const [rp, setRp] = React.useState({ mode: "live", on: false, t: 0, speed: 1 });
			const seenRef = React.useRef(new Set());
			const firstRef = React.useRef(true);
			const addTimer = React.useRef(null);
			const trajSeenRef = React.useRef(new Set());
			const trajFirstRef = React.useRef(true);
			const trajTimer = React.useRef(null);
			const todoTimer = React.useRef(null);
			const stepsBoxRef = React.useRef(null);
			const stepsEndRef = React.useRef(null);
			const trajBoxRef = React.useRef(null);
			const trajEndRef = React.useRef(null);
			const prevTodoRef = React.useRef(null);
			const spanRef = React.useRef(0);
			const wsBusy = React.useRef(false);
			const trajBusy = React.useRef(false);
			const runRef = React.useRef(null); // 当前选中 run;迟到的上一 run 响应据此丢弃

			React.useEffect(() => { const id = setInterval(() => setTick((x) => x + 1), 1000); return () => clearInterval(id); }, []);

			// —— run 选择:hosts.runs(最近 12,含在飞)∪ trace.runs;默认在飞的/最新的,用户点了就定住 ——
			const hostRunsRaw = hd.runs;
			const runs = React.useMemo(() => mergeRuns(hostRunsRaw, trajMeta.runs), [hostRunsRaw, trajMeta.runs]);
			const inflightRun = hostRuns.find((r) => r && !r.endedAt) || null;
			const autoRunId = inflightRun ? inflightRun.runId : (runs[0] ? runs[0].runId : null);
			const selRunId = pickedRun && runs.some((r) => r.runId === pickedRun) ? pickedRun : autoRunId;
			const selRun = runs.find((r) => r.runId === selRunId) || null;
			const runInflight = !!(selRun && selRun.startedAt && !selRun.endedAt);
			runRef.current = selRunId;

			// —— 工作区(3s 轮询,diff 出新文件滑入)——
			const load = React.useCallback(() => {
				if (isLocal) return;
				return getJSON("/api/fleet/ws?host=" + enc(name))
					.then((d) => {
						const fs = Array.isArray(d.files) ? d.files.slice() : [];
						fs.sort((a, b) => String(a.path).localeCompare(String(b.path)));
						const added = fs.filter((f) => !seenRef.current.has(f.path)).map((f) => f.path);
						fs.forEach((f) => seenRef.current.add(f.path));
						setFiles(fs); setWsErr(null);
						if (!firstRef.current && added.length) {
							setJustAdded(new Set(added));
							if (addTimer.current) clearTimeout(addTimer.current);
							addTimer.current = setTimeout(() => setJustAdded(new Set()), 1800);
						}
						firstRef.current = false;
					})
					.catch((e) => { setWsErr(String((e && e.message) || e)); setFiles((prev) => (prev === null ? [] : prev)); });
			}, [name, isLocal]);
			React.useEffect(() => {
				if (isLocal) return;
				const stop = startPoll(wsBusy, load, 3000);
				return () => { stop(); if (addTimer.current) clearTimeout(addTimer.current); };
			}, [load, isLocal]);

			// —— 轨迹(2.5s 轮询,按 (runId,seq) 去重;切 run 时清空 seen 集合,修跨 session seq 碰撞)——
			const loadTraj = React.useCallback(() => {
				if (isLocal) return;
				const myRun = selRunId;
				return getJSON("/api/fleet/trace?host=" + enc(name) + (selRunId ? "&run=" + enc(selRunId) : ""))
					.then((d) => {
						if (runRef.current !== myRun) return; // 切 run 后迟到的响应:丢弃,别把旧 run 的行混进来
						const lines = Array.isArray(d.lines) ? d.lines : [];
						const rid = String(d.runId || selRunId || "");
						if (rid) TRACE_HAS_LINES.set(rid, lines.length > 0);
						const map = new Map(); let i = 0;
						for (const ln of lines) {
							const e = parseTraceEvent(ln);
							if (!e) continue;
							e._k = rid + ":" + (e.seq != null ? ("s" + e.seq) : ("i" + (i++)));
							map.set(e._k, e);
						}
						const list = [...map.values()];
						const added = list.filter((e) => !trajSeenRef.current.has(e._k)).map((e) => e._k);
						list.forEach((e) => trajSeenRef.current.add(e._k));
						setTraj(list); setTrajErr(null);
						setTrajMeta({ runId: d.runId || null, total: Number(d.total) || 0, runs: Array.isArray(d.runs) ? d.runs : [] });
						if (!trajFirstRef.current && added.length) {
							setTrajNew(new Set(added));
							if (trajTimer.current) clearTimeout(trajTimer.current);
							trajTimer.current = setTimeout(() => setTrajNew(new Set()), 1600);
						}
						// todo/write 清单:对比上一份快照,只让新增条目滑入(首填不标)
						let lt = null; for (let j = list.length - 1; j >= 0; j--) { if (list[j].kind === "todo") { lt = list[j]; break; } }
						if (lt) {
							const titles = lt.todos.map((x) => x.content);
							const prev = prevTodoRef.current;
							if (prev && !trajFirstRef.current) {
								const nw = titles.filter((x) => !prev.has(x));
								if (nw.length) {
									setTodoNew(new Set(nw));
									if (todoTimer.current) clearTimeout(todoTimer.current);
									todoTimer.current = setTimeout(() => setTodoNew(new Set()), 1600);
								}
							}
							prevTodoRef.current = new Set(titles);
						}
						trajFirstRef.current = false;
					})
					.catch((e) => { if (runRef.current === myRun) setTrajErr(String((e && e.message) || e)); });
			}, [name, isLocal, selRunId]);
			React.useEffect(() => {
				if (isLocal) return;
				trajSeenRef.current = new Set(); trajFirstRef.current = true; prevTodoRef.current = null; trajBusy.current = false;
				setTraj([]); setTrajNew(new Set()); setTodoNew(new Set()); setRp({ mode: "live", on: false, t: 0, speed: 1 });
				const stop = startPoll(trajBusy, loadTraj, 2500);
				return () => { stop(); if (trajTimer.current) clearTimeout(trajTimer.current); if (todoTimer.current) clearTimeout(todoTimer.current); };
			}, [loadTraj, isLocal]);

			// —— 回放(按 event.time 驱动;只在 run 已结束时可用;reduced-motion 直接最终态)——
			const timed = traj.filter((e) => typeof e.time === "number");
			const t0 = timed.length ? timed[0].time : null;
			const tEnd = timed.length ? timed[timed.length - 1].time : null;
			const span = t0 != null ? Math.max(0, tEnd - t0) : 0;
			spanRef.current = span;
			const canReplay = !isLocal && !runInflight && timed.length >= 2 && span > 0;
			const replaying = canReplay && rp.mode === "replay";
			const cursor = replaying ? t0 + rp.t : Infinity;
			const shown = cursor === Infinity ? traj : traj.filter((e) => !(typeof e.time === "number" && e.time > cursor));
			React.useEffect(() => {
				if (!rp.on) return;
				const id = setInterval(() => setRp((p) => {
					const nt = p.t + 120 * p.speed;
					return nt >= spanRef.current ? { ...p, on: false, t: spanRef.current } : { ...p, t: nt };
				}), 120);
				return () => clearInterval(id);
			}, [rp.on, rp.speed]);
			const togglePlay = () => setRp((p) => {
				if (p.on) return { ...p, on: false };
				if (prefersReduced()) return { ...p, mode: "replay", on: false, t: spanRef.current };
				const restart = p.mode !== "replay" || p.t >= spanRef.current;
				return { ...p, mode: "replay", on: true, t: restart ? 0 : p.t };
			});

			// —— 步骤清单:有 todo/write 就用 worker 自己的清单,否则 tool/call↔result 配对 ——
			const pairing = React.useMemo(() => deriveSteps(shown, !runInflight && cursor === Infinity), [shown, runInflight, cursor]);
			let lastTodo = null; for (let i = shown.length - 1; i >= 0; i--) { if (shown[i].kind === "todo") { lastTodo = shown[i]; break; } }
			const todoSteps = lastTodo && lastTodo.todos.length
				? lastTodo.todos.map((x, i) => ({ key: "todo:" + i + ":" + x.content, title: x.content, status: x.status === "completed" ? "ok" : x.status === "in_progress" ? "running" : "pending", ms: null, args: "" }))
				: null;
			const steps = todoSteps || pairing;
			const stepSource = todoSteps ? "todo" : "tools";
			const stepsDone = steps.filter((s) => s.status === "ok" || s.status === "err").length;
			const openCall = [...pairing].reverse().find((s) => s.status === "running") || null;
			const lastCall = pairing.length ? pairing[pairing.length - 1] : null;

			// —— 生命周期 & 头部动词 ——
			const life = isLocal ? (inflightN > 0 ? "running" : "idle") : lifecycleOfRun(hd, selRun, traj.length > 0);
			const alive = life === "running" || life === "booting";
			let verb;
			if (life === "offline") verb = t("health.down");
			else if (life === "booting") verb = t("verb.boot");
			else if (runInflight || (replaying && cursor < tEnd)) verb = openCall ? verbText(t, openCall.name, false) : t("verb.think");
			else verb = lastCall ? t("verb.last", { verb: verbText(t, lastCall.name, true) }) : t("verb.none");

			useFollow(stepsEndRef, stepsBoxRef, steps.length, true);
			useFollow(trajEndRef, trajBoxRef, shown.length, surfTab === "traj");

			const openFile = (p) => {
				if (pick === p) { setPick(null); setContent(null); setReadErr(null); return; }
				setPick(p); setContent(null); setReadErr(null);
				getJSON("/api/fleet/ws?host=" + enc(name) + "&path=" + enc(p))
					.then((d) => { setContent(String(d.content ?? "")); })
					.catch((e) => { setReadErr(String((e && e.message) || e)); });
			};
			const fileRow = (f, label, dim) => h("button", {
				key: "f" + f.path, type: "button", title: f.path, onClick: () => openFile(f.path),
				className: "u-li dsh-fleet-rowbtn" + (pick === f.path ? " is-on" : "") + (justAdded.has(f.path) ? " u-land" : "") + (dim ? " dsh-fleet-dim" : ""),
			},
				h("span", { className: "u-grow u-mono" }, (justAdded.has(f.path) ? "✦ " : "") + label),
				h("span", { className: "u-cap u-num" }, fmtSize(f.size)));
			const preview = () => [
				readErr ? h("div", { key: "rerr", className: "u-err" }, t("ws.readFail", { err: readErr })) : null,
				pick && content !== null ? h("pre", { key: "pre", className: "u-pre" }, content || "(empty)") : null,
			];

			// —— run tab 文案 ——
			const runGlyph = (r) => (r.startedAt && !r.endedAt) ? "●" : r.ok === true ? "✓" : r.ok === false ? "✗" : "·";
			const runLabel = (r) => r.startedAt ? fmtClock(r.startedAt) : (r.mtime ? fmtClock(r.mtime) : String(r.runId).slice(0, 8));
			let runLine = null;
			if (selRun) {
				const parts = [];
				if (selRun.prompt) parts.push(t("run.prompt") + ":" + selRun.prompt);
				if (selRun.startedAt) parts.push(t("run.started", { t: fmtClock(selRun.startedAt) }));
				if (selRun.startedAt && !selRun.endedAt) parts.push(t("run.elapsed", { d: fmtDur(Date.now() - selRun.startedAt) }));
				else if (selRun.startedAt && selRun.endedAt) parts.push(t("run.took", { d: fmtDur(selRun.endedAt - selRun.startedAt) }));
				if (selRun.fromTrace) parts.push(t("run.traceOnly"));
				runLine = parts.join(" · ");
			}

			// —— 三段主体 ——
			const segTraj = () => h("div", null,
				h("div", { className: "u-note" }, t("traj.note")),
				trajErr ? h("div", { className: "u-err" }, trajErr) : null,
				shown.length === 0
					? h("div", { className: "u-empty" }, t("traj.empty"))
					: h("div", { className: "u-list dsh-fleet-scroll", ref: trajBoxRef },
						...shown.map((e) => {
							const cls = "u-trajrow" + (trajNew.has(e._k) ? " u-land" : "");
							if (e.kind === "tool") return h("div", { key: e._k, className: cls },
								h("span", { className: "u-tool" }, "→ " + e.name),
								e.args ? h("span", { className: "u-args", title: e.args }, e.args) : null);
							if (e.kind === "result") return h("div", { key: e._k, className: cls },
								h("span", { className: e.isError ? "u-errc" : "u-okc" }, e.isError ? "✗" : "✓"),
								h("span", { className: "u-args", title: e.text }, e.text || (e.isError ? t("traj.result.err") : t("traj.result.ok"))));
							if (e.kind === "step") return h("div", { key: e._k, className: cls },
								h("span", { className: "u-args" }, "— " + t("traj.step", { turn: e.turn != null ? e.turn : "?", step: e.step != null ? e.step : "?" }) + " —"));
							if (e.kind === "todo") return h("div", { key: e._k, className: cls },
								h("span", { className: "u-tool" }, "📋"),
								h("span", { className: "u-args" }, t("traj.todo", { n: e.todos.length })));
							return h("div", { key: e._k, className: cls },
								h("span", { className: "u-args" }, "💬"),
								h("span", { className: "u-text" }, e.text));
						}),
						h("div", { ref: trajEndRef }),
					),
			);
			const segWs = () => h("div", null,
				h("div", { className: "u-note" }, t("noStream")),
				wsErr ? h("div", { className: "u-err" }, wsErr) : null,
				h("div", { className: "dsh-fleet-bar" },
					h("span", { className: "u-cap u-mono dsh-fleet-ell" }, "📁 " + (hd.workspaceDir || "~/dsh-workspace")),
					h("span", { className: "u-cap u-num dsh-fleet-ml" }, files ? t("ws.files", { n: files.length }) : t("probing"))),
				files && files.length === 0 && !wsErr ? h("div", { className: "u-empty" }, t("ws.empty")) : null,
				files && files.length ? h("div", { className: "u-list dsh-fleet-scroll" }, ...files.map((f) => fileRow(f, f.path, false))) : null,
				...preview(),
				h("div", { className: "u-note dsh-fleet-sect" }, t("pickHint")),
			);
			const segArt = () => {
				const prefix = selRunId ? "tasks/" + selRunId + "/" : null;
				const all = files || [];
				const cur = prefix ? all.filter((f) => f.path.startsWith(prefix)) : [];
				const others = all.filter((f) => f.path.startsWith("tasks/") && !(prefix && f.path.startsWith(prefix)));
				return h("div", null,
					h("div", { className: "u-note" }, t("art.note")),
					wsErr ? h("div", { className: "u-err" }, wsErr) : null,
					h("div", { className: "u-sect dsh-fleet-sect" }, t("art.cur") + (selRunId ? " · " + selRunId : "")),
					!selRunId ? h("div", { className: "u-note" }, t("art.noRun"))
						: cur.length ? h("div", { className: "u-list dsh-fleet-scroll" }, ...cur.map((f) => fileRow(f, f.path.slice(prefix.length), false)))
						: h("div", { className: "u-note" }, files === null ? t("probing") : t("art.empty")),
					others.length ? h("div", { className: "u-sect dsh-fleet-sect" }, t("art.other") + " · " + others.length) : null,
					others.length ? h("div", { className: "u-list dsh-fleet-scroll" }, ...others.slice(0, 40).map((f) => fileRow(f, f.path.slice(6), true))) : null,
					...preview(),
				);
			};

			// —— 步骤清单行 ——
			const stepRows = steps.map((s) => {
				const cur = s.status === "running";
				const dotCls = s.status === "ok" ? "u-dot is-ok" : s.status === "err" ? "u-dot is-bad" : (cur && runInflight ? "u-dot is-run" : "u-dot");
				const liCls = "u-li" + (cur ? " is-on" : "") + (s.status === "err" ? " is-bad" : "") + ((trajNew.has(s.key) || todoNew.has(s.title)) ? " u-land" : "");
				const tail = s.ms != null ? h("span", { className: "u-cap u-num" }, fmtDur(s.ms))
					: s.status === "running" ? h("span", { className: "u-cap" }, t("step.running"))
					: s.status === "cut" ? h("span", { className: "u-cap" }, t("step.cut"))
					: s.status === "pending" ? h("span", { className: "u-cap" }, t("step.pending")) : null;
				return h("div", { key: s.key, className: liCls, title: s.args || s.title },
					h("span", { className: dotCls }),
					h("span", { className: "u-grow" + (stepSource === "tools" ? " u-mono" : "") }, s.title),
					tail);
			});

			const remoteBody = () => [
				runs.length ? h("div", { key: "runs", className: "dsh-fleet-bar" },
					h("span", { className: "u-cap" }, t("runs.label")),
					h("div", { className: "dsh-fleet-runs" }, h("div", { className: "u-segs" },
						...runs.map((r) => h("button", {
							key: r.runId, type: "button", title: r.prompt || r.runId,
							className: "u-seg" + (r.runId === selRunId ? " is-on" : ""),
							onClick: () => setPickedRun(r.runId),
						}, runGlyph(r) + " " + runLabel(r)))))) : null,
				runLine ? h("div", { key: "runline", className: "u-note dsh-fleet-ell", title: selRun && selRun.prompt ? selRun.prompt : "" }, runLine) : null,
				selRun && selRun.error ? h("div", { key: "runerr", className: "u-err" }, t("run.error", { err: selRun.error })) : null,
				h("div", { key: "segs", className: "dsh-fleet-bar" },
					h("div", { className: "u-segs" },
						h("button", { type: "button", className: "u-seg" + (surfTab === "traj" ? " is-on" : ""), onClick: () => setSurfTab("traj") }, t("seg.traj")),
						h("button", { type: "button", className: "u-seg" + (surfTab === "ws" ? " is-on" : ""), onClick: () => setSurfTab("ws") }, t("seg.ws")),
						h("button", { type: "button", className: "u-seg" + (surfTab === "art" ? " is-on" : ""), onClick: () => setSurfTab("art") }, t("seg.art"))),
					h("span", { className: "u-cap u-num dsh-fleet-ml" },
						surfTab === "traj" ? t("traj.count", { n: shown.length, total: trajMeta.total || traj.length }) : (files ? t("ws.files", { n: files.length }) : t("probing")))),
				h("div", { key: "body" }, surfTab === "traj" ? segTraj() : surfTab === "ws" ? segWs() : segArt()),
				h("div", { key: "ptitle", className: "u-sect dsh-fleet-sect" },
					t("progress.title") + " · " + stepsDone + "/" + steps.length + (stepSource === "todo" ? " · " + t("progress.todo") : "")),
				steps.length
					? h("div", { key: "steps", className: "u-list dsh-fleet-scroll", ref: stepsBoxRef }, ...stepRows, h("div", { ref: stepsEndRef }))
					: h("div", { key: "steps", className: "u-note" }, t("progress.empty")),
				canReplay ? h("div", { key: "replay", className: "dsh-fleet-bar dsh-fleet-sect" },
					h("div", { className: "u-segs" },
						h("button", { type: "button", className: "u-seg", title: rp.on ? t("replay.pause") : t("replay.play"), onClick: togglePlay }, rp.on ? "⏸" : "▶"),
						...[1, 3, 8].map((x) => h("button", { key: x, type: "button", className: "u-seg" + (rp.speed === x ? " is-on" : ""), onClick: () => setRp((p) => ({ ...p, speed: x })) }, x + "×")),
						h("button", { type: "button", className: "u-seg" + (rp.mode === "live" ? " is-on" : ""), onClick: () => setRp((p) => ({ ...p, mode: "live", on: false, t: 0 })) }, t("replay.live"))),
					h("span", { className: "u-cap u-num" }, replaying ? fmtDur(rp.t) + " / " + fmtDur(span) : fmtDur(span))) : null,
			];

			const localBody = () => [
				h("div", { key: "note", className: "u-note" }, t("local.note")),
				hostRuns.length
					? h("div", { key: "runs", className: "u-list dsh-fleet-sect" }, ...hostRuns.map((r) => h("div", { key: r.runId, className: "u-li", title: r.prompt || "" },
						h("span", { className: (r.startedAt && !r.endedAt) ? "u-dot is-run" : r.ok === false ? "u-dot is-bad" : "u-dot is-ok" }),
						h("span", { className: "u-grow" }, r.prompt || r.runId),
						h("span", { className: "u-cap u-num" }, r.endedAt && r.startedAt ? fmtDur(r.endedAt - r.startedAt) : fmtClock(r.startedAt)))))
					: h("div", { key: "empty", className: "u-empty" }, t("local.noRuns")),
			];

			return h("div", null,
				h("div", { className: "dsh-fleet-bar" },
					h("button", { type: "button", className: "u-btn", onClick: props.onBack }, "← " + t("back")),
					isLocal ? null : h("button", { type: "button", className: "u-btn", onClick: () => { pollGuard(wsBusy, load); pollGuard(trajBusy, loadTraj); } }, t("ws.refresh")),
					h("span", { className: "u-cap u-num dsh-fleet-ml" }, isLocal ? t("kind.local") : (hd.version || ""))),
				h("div", { className: "u-head" },
					h("span", { className: "u-avatar" }, isLocal ? "💻" : "🖥️"),
					h("div", { className: "u-body" },
						h("div", { className: "u-name" }, t("computer", { name })),
						h("div", { className: "u-sub" },
							h("span", { className: "u-badge " + LIFE[life].cls }, t(LIFE[life].key)),
							replaying ? h("span", { className: "u-badge is-warn" }, t("replay.badge")) : null,
							// key=文案:换词时重挂 → 只做 opacity 淡入(u-t2)
							h("span", { key: verb, className: "dsh-fleet-xfade dsh-fleet-ell", title: verb }, verb))),
					alive
						? h("span", { className: "u-live" }, h("span", { className: "u-dot is-run" }), t("live"))
						: h("span", { className: "u-live is-idle" }, t("persist"))),
				...(isLocal ? localBody() : remoteBody()),
			);
		}

		// ── 机架里的一台机器瓦片 ──────────────────────────────────────────────
		// 运行中有且仅有一处呼吸(头部 u-dot.is-run);闲置零动画。生命周期用 .u-badge。
		function Tile(props) {
			const t = props.t;
			const host = props.host;
			const ok = host.ok === true;
			const inflight = Number(host.inflight) || 0;
			const isRemote = host.kind === "remote";
			const isLocal = host.kind === "local";
			const os = osTag(host.tags);
			const life = lifecycleOfHost(host);
			const dotCls = !ok ? "u-dot is-bad" : inflight > 0 ? "u-dot is-run" : "u-dot is-ok";
			const conc = (inflight > 0 ? t("busy") : t("idle")) + " " + inflight + "/" + (Number(host.maxConcurrency) || 0);
			const runs = Array.isArray(host.runs) ? host.runs : [];
			const newest = runs.find((r) => r && !r.endedAt) || null;
			const last = runs[0] || null;
			const clickable = ok && (isRemote || isLocal);
			const open = () => { if (clickable && props.onOpen) props.onOpen(host.name); };

			return h("div", {
				className: "u-tile dsh-fleet-tile" + (clickable ? "" : " is-off"),
				onClick: clickable ? open : undefined,
				role: clickable ? "button" : undefined,
				tabIndex: clickable ? 0 : undefined,
				onKeyDown: clickable ? (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } } : undefined,
			},
				h("div", { className: "dsh-fleet-tilehead" },
					h("span", { className: dotCls, title: ok ? "" : t("health.down") }),
					h("span", { className: "u-mono dsh-fleet-tname", title: host.name }, host.name),
					h("span", { className: "u-badge " + LIFE[life].cls }, t(LIFE[life].key))),
				kv(t("label.kind"), (isRemote ? t("kind.remote") : t("kind.local")) + (os ? " · " + t("os." + os) : "")),
				kv(t("label.model"), host.model || "—"),
				host.version ? kv(t("label.version"), host.version) : null,
				kv(t("label.conc"), conc, inflight > 0),
				inflight > 0 && (host.currentTask || (newest && newest.prompt))
					? kv(t("label.task"), host.currentTask || newest.prompt, true)
					: null,
				(life === "doneOk" || life === "doneErr") && last
					? kv(t("label.last"), (last.ok ? "✓ " : "✗ ") + fmtDur((last.endedAt || 0) - (last.startedAt || 0)) + (last.prompt ? " · " + last.prompt : ""), false, last.prompt || "")
					: null,
				isRemote && ok && typeof host.wsFiles === "number"
					? h("div", { className: "u-note dsh-fleet-wsrow" },
						"📁 " + t("ws.files", { n: host.wsFiles }),
						host.workspaceDir ? h("span", null, " · ", h("span", { className: "u-mono" }, host.workspaceDir)) : null)
					: null,
				!ok && host.error ? h("div", { className: "u-err dsh-fleet-wsrow" }, host.error) : null,
				clickable ? h("div", { className: "u-cap dsh-fleet-foot" }, h("span", { className: "u-hit" }, t("enter") + " →")) : null,
			);
		}

		// ── 机架 ─────────────────────────────────────────────────────────────
		function FleetRack() {
			React.useEffect(injectStyle, []);
			const t = useT();
			const [hosts, setHosts] = React.useState(null); // null=首次探测中
			const [err, setErr] = React.useState(null);
			const [focused, setFocused] = React.useState(null);
			const [, setTick] = React.useState(0);
			const hostsBusy = React.useRef(false);

			const load = React.useCallback(() => getJSON("/api/fleet/hosts")
				.then((d) => { setHosts(Array.isArray(d.hosts) ? d.hosts : []); setErr(null); })
				.catch((e) => { setErr(String((e && e.message) || e)); }), []);
			React.useEffect(() => {
				return startPoll(hostsBusy, load, 5000);
			}, [load]);
			// 只在有机在跑 / 刚结束驻留期内才 1s 心跳(Tile 的 开机中→执行中、刚结束→空闲 过渡靠它)
			const needTick = !focused && (hosts || []).some((x) =>
				(Number(x.inflight) || 0) > 0 || (Array.isArray(x.runs) && x.runs.some((r) => r && r.endedAt && Date.now() - r.endedAt < DONE_HOLD_MS + 1500)));
			React.useEffect(() => {
				if (!needTick) return;
				const id = setInterval(() => setTick((x) => x + 1), 1000);
				return () => clearInterval(id);
			}, [needTick]);

			const shell = (...kids) => h("div", { className: "u-shell", "data-dsh-fleet": "" }, h("div", { className: "u-main" }, ...kids));

			if (hosts === null && !err) return shell(h("div", { className: "u-empty" }, t("probing")));
			if (hosts === null && err) {
				return shell(h("div", { className: "u-empty" },
					t("err.load", { err }),
					h("div", { className: "dsh-fleet-sect" }, h("button", { type: "button", className: "u-btn", onClick: () => pollGuard(hostsBusy, load) }, t("ws.refresh")))));
			}

			const focusedHost = focused ? (hosts || []).find((x) => x.name === focused) : null;
			if (focusedHost) return shell(h(ComputerPane, { key: focused, host: focusedHost, t, onBack: () => setFocused(null) }));

			const online = (hosts || []).filter((x) => x.ok === true).length;
			const running = (hosts || []).filter((x) => (Number(x.inflight) || 0) > 0).length;
			return shell(
				h("div", { className: "u-topbar" },
					h("div", { className: "u-h1row" },
						h("span", { className: "u-h1" }, t("title")),
						h("span", { className: "u-stat" }, h("b", null, online), t("stat.online")),
						h("span", { className: "u-stat" }, h("b", null, running), t("stat.running")),
						h("button", { type: "button", className: "u-btn dsh-fleet-ml", onClick: () => pollGuard(hostsBusy, load) }, t("ws.refresh"))),
					h("div", { className: "u-subtitle" }, t("subtitle")),
					err ? h("div", { className: "u-err" }, t("err.load", { err })) : null),
				h("div", { className: "u-rack" }, ...(hosts || []).map((host) => h(Tile, { key: host.name, host, t, onOpen: setFocused }))),
			);
		}

		// ── 注册槽位 ──────────────────────────────────────────────────────────
		function apply(ctx) {
			const slots = ctx.get("slots");
			if (slots === undefined) return;
			// 字典注册要在 slots.register 之前:页签 label 是宿主按 locale 快照重取的。
			const locale = ctx.get("locale");
			if (locale) {
				LOCALE = locale;
				try {
					ctx.effect(() => locale.register(NS, DICT), "fleet-machines i18n");
				} catch (e) {
					console.warn("[fleet-machines] locale.register failed:", e);
				}
			}
			const tTab = locale ? locale.bind(NS) : fallbackT;
			// 独立 cell(id=fleet-machines,order 12:紧跟 trace 的 11)。全局视图,不吃 session。
			slots.inject("conversation.view", () =>
				slots.register(
					{
						name: "conversation.view",
						locale: NS,
						id: "fleet-machines",
						order: 12,
						label: () => tTab("tab"),
					},
					FleetRack,
				),
			);
			// AgOS 控制台 section(C4,2026-08-20):同一个 FleetRack 投稿进 @dsh-local/agos
			// 面板声明的 agos.section 子槽 —— 会话无关的 OS 级机器视图。
			// inject 会等 agos 声明就绪;agos 插件不在时此注册永不触发,零成本。
			// 包一层固定高度容器(agos-sec--tall,类来自 agos 的样式表;只在 agos 面板里渲染,
			// 类必然已注入),FleetRack 的 u-shell height:100% 才有参照、内部滚动才生效。
			// v3(2026-08-20):机器页专槽(single)——agos 控制台左导航「机器」页整页交给 FleetRack,
			// 容器高度由 agos 的 .agos-page--fill 提供(u-shell height:100% 有参照)。
			slots.inject("agos.page.machines", () =>
				slots.register({ name: "agos.page.machines", locale: NS }, FleetRack),
			);
		}

		exports.apply = apply;
		exports.inject = ["slots", "locale"];
		// 纯函数出口(仅供 node 侧单测,不参与宿主装配)
		exports.__pure = { parseTraceEvent, deriveSteps, mergeRuns, verbKey, argsSummary, lifecycleOfHost, lifecycleOfRun, fmtDur, fmtClock };
		return module.exports;
	},
});
