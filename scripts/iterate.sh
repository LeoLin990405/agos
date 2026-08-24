#!/bin/zsh
# AgOS 一条命令的迭代循环:构建前端 → 部署插件 → (仅当插件真变了)重启 3091 → 健康检查。
#
# 事实依据(2026-08-24 读 serveSpa 源码):dsh-agos 每个请求都从磁盘读 frontend/dist,
# 所以**前端改动不需要重启**,build 完刷新页面即可;只有插件改动要重启(插件代码在进程里)。
#
# 用法:scripts/iterate.sh            # 完整一轮
#       scripts/iterate.sh --restart  # 插件没变也强制重启 3091
#       scripts/iterate.sh --no-build # 跳过前端构建(只动了插件时)
#       scripts/iterate.sh --test     # 先跑全闸(test-all.sh),红了就不部署
set -u
ROOT="${0:A:h:h}"
PORT=3091
LOG="$HOME/.dsh/logs/web-3091.log"
force_restart=0; do_build=1; do_test=0
for a in "$@"; do case "$a" in
	--restart) force_restart=1 ;;
	--no-build) do_build=0 ;;
	--test) do_test=1 ;;
	*) print "未知参数 $a"; exit 2 ;;
esac; done

if (( do_test )); then
	print "▸ 全闸(test-all)"
	"$ROOT/scripts/test-all.sh" || { print "❌ 闸红,不部署"; exit 1 }
fi

if (( do_build )); then
	print "▸ 前端构建(改前端不用重启:serveSpa 每请求读盘,build 完刷新即可)"
	(cd "$ROOT/frontend" && npm run build 2>&1 | /usr/bin/grep -E 'built in|error') || { print "❌ 前端构建失败"; exit 1 }
fi

print "▸ 部署插件(仓 → desktop → web)"
deploy_out="$("$ROOT/scripts/deploy-plugins.sh")" || { print -r -- "$deploy_out"; print "❌ 部署失败"; exit 1 }
print -r -- "$deploy_out" | /usr/bin/grep -v '^CHANGED='
changed="$(print -r -- "$deploy_out" | /usr/bin/grep '^CHANGED=' | cut -d= -f2)"

if [[ "$changed" != "0" ]] || (( force_restart )); then
	print "▸ 重启 3091(插件变更 $changed 项${force_restart:+,含强制})"
	pkill -f "dsh web --port $PORT" 2>/dev/null
	i=0
	until ! lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; do
		sleep 0.5; i=$((i+1)); (( i > 40 )) && { print "❌ 旧 3091 迟迟不退(两个实例会互踩会话目录,不硬抢)"; exit 1 }
	done
	(cd "$HOME" && nohup dsh web --port $PORT --no-open >> "$LOG" 2>&1 &)
	i=0
	until [[ "$(/usr/bin/curl -s --noproxy '*' -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/agos/" 2>/dev/null)" == "200" ]]; do
		sleep 0.5; i=$((i+1)); (( i > 60 )) && { print "❌ 3091 起不来,看 $LOG 末尾:"; tail -5 "$LOG"; exit 1 }
	done
else
	print "▸ 插件零变更,不重启 3091"
fi

print "▸ 健康检查"
ok=1
for path in "/agos/" "/api/agos/routes" "/api/agos/overview" "/api/fleet/hosts"; do
	code="$(/usr/bin/curl -s --noproxy '*' -m 20 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT$path")"
	if [[ "$code" == "200" ]]; then print "  ✅ $path 200"; else print "  ❌ $path $code"; ok=0; fi
done
(( ok )) || { print "❌ 健康检查未过"; exit 1 }
print "✅ 迭代完成(插件变更 $changed 项$([[ $changed != 0 || $force_restart == 1 ]] && print -n ',3091 已重启' || print -n ',3091 未动'))"
