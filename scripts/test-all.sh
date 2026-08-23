#!/bin/zsh
# 产品仓全闸:前端 verify(含 vendor:diff 契约零漂移)+ 五个插件 node --test + 部署漂移检查。零模型调用。
set -u
ROOT="${0:A:h:h}"
rc=0
print "▸ frontend: npm run verify"
(cd "$ROOT/frontend" && npm run verify 2>&1 | /usr/bin/grep -E '^ℹ (pass|fail)|零漂移|漂移' ) || rc=1
for p in dsh-agos dsh-agos-router dsh-mcp-bridge cn-capabilities dsh-fleet; do
	printf "▸ plugins/%s: " "$p"
	out="$(cd "$ROOT/plugins/$p" && node --test test/*.mjs 2>&1)"
	print -r -- "$out" | /usr/bin/grep -E '^ℹ (pass|fail)' | tr '\n' ' '; print
	print -r -- "$out" | /usr/bin/grep -q '^ℹ fail 0' || rc=1
done
print "▸ deploy drift"
"$ROOT/scripts/deploy-plugins.sh" --check || rc=1
exit $rc
