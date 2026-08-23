#!/bin/zsh
# 在仓里跑插件单测所需的两条软链(不进 git):插件源码的裸 import(@deepseek-ai/*、dsh-kimicode-swarm…)
# 按 realpath 向上找 node_modules,仓里没有 → 指向 DSH desktop profile 的两层依赖树。
# 运行时**不用**这两条链:宿主加载的是 scripts/deploy-plugins.sh 拷进 profile 的副本。
set -e
ROOT="${0:A:h:h}"
ln -sfn "$HOME/.dsh/profiles/desktop/node_modules" "$ROOT/plugins/node_modules"
ln -sfn "$HOME/.dsh/profiles/node_modules" "$ROOT/node_modules"
print "✅ $ROOT/plugins/node_modules → ~/.dsh/profiles/desktop/node_modules"
print "✅ $ROOT/node_modules → ~/.dsh/profiles/node_modules"
