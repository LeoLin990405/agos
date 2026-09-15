#!/bin/zsh
# A4 的元证明:把验收器故意改坏,证明负控**抓得到**。
# 负控全绿本身不说明问题 —— 一个空转的自检也会全绿。这里逐条制造"谎报成功"的改动,
# 每种改动都必须让特定负控变红。改坏的副本跑完即删,真正的 run-acceptance.mjs 不动。
set -u
HERE="${0:A:h}"
cd "$HERE"
REAL="run-acceptance.mjs"
rc=0

mutate() {
	local name="$1" desc="$2" expect="$3" pyexpr="$4"
	local mutant="mutant-${name}.mjs"
	python3 - "$REAL" "$mutant" "$pyexpr" <<'PY'
import sys, pathlib
src, dst, expr = sys.argv[1], sys.argv[2], sys.argv[3]
s = pathlib.Path(src).read_text()
old, new = expr.split('||=>||')
assert old in s, f"mutation anchor missing: {old[:60]}"
pathlib.Path(dst).write_text(s.replace(old, new))
PY
	if [[ $? -ne 0 ]]; then print "❌ 无法生成变异体 $name"; rc=1; return; fi
	print ""
	print "── 变异体 $name:$desc"
	print "   期望被抓的负控:$expect"
	local out
	out="$(cd ../.. && AGOS_SELFTEST_RUNNER="scripts/acceptance/$mutant" node --test scripts/acceptance/selftest.mjs 2>&1)"
	local caught
	caught="$(print -r -- "$out" | /usr/bin/grep -E '^✖ (META|NC[0-9a-b]+)' | sed -E 's/^✖ ([A-Za-z0-9]+):.*/\1/' | tr '\n' ' ')"
	local nfail
	nfail="$(print -r -- "$out" | /usr/bin/grep -cE '^✖ (META|NC[0-9a-b]+)')"
	if [[ "$nfail" -gt 0 ]]; then
		print "   ✅ 被抓到($nfail 条负控变红): $caught"
	else
		print "   ❌ 没抓到!负控在这个变异体下仍然全绿 —— 说明负控是空转的"
		rc=1
	fi
	rm -f "$mutant"
}

print "== 负控非空转证明:故意改坏验收器,看负控是否变红 =="

mutate "drift-into-gate" \
	"把部署漂移当成代码闸(advisory 通道消失)" \
	"NC3a" \
	"const codeResults = plan.codeGates.map((g) => runGate(g, 'code'))
const advisoryResults = (plan.advisory ?? []).map((g) => runGate(g, 'advisory'))||=>||const codeResults = [...plan.codeGates, ...(plan.advisory ?? [])].map((g) => runGate(g, 'code'))
const advisoryResults = []"

mutate "skip-as-pass" \
	"把 skip 数并进 pass 数" \
	"NC5a / NC5b" \
	"	totals.pass += r.counts.pass||=>||	totals.pass += r.counts.pass + r.counts.skipped"

mutate "green-always" \
	"只看退出码,不看 verdict(empty/skipped 都算绿)" \
	"NC2 / NC5a" \
	"const failedGates = codeResults.filter((r) => r.required && !isGreen(r.verdict))||=>||const failedGates = codeResults.filter((r) => r.required && r.exitCode !== 0)"

mutate "missing-dep-as-skip" \
	"缺宿主包降级成 skip(而不是失败)" \
	"NC4" \
	"			counts: null, verdict: 'fail', reason: \`missing-host-modules:\${missingForPlugin.join(',')}\`,||=>||			counts: null, verdict: 'skipped', reason: \`missing-host-modules:\${missingForPlugin.join(',')}\`,"

mutate "exit-always-zero" \
	"进程退出码恒为 0" \
	"NC1 / NC2 / NC5a / NC6" \
	"
process.exit(codeGateExit)||=>||
process.exit(0)"

print ""
if (( rc == 0 )); then
	print "✅ 全部变异体都被负控抓到 —— 负控不是空转"
else
	print "❌ 有变异体没被抓到"
fi
exit $rc
