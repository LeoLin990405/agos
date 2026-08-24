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

## 日常(一条命令)

```bash
scripts/iterate.sh          # 构建前端 → 部署插件 → 插件真变了才重启 3091 → 健康检查
```

- **改前端**:不用重启——serveSpa 每请求读盘,`iterate.sh`(或 `cd frontend && npm run build`)完刷新页面即可。
- **改插件**:`iterate.sh` 会检测到变更并自动重启 3091;`--restart` 强制重启,`--no-build` 跳过前端,`--test` 先跑全闸红了不部署。
- 3091 与 DSH Desktop 两个实例会互踩会话目录:脚本等旧进程真退了才起新的,起不来会把日志尾巴打出来。

零碎命令(iterate.sh 内部就是它们):

```bash
scripts/dev-links.sh                 # 一次性:仓内跑插件单测的软链
scripts/test-all.sh                  # 全闸:前端 verify + 五插件 node --test + 部署漂移
scripts/deploy-plugins.sh --check    # 只看 仓↔desktop↔web 漂移,不写
~/bin/dsh-preflight                  # 宿主侧闸(软链/语法/twin 漂移)
zsh regression/opencli-regression.sh # 全站回归(需 OpenCLI 桥接健康,41 步,零模型调用)
```

## 红线(来自 TASK-017/019,仍有效)
- 前端冻结层 `src/stores/** src/fold/** src/api-client/** src/contract/** vite.config.ts package.json`:改动需 Leo 拍板;`vendor:diff` 必须零漂移。
- UI 不 POST `/api/agos/routes/decide`;写端点只许在 `routes-assemble.ts`(仓级锁)。
- 数据零编造:屏上断言由同屏数据算出;缺字段写「未采集」。
- 真实模型调用要记账(cost-meter);W17 影子选择器预算 ≤10 次。

## 许可与来源

- 本仓 [MIT](LICENSE)。
- `frontend/src/contract/`(及 `UPSTREAM.pin` 钉住的 API 契约)vendored 自 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)(MIT,Copyright DeepSeek);`npm run vendor:diff` 保证零漂移。
- 运行需要 DSH 宿主(DSH Desktop 或 `@deepseek-ai/dsh`);插件的 `@deepseek-ai/*` 依赖由宿主 profile 提供,本仓不再分发。
- **不在公开仓里的**:W20 记忆抽取尺的三块语料(维护者真实会话原句,私有数据;相关测试在语料缺席时自动跳过,口径与基线读数保留在仓内)、以及任何部署环境地址(唤醒网关等在 profile 层配置)。

旧仓 `LeoLin990405/agos-frontend`、`agos-app` 已归档;`dsh-plugins` 仍是其余 DSH 插件(vendored 上游等)的真源,AgOS 五插件已从它移出。
