# Linux 隔离运行时能力探测（主控独立执行，2026-09-09）

结论：**本机不存在任何可用于 Linux 内核隔离验证的运行时。Linux 层 `blocked`，且在本轮执行约束下不可解除。**

## 本机

```
uname -srm   Darwin 25.5.0 arm64
```

macOS 上不存在 `bwrap`（bubblewrap）与 `unshare`——这两者是 Linux 内核特性的用户态入口，
不是可移植工具，**不可能**在 Darwin 上出现。因此 bubblewrap 隔离**必须**在 Linux 内核上验证。

## 逐项探测（全部为否）

PATH 内可执行文件：

| 候选 | 结果 |
|---|---|
| `docker` / `podman` | 不存在；docker 守护进程不可用 |
| `lima` / `limactl` / `colima` | 不存在 |
| `orbctl` / `orb` | 不存在 |
| `vagrant` / `multipass` | 不存在 |
| `qemu-system-x86_64` | 不存在 |
| `bwrap` / `unshare` | 不存在（macOS 本就没有） |

应用包形式（不在 PATH 也计）：`Docker.app`、`OrbStack.app`、`UTM.app`、`VirtualBox.app`、
`VMware Fusion.app`、`Parallels Desktop.app`、`Podman Desktop.app`、`Rancher Desktop.app`、
`Lima.app`、`crc.app` —— **全部不存在**。

非 PATH 常见安装位置：`~/.docker/bin`、`~/.orbstack/bin`、`~/.rd/bin`、`~/.lima`、
`/opt/homebrew/bin/lima`、`/usr/local/bin/docker`、`/opt/podman` —— **全部不存在**。

macOS 自带：`container` CLI 不存在。只有 `/usr/libexec/AppleVirtualPlatformHIDBridge`
（HID 桥接 helper，不是可用的虚拟机运行时，需配合 Virtualization.framework 宿主应用）。

`brew` 已安装，但 `brew list --formula` 里**没有**任何容器/虚拟化 formula。

## 为什么不安装一个

本轮执行约束明确禁止：

- "不安装系统服务"（容器/VM 运行时均需守护进程或内核扩展）；
- "新安装只在本轮新建临时目录或隔离环境进行"——运行时装不进临时目录；
- "不要为消除 blocked 修改生产服务器、主机内核策略或现有容器权限"。

## 远端 Linux 是否可行

理论上存在一条路径：连到一台已有的 Linux 主机跑验证。本轮**没有走**这条路，原因：

1. 已知的 Linux 主机是用户的生产设施（NAS / k3s 节点）。在其上运行内核隔离验证，
   即便只读也属于"动生产服务器"，需要用户显式授权；
2. 更关键：那些主机**是否已装 bubblewrap 未知**；若未装，安装动作本身就违反约束。
   所以即便连上去，大概率仍然 blocked，只是把 blocked 的位置往后挪一步。

因此本轮把它列为**恢复条件**而不是执行项，交由用户决定。

## 恢复条件（任一满足即可解除 blocked）

1. 一台可用的 Linux 环境（VM / 容器 / 物理机），内核 ≥ 4.18（user namespace + 必要挂载语义），
   **已安装 bubblewrap**，且允许非特权 user namespace
   （`/proc/sys/kernel/unprivileged_userns_clone` = 1，或发行版默认允许）；
2. 或用户显式授权在某台已有 Linux 主机上执行，并确认其已具备 bubblewrap；
3. 或用户授权在本机安装一个容器/VM 运行时（本轮约束下不可自行进行）。

满足后的执行命令由 B 交付在 `scripts/acceptance/integration/linux/` 入口，
本文件不重复。
