# 真实 swarm 模块来源审计（主控独立执行，2026-09-09）

结论：**该模块可加载、可运行，且与真实宿主上正在运行的字节完全相同；但来源不可审计，第三方无法复现。**

## 被审计的产物

```
路径     /Users/leo/Projects/agos-round2-20260908/plugins/node_modules/dsh-kimicode-swarm
name     dsh-kimicode-swarm
version  0.1.0
main     lib/index.js（180,923 字节）
sha256   0a912120a30728164b5d8155544468dc…（lib/index.js）
mtime    2026-09-08 19:58:13
dependencies  {}
repository    git+https://github.com/hongyue0721/dsh-kimicode-swarm.git
```

实测 `await import()` 成功（42ms）。可用导出：`runNormalizedBatch`（3 形参，定义在 lib/index.js:2550）、
`publishProgress`、`parseResultsXml`、`parseAssessmentXml`、`escapeXml`、`unescapeXml`、`textOf`、
`SwarmScheduler`、`PROGRESS`、`STOPPED` 等。裸导入仅 `@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-llm`，
从其所在 round2 `plugins/node_modules` 树解析成功。

## 证据一：registry 上不存在这个东西

`npm pack` 拉取三个已发布版本，逐一解包比对（临时目录，只读下载）：

| 版本 | `lib/index.js` 字节 | sha256(前12) | 含 `runNormalizedBatch` |
|---|---:|---|---|
| registry 0.1.0 | 63,448 | `585c9ea3bd68` | **无** |
| registry 0.1.1 | 66,183 | `a5acd7f2488c` | **无** |
| registry 0.1.2 | 69,980 | `dda0d0a47610` | **无** |
| **本地产物 0.1.0** | **180,923** | `0a912120a307` | **有** |

本地产物自称 `0.1.0`，与 registry `0.1.0` **同版本号、完全不同内容**（181KB vs 63KB）。
版本号在这里**不是**可用的来源标识——照着 `0.1.0` 去 npm 装，会拿到一个不含所需符号的不同包。

## 证据二：上游公开仓库的全部历史里都没有这个符号

`github.com/hongyue0721/dsh-kimicode-swarm` **公开可达**（HTTP 200，默认分支 `main`，
最后推送 2026-08-28）。只读浅克隆 60 个提交后实测：

- 仓库是 TypeScript 源码（`src/` + `tsdown.config.ts`），`lib/` 是**未提交的构建产物**
  （`git log -- lib/index.js` = 0 个提交），所以无法用产物哈希钉到某个 commit；
- 上游 `src/` 共 **12 个文件 / 1,566 行**；
- `rg -l runNormalizedBatch .` → **0 个文件**；
- `git log --all -S'runNormalizedBatch'` → **0 个提交**；
- 对照组：搜 `swarm` 命中 12/12 个文件 → 搜索本身有效，不是工具用错。

上游 HEAD `311d6f4` 的版本已是 `0.1.2`；`0.1.0` 对应 `9ee3c300c`（08-15）～`47c431ea2`（08-28）区间。
但**任何区间都不含该符号**，所以本地产物**不是这个仓库任何状态的构建结果**。
它的单个输出文件（181KB）比上游整份源码（1,566 行）还大一个量级。

## 证据三：产物自身没有任何构建溯源标记

- `package.json` 无 `_resolved` / `_integrity` / `_from` → 不是 npm 从 registry 装的；
- 无 `gitHead`；
- `lib/index.js` 内无 commit / buildStamp / `__BUILD` 痕迹。

## 判定与影响

| 项 | 判定 |
|---|---|
| 是真实模块吗 | **是**。3,800 行可运行代码，不是 synthetic 桩，`runNormalizedBatch` 真实可调用 |
| 来源可审计吗 | **否**。无法对应到 registry 任何版本，也无法对应到其声明上游仓库的任何提交 |
| 第三方能复现吗 | **不能**。没有任何已发布源可以产出这份字节 |
| 版本号可信吗 | **不可信**。`0.1.0` 与一份内容完全不同的已发布包撞号 |

因此本轮 swarm 层的正确表述是：**"用一份来源不可审计的真实模块实跑了 `runNormalizedBatch`"**。
这比第三轮的 skip 严格更强（真的跑了真实调度器代码），但**不等于**"真实 swarm 集成已验证通过"，
因为复审者拿不到同一份字节、无法独立复跑。任何"真实 swarm 通过"的表述都必须带上这一节。

## 证据四：这份字节**就是真实宿主上实际运行的那份**

只读比对（仅计算 sha256，**没有**复制、没有修改任何 live profile 文件；实跑用的是
round2 worktree 里的副本，不是 live profile）：

| 位置 | version | sha256(前16) |
|---|---|---|
| 本轮实跑所用（round2 worktree） | 0.1.0 | `0a912120a3072816` |
| `~/.dsh/profiles/desktop/plugins/kimicode-swarm-aligned` | 0.1.0 | `0a912120a3072816` |
| `~/.dsh/profiles/web/plugins/kimicode-swarm-aligned` | 0.1.0 | `0a912120a3072816` |
| `~/.dsh/profiles/desktop/node_modules/dsh-kimicode-swarm` | 0.1.0 | `0a912120a3072816` |
| `~/.dsh/profiles/headless/node_modules/dsh-kimicode-swarm` | 0.1.0 | `0a912120a3072816` |
| `~/.dsh/profiles/web/node_modules/dsh-kimicode-swarm` | 0.1.0 | `0a912120a3072816` |

**5 个宿主位置全部命中同一哈希**，与本轮实跑所用的字节完全一致。

这把结论的性质改善了一档：不是"用了一份来源不明的模块"，而是
**"用了真实宿主上正在运行的那一份字节"**。三个维度要分开说：

| 维度 | 判定 |
|---|---|
| 对生产行为的代表性 | **高** —— 与本机 DSH 实际加载的字节逐字节相同 |
| 来源可审计性 | **无** —— 没有任何已发布源能产出这份字节 |
| 第三方可复现性 | **无** —— 复审者若没有这台宿主，拿不到同一份字节 |

## 与第三轮记录的关系（互相印证）

`scripts/acceptance/host-integrations.json` 里第三轮写的 `why` 已记载：

> 真实宿主上能用的是各 profile 下 `plugins/kimicode-swarm-aligned` 的对齐构建产物，
> 该目录只有 `lib/`、无 `src/`、无 `.git`，**补丁不可得**，故不 vendor 进仓。

本次审计独立印证并加强了这一条：

- 第三轮说"补丁不可得"，本次进一步确认**连上游源码里都不存在这个符号**——
  不是"补丁拿不到"，而是**任何已发布源都产不出这份字节**；
- 第三轮记载 registry 版本 `import { installSettingsSection } from '@deepseek-ai/dsh-settings'`
  会把 settings 拖回 `0.1.0-rc.6`，与其余包 `^0.1.2-rc.1` 冲突。本次实测本地产物
  `dependencies: {}`，裸导入只有 `dsh-tools`/`dsh-llm`——**没有** dsh-settings。
  这正是"对齐构建"的含义：被改造成不再依赖旧 settings API。
  也因此，用 `AGOS_SWARM_MODULE` 指向它做验证**不会**把依赖冲突重新引入。

所以本轮用的这份产物与第三轮描述的"对齐构建"属同一类，来源同样不可审计。

## 复现本审计的命令

```bash
# 证据一
T=$(mktemp -d); cd "$T"
for v in 0.1.0 0.1.1 0.1.2; do
  mkdir -p "p$v" && cd "p$v"
  npm pack "dsh-kimicode-swarm@$v" --pack-destination . --silent && tar xzf *.tgz
  echo "$v $(wc -c < package/lib/index.js) $(rg -c runNormalizedBatch package/lib/index.js || echo 0)"
  cd "$T"
done

# 证据二
git clone --depth 60 https://github.com/hongyue0721/dsh-kimicode-swarm.git repo && cd repo
rg -l runNormalizedBatch .            # 期望：无输出
git log --all -S'runNormalizedBatch'  # 期望：无输出
rg -l -i swarm src/ | wc -l           # 对照：期望 12

# 证据三
python3 -c "import json;d=json.load(open('<产物>/package.json'));print([k for k in d if k.startswith('_')], d.get('gitHead'))"
```
