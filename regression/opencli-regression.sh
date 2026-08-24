#!/bin/zsh
# AgOS 全站回归(OpenCLI browser bridge 驱动真实 Chrome)
#
# 纪律:
#   · 串行——同一 bridge 不并发,链式用 && 保证 ref 不过期
#   · 只做只读导航与视图切换,不发任何 prompt(零模型调用)
#   · 每步检查 envelope 的 match_level 与错误码,失败即停并打印现场
#
# 用法:./opencli-regression.sh [base_url]
set -uo pipefail

BASE="${1:-http://127.0.0.1:3091/agos/}"
S="agos-reg"
PASS=0; FAIL=0
RESULTS=()

step() {  # step <名称> <命令...>
	local name="$1"; shift
	local out rc
	out="$("$@" 2>&1)"; rc=$?
	if [[ $rc -eq 0 ]]; then
		PASS=$((PASS+1)); RESULTS+=("PASS  $name")
		print "✅ $name"
	else
		FAIL=$((FAIL+1)); RESULTS+=("FAIL  $name (exit $rc)")
		print "❌ $name (exit $rc)"
		print "$out" | /usr/bin/head -12
	fi
}

# 断言页面内某文本存在(用 extract 抓正文再 grep)
assert_text() {  # assert_text <名称> <期望文本>
	local name="$1" needle="$2" body
	body="$(opencli browser $S extract --chunk-size 20000 2>/dev/null)"
	if print -r -- "$body" | /usr/bin/grep -q -- "$needle"; then
		PASS=$((PASS+1)); RESULTS+=("PASS  $name"); print "✅ $name（命中「$needle」）"
	else
		FAIL=$((FAIL+1)); RESULTS+=("FAIL  $name（未见「$needle」）"); print "❌ $name（未见「$needle」）"
	fi
}

print "══ AgOS 全站回归 · $BASE ══"
print "▸ 0 健康检查"
opencli doctor >/dev/null 2>&1 || { print "❌ opencli 桥接不健康,先跑 opencli doctor"; exit 69 }
print "✅ 桥接健康"

print "\n▸ 1 载入首屏"
step "打开 SPA" opencli browser $S open "$BASE"
sleep 3
# 断言要与数据无关:早前写死「实时」会在自动选中空会话时误报(空态没有回放条)
step "首屏标题" opencli browser $S get title

print "\n▸ 2 主导航四面"
# e75278e 把侧栏「记忆星图」改成了「记忆」(记忆工作台三栏),aria-label 跟着改;内容锚仍是 019 的「星图已采集」。
for nav in "控制台" "记忆" "系统设置" "对话流"; do
	# 侧栏与顶栏都有同名动作(双入口是有意的),用 CSS 收窄到侧栏,避免 semantic_ambiguous
	step "导航→$nav" opencli browser $S click ".app-rail button[aria-label=\"$nav\"]"
	sleep 2
done

print "\n▸ 3 控制台子视图"
step "进控制台" opencli browser $S click ".app-rail button[aria-label=\"控制台\"]"
sleep 2
# 用 aria-label 收窄到导航项:概览页的 KPI 卡片也叫「技能注册表」,
# 按文本点会 semantic_ambiguous(2026-08-21 实测 exit 2)。
for tab in "概览遥测" "机器与机架" "会话矩阵" "智能体谱系" "轨迹时间流" "计划与目标" "技能注册表" "路由决策" "读图台账"; do
	step "控制台→$tab" opencli browser $S click ".console-nav-item[aria-label=\"$tab\"]"
	sleep 1.5
done

# 冻结层 codex 放行(2026-08-23):机器区要真渲染机器卡,锚「已配置」只在 /api/fleet/hosts 解析成功后出现;
# 解析失败时页头是「等待 SSH 探测结果」+ TypeError 原文(08-21 到 08-23 现网就是这样,回归当时只点了 tab 没断内容)。
# 探测要等四台不可达机器 SSH 超时,首屏是「等待 SSH 探测结果」;轮询到「已配置」出现为止(上限 60s),
# 再断 codex 卡原样在(不是被藏)且没有解析 TypeError。
step "进机器与机架" opencli browser $S click ".console-nav-item[aria-label=\"机器与机架\"]"
for i in {1..12}; do
	body="$(opencli browser $S extract --chunk-size 20000 2>/dev/null)"
	print -r -- "$body" | /usr/bin/grep -q -- "SSH 探测于" && break
	sleep 5
done
# 页头「已配置 N」在 extract 的正文区之外(实测 extract 从「### 机架」起),用机器卡上的探测时间句当锚
assert_text "机器区渲染(hosts 解析成功)" "SSH 探测于"
assert_text "codex 主机原样显示" "codex"
assert_no_text() {  # assert_no_text <名称> <不该出现的文本>
	local name="$1" needle="$2" body
	body="$(opencli browser $S extract --chunk-size 20000 2>/dev/null)"
	if print -r -- "$body" | /usr/bin/grep -q -- "$needle"; then
		FAIL=$((FAIL+1)); RESULTS+=("FAIL  $name（出现了「$needle」）"); print "❌ $name（出现了「$needle」）"
	else
		PASS=$((PASS+1)); RESULTS+=("PASS  $name"); print "✅ $name（未见「$needle」）"
	fi
}
assert_no_text "hosts 解析不再 throw" "must be local or remote"
# W13:概览额度台账;锚只在载荷到达后出现(loading 态不渲染这句)。
step "回概览" opencli browser $S click ".console-nav-item[aria-label=\"概览遥测\"]"
sleep 3
assert_text "额度台账渲染" "后端全局 stale="
# W16:收件箱副标题由来源状态算出;锚按台账当下的状态选,不把「pending>0」写死成无条件 needle。
PENDING=$(curl -s --noproxy '*' http://127.0.0.1:3091/api/agos/routes | python3 -c 'import sys,json; print(json.load(sys.stdin)["stats"]["pending"])' 2>/dev/null || echo "?")
if [ "$PENDING" != "?" ] && [ "$PENDING" -gt 0 ] 2>/dev/null; then
	assert_text "收件箱路由分支渲染(pending=$PENDING)" "$PENDING 条路由决策待回填结果"
else
	assert_text "收件箱路由分支空(pending=$PENDING)" "来源:谱系进度"
fi
assert_text "收件箱来源行渲染" "来源:谱系进度"

print "\n▸ 4 记忆星图"
step "进星图" opencli browser $S click ".app-rail button[aria-label=\"记忆\"]"
sleep 3
assert_text "星图渲染" "星图已采集"
assert_text "补链对照" "补链对照已采集"

print "\n▸ 5 控制台数据面真实性"
step "回控制台" opencli browser $S click ".app-rail button[aria-label=\"控制台\"]"
sleep 2
# 内容断言(不只是"点得动"):此前 18 步里只有星图那步验了内容,
# 其余全是导航冒烟,一整类"面渲染不出数据"的缺陷不会被抓到。
# ⚠️ 锚点必须是「有数据才会出现」的文案,不能是无条件表头。
# 每条 assert_text 都要能在对应路由 404 时变红。无条件表头会在失败态照样绿
# —— TASK-015 W7 / 017 / 018 三次复发的同一类问题。
# 早前写死「实时」在空会话被自动选中时误报过一次,那个坑也不踩。
step "开技能面" opencli browser $S click ".console-nav-item[aria-label=\"技能注册表\"]"
sleep 6
assert_text "技能面渲染" "只报告"
assert_text "技能分母" "使用率分母已采集"
step "开路由面" opencli browser $S click ".console-nav-item[aria-label=\"路由决策\"]"
sleep 6
assert_text "路由面渲染" "路由档位"
# W10:结果行覆盖视图挂在路由面下方;锚「带完整标签」只在载荷到达后出现(小标题是无条件的,不能当锚)。
assert_text "结果行覆盖" "带完整标签"
# W17:路由台账里真有一条影子决策行(2026-08-23 dec-1787493862865,Claude 验证 #1)时,路由页要把它标成「影子建议」;
# 锚按台账当下有没有 mode=shadow 行选,没有就断「路由档位」已过即可。
# 锚按行的真实字段选:source=selector 的影子行渲染「影子建议（未驱动派发）」,回落行渲染「影子：选择器未产出建议」;
# 未挂批次的行渲染「尚未派发或未关联批次」,挂了的渲染「批次 b-…」。台账什么形态就断什么,正确行为不会把回归打红。
SHADOW_KIND=$(curl -s --noproxy '*' 'http://127.0.0.1:3091/api/agos/routes?limit=50' | python3 -c '
import sys,json
rows=[d for d in json.load(sys.stdin)["decisions"] if d.get("mode")=="shadow"]
if not rows: print("none"); sys.exit()
last=rows[-1]
print(("selector" if last.get("source")=="selector" else "fallback")+":"+("linked" if last.get("batchRef") else "unlinked"))' 2>/dev/null || echo none)
case "$SHADOW_KIND" in
	selector:unlinked) assert_text "影子决策行(selector,未关联)" "影子建议（未驱动派发）"; assert_text "影子行补充句" "尚未派发或未关联批次" ;;
	selector:linked)   assert_text "影子决策行(selector,已关联)" "影子建议（未驱动派发）"; assert_text "影子行补充句" "批次 b-" ;;
	fallback:*)        assert_text "影子决策行(回落)" "影子：选择器未产出建议" ;;
	*) ;;
esac

# 影子成绩单(4d309d0):覆盖句尾的成绩短语由 stats.shadow 算出——台账什么形态就断什么。
# suggested>0 才有「与勾选一致 a/s」;0<filled<5 断「样本不足，不出比率」;filled>=5 断「被采纳建议终态」。
SCORE_KIND=$(curl -s --noproxy '*' 'http://127.0.0.1:3091/api/agos/routes?limit=1' | python3 -c '
import sys,json
sh=json.load(sys.stdin)["stats"].get("shadow") or {}
sug=sh.get("suggested",0); fil=sh.get("filled",0)
print(("agree" if sug>0 else "noagree")+":"+("none" if fil==0 else ("few" if fil<5 else "many"))+":"+str(sh.get("agreed",0))+"/"+str(sug))' 2>/dev/null || echo skip)
case "$SCORE_KIND" in
	agree:few:*)  assert_text "成绩单一致数" "与勾选一致 ${SCORE_KIND##*:}"; assert_text "成绩单拒出比率" "样本不足，不出比率" ;;
	agree:many:*) assert_text "成绩单一致数" "与勾选一致 ${SCORE_KIND##*:}"; assert_text "成绩单终态短语" "被采纳建议终态" ;;
	agree:none:*) assert_text "成绩单一致数" "与勾选一致 ${SCORE_KIND##*:}" ;;
	*) ;;
esac
step "开读图台账" opencli browser $S click ".console-nav-item[aria-label=\"读图台账\"]"
sleep 6
assert_text "读图台账渲染" "读图台账已采集"
step "开轨迹面" opencli browser $S click ".console-nav-item[aria-label=\"轨迹时间流\"]"
sleep 4
# 可接入计数与「接入」按钮同源(TraceView 的 joinIdOf):按钮读它、这句也读它。
# 归档会话不计入 —— 点它会被对话页守卫弹到别处。extract 读不到 <button> 文案,
# 按钮本体由 trace-join.test.ts 的源锁守(2026-08-22 验收 P1)。
assert_text "轨迹接入" "可接入"

print "\n▸ 6 收尾"
step "关闭会话" opencli browser $S close

print "\n══ 结果 ══"
for r in "${RESULTS[@]}"; do print "  $r"; done
print "\n通过 $PASS · 失败 $FAIL"
[[ $FAIL -eq 0 ]] || exit 1
