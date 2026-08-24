#!/bin/zsh
# AgOS 后端插件部署:产品仓 plugins/<name>/ → ~/.dsh/profiles/desktop/plugins/<name>/ → ~/.dsh/profiles/web/plugins/<name>/
#
# 为什么是拷贝不是软链(2026-08-24 实测):宿主按文件 realpath 向上找 @deepseek-ai/* 与 dsh-kimicode-swarm,
# 插件真身一旦离开 ~/.dsh/profiles/<profile>/ 目录树,裸 import 全部 MODULE_NOT_FOUND(dsh-agos-router 直接起不来);
# 且 desktop(DSH Desktop.app asar)与 web(~/.npm-global)是两套宿主包,一份 node_modules 伺候不了两边。
# 所以:产品仓是源码真源,profile 里是部署副本;profile 内的 file:./plugins/<name> 指向、node_modules 软链、
# dsh-preflight、headless 的 file:../desktop/plugins/* 指向全部不变。
#
# 用法:scripts/deploy-plugins.sh            # 部署到 desktop + web
#       scripts/deploy-plugins.sh --check    # 只报漂移(repo↔desktop↔web),不写
#       部署后要让 3091 生效:pkill -f 'dsh web --port 3091'; sleep 3; nohup dsh web --port 3091 --no-open >/dev/null 2>&1 &
set -u
ROOT="${0:A:h:h}"
PLUGINS=(dsh-agos dsh-agos-router dsh-mcp-bridge cn-capabilities dsh-fleet)
DESKTOP="$HOME/.dsh/profiles/desktop/plugins"
WEB="$HOME/.dsh/profiles/web/plugins"
RSYNC=(rsync -a --delete --exclude node_modules --exclude .git)
check=0; [[ "${1:-}" == "--check" ]] && check=1
rc=0
total_changed=0
for p in $PLUGINS; do
	src="$ROOT/plugins/$p/"
	[[ -d "$src" ]] || { print "❌ 仓里没有 plugins/$p"; rc=1; continue }
	for dst in "$DESKTOP/$p/" "$WEB/$p/"; do
		if (( check )); then
			# 只比内容(--checksum),不比 mtime:git 检出的文件时间戳与部署副本天然不同。
			# itemize 格式 YXcstpoguax:第 3 位 c = 校验和不同,+ = 新文件;*deleting = 目标多出来的;cd+ = 新目录。
			# (第一版写成 ^[<>]f.c 看的是第 4 位——size 槽,内容改了也报零漂移,自己被自己的闸骗过一次。)
			drift="$("${RSYNC[@]}" --checksum --dry-run --itemize-changes "$src" "$dst" | /usr/bin/grep -E '^[<>]f(c|\+)|^\*deleting|^cd\+' | /usr/bin/grep -c . || true)"
			if [[ "$drift" == "0" ]]; then print "✅ $p ↔ ${dst/#$HOME/~} 零漂移"; else print "⚠️  $p ↔ ${dst/#$HOME/~} 漂移 $drift 项"; rc=1; fi
		else
			mkdir -p "$dst"
			# 部署也按内容(--checksum)并统计真实变更数:iterate.sh 据此决定要不要重启 3091
			out="$("${RSYNC[@]}" --checksum --itemize-changes "$src" "$dst")" || { print "❌ $p → $dst"; rc=1; continue }
			n="$(print -r -- "$out" | /usr/bin/grep -E '^[<>]f(c|\+)|^\*deleting|^cd\+' | /usr/bin/grep -c . || true)"
			total_changed=$((total_changed + n))
			print "✅ $p → ${dst/#$HOME/~}（$n 项变更）"
		fi
	done
done
(( check )) || print "CHANGED=$total_changed"
exit $rc
