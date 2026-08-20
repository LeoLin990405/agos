#!/bin/sh
# 升级仪式(dsh 升级后必跑):diff 上游契约目录对 vendored 副本。
# 用法:npm run vendor:diff  —— 有输出 = 契约漂移,逐处对齐后跑 npm run smoke。
set -e
UPSTREAM="${DEEPSEEK_HARNESS:-$HOME/Projects/deepseek-harness}/packages/host/apiproxy/src/api"
echo "== upstream: $UPSTREAM ($(git -C "${DEEPSEEK_HARNESS:-$HOME/Projects/deepseek-harness}" log --oneline -1 2>/dev/null || echo 'no git'))"
echo "== pin:      $(cat UPSTREAM.pin)"
diff -r "$UPSTREAM" src/contract/api && echo "== 契约零漂移 =="
