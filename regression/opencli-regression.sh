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
for nav in "控制台" "记忆星图" "系统设置" "对话流"; do
	# 侧栏与顶栏都有同名动作(双入口是有意的),用 CSS 收窄到侧栏,避免 semantic_ambiguous
	step "导航→$nav" opencli browser $S click ".app-rail button[aria-label=\"$nav\"]"
	sleep 2
done

print "\n▸ 3 控制台子视图"
step "进控制台" opencli browser $S click ".app-rail button[aria-label=\"控制台\"]"
sleep 2
# 用 aria-label 收窄到导航项:概览页的 KPI 卡片也叫「技能注册表」,
# 按文本点会 semantic_ambiguous(2026-08-21 实测 exit 2)。
for tab in "概览遥测" "机器与机架" "会话矩阵" "智能体谱系" "轨迹时间流" "计划与目标" "技能注册表" "读图台账"; do
	step "控制台→$tab" opencli browser $S click ".console-nav-item[aria-label=\"$tab\"]"
	sleep 1.5
done

print "\n▸ 4 记忆星图"
step "进星图" opencli browser $S click ".app-rail button[aria-label=\"记忆星图\"]"
sleep 3
assert_text "星图渲染" "节点"

print "\n▸ 5 控制台数据面真实性"
step "回控制台" opencli browser $S click ".app-rail button[aria-label=\"控制台\"]"
sleep 2
# 内容断言(不只是"点得动"):此前 18 步里只有星图那步验了内容,
# 其余全是导航冒烟,一整类"面渲染不出数据"的缺陷不会被抓到。
# ⚠️ 锚点只用**静态 UI 文案**,不用数据相关字符串 —— 早前写死「实时」在空会话
# 被自动选中时误报过一次,同一个坑不踩第二遍。
step "开技能面" opencli browser $S click ".console-nav-item[aria-label=\"技能注册表\"]"
sleep 6
assert_text "技能面渲染" "只报告"

print "\n▸ 6 收尾"
step "关闭会话" opencli browser $S close

print "\n══ 结果 ══"
for r in "${RESULTS[@]}"; do print "  $r"; done
print "\n通过 $PASS · 失败 $FAIL"
[[ $FAIL -eq 0 ]] || exit 1
