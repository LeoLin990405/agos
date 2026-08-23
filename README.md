# AgOS

AgOS 是跑在 [DeepSeek Harness(DSH)](https://github.com/deepseek-ai/deepseek-harness) 之上的 Agent OS 产品层:遥测甲板(控制台 / 路由决策 / 记忆工作台 / Homelab 机器与派发)+ 一组 DSH 插件后端。本仓是它的**唯一源码真源**(2026-08-24 由三个仓合成,历史完整保留)。

```
frontend/     Vite + React SPA(/agos/),契约 vendored 自 deepseek-harness(UPSTREAM.pin),npm run verify 含契约零漂移闸
plugins/      DSH 插件:dsh-agos(控制台/技能/会话记忆/SPA 服务)· dsh-agos-router(路由选择器/组装/试跑/影子)
              · dsh-mcp-bridge(agos_* MCP 工具)· cn-capabilities(国产模型能力:视觉/语音/议会/额度/media)· dsh-fleet(Homelab 多机派发)
regression/   OpenCLI 驱动真实 Chrome 的全站回归(opencli-regression.sh,41 步,零模型调用)+ AgOS.app 壳 build.sh
scripts/      deploy-plugins.sh(仓 → profile 部署)· dev-links.sh(仓内跑插件单测用的软链)· test-all.sh(全闸)
```

## 运行形态(为什么是拷贝不是软链)

DSH 宿主按文件 **realpath** 向上找 `@deepseek-ai/*` / `dsh-kimicode-swarm`;插件真身一旦离开 `~/.dsh/profiles/<profile>/` 目录树,裸 import 全部 `MODULE_NOT_FOUND`。而 desktop(DSH Desktop.app asar)与 web(`~/.npm-global`)是两套宿主包,一份 node_modules 伺候不了两边。所以:

- 本仓 `plugins/` 是源码真源;
- `scripts/deploy-plugins.sh` 把它 rsync 到 `~/.dsh/profiles/desktop/plugins/<name>/` 与 `~/.dsh/profiles/web/plugins/<name>/`(部署副本);profile 内的 `file:./plugins/<name>`、node_modules 软链、`dsh-preflight`、headless 指向全部不变;
- 3091(`dsh web --port 3091`)跑 web profile,部署后要重启才生效;SPA 由 dsh-agos 直接服务 `frontend/dist`(`DSH_AGOS_DIST` 可覆盖)。

## 日常

```bash
scripts/dev-links.sh                 # 一次性:仓内跑插件单测的软链
scripts/test-all.sh                  # 全闸:前端 verify + 五插件 node --test + 部署漂移
cd frontend && npm run build         # 出 dist(3091 直接服务)
scripts/deploy-plugins.sh            # 插件 → desktop + web profile
pkill -f 'dsh web --port 3091'; sleep 3; nohup dsh web --port 3091 --no-open >/dev/null 2>&1 &
~/bin/dsh-preflight                  # 宿主侧闸(软链/语法/twin 漂移)
zsh regression/opencli-regression.sh # 全站回归(需 OpenCLI 桥接健康)
```

## 红线(来自 TASK-017/019,仍有效)
- 前端冻结层 `src/stores/** src/fold/** src/api-client/** src/contract/** vite.config.ts package.json`:改动需 Leo 拍板;`vendor:diff` 必须零漂移。
- UI 不 POST `/api/agos/routes/decide`;写端点只许在 `routes-assemble.ts`(仓级锁)。
- 数据零编造:屏上断言由同屏数据算出;缺字段写「未采集」。
- 真实模型调用要记账(cost-meter);W17 影子选择器预算 ≤10 次。

旧仓 `LeoLin990405/agos-frontend`、`agos-app` 已归档;`dsh-plugins` 仍是其余 DSH 插件(vendored 上游等)的真源,AgOS 五插件已从它移出。任务书在 `~/.claude/tasks/TASK-2026-08-22-017.md` 等。
