#!/bin/zsh
# 产品仓全闸:前端 verify(含 vendor:diff 对 pin 对象)+ 五个插件 node --test + 部署漂移检查。零模型调用。
# 被测命令的退出码以生产者为准;grep 只过滤显示,匹配失败不把成功改成失败,也不把失败改成成功。
set -u
setopt PIPE_FAIL
ROOT="${0:A:h:h}"

# Run command (optional AGOS_CMD_CWD); print FILTER matches; return the command's exit.
agos_keep_exit() {
	local filter="$1"
	shift
	local tmp rc=0
	tmp="$(mktemp "${TMPDIR:-/tmp}/agos-keep-exit.XXXXXX")" || return 2
	if [[ -n "${AGOS_CMD_CWD:-}" ]]; then
		( cd "$AGOS_CMD_CWD" || exit 1; "$@" ) >"$tmp" 2>&1 || rc=$?
	else
		"$@" >"$tmp" 2>&1 || rc=$?
	fi
	if (( rc != 0 )); then
		cat "$tmp"
	elif [[ -n "$filter" ]]; then
		/usr/bin/grep -E -- "$filter" "$tmp" || true
	else
		cat "$tmp"
	fi
	rm -f "$tmp"
	return $rc
}

if [[ "${AGOS_TEST_ALL_HELPERS_ONLY:-}" == 1 ]]; then
	return 0 2>/dev/null || exit 0
fi

rc=0
print "▸ frontend: npm run verify"
if ! AGOS_CMD_CWD="$ROOT/frontend" agos_keep_exit '^ℹ (pass|fail)|零漂移|漂移|verified:|vendor-diff:|environment unsatisfied|error TS' npm run verify; then
	rc=1
fi
for p in dsh-agos dsh-agos-router dsh-mcp-bridge cn-capabilities dsh-fleet; do
	printf "▸ plugins/%s: " "$p"
	plugin_rc=0
	out="$(cd "$ROOT/plugins/$p" && node --test test/*.mjs 2>&1)" || plugin_rc=$?
	print -r -- "$out" | /usr/bin/grep -E '^ℹ (pass|fail)' | tr '\n' ' '; print
	if (( plugin_rc != 0 )); then
		print -r -- "$out"
		rc=1
	fi
	print -r -- "$out" | /usr/bin/grep -q '^ℹ fail 0' || rc=1
done
print "▸ deploy drift"
"$ROOT/scripts/deploy-plugins.sh" --check || rc=1
exit $rc
