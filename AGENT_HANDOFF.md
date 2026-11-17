# CS Link：Agent 接手入口

核对日期：**2026-11-09**。这份交接针对已经上线的 **CS Link 选手队友连线游戏**，不是上游“弗一把”猜选手游戏。以下路径均相对本仓库根目录。

文档可以单独打包转交；接手者仍需对应分支的代码和单独移交的数据文件。文档包不是可直接运行的完整项目备份。

## 先看这几件事

- 当前工作分支：`cslink-game-table`；代码基线：`26a437ac718c2b9afd0fc7ccf3c29106b334bbaa`。
- 推送目标是 `fork`：<https://github.com/lynne2k/csgofriberg>。`origin` 是原作者仓库，不要推错。
- 正式入口：<https://cslink.cc/cslink/>；本地入口：<http://localhost:5173/cslink/>。
- 当前产品界面主要在 **`client/cslink/*.html`**，不是 React 的旧首页。共享通信模块在 `client/src/cslink/`。
- **Git 不包含完整关系库、生成的游戏 JSON、定妆照和运行状态。** 换机器接手必须读数据交接说明；缺数据时不要重新从头抓取或宣布数据库为空。
- 本次任务只准备交接文档，没有修改业务代码、重启或部署。后续线上写操作按用户当次授权执行；先本地验证，部署时保住当天题目和排行榜。

## 阅读顺序

| 文档 | 解决什么问题 |
| --- | --- |
| [01 产品与已定决策](docs/agent-handoff/01-product-and-decisions.md) | 玩法、难度、计分、交互、用户偏好，哪些方向不要重新推翻 |
| [02 代码地图](docs/agent-handoff/02-code-map.md) | 前端、后端、接口、身份与状态分别在哪里 |
| [03 数据与素材](docs/agent-handoff/03-data-and-sources.md) | 旧库来源、补录、导出、照片、换机器缺什么 |
| [04 本地运行与验证](docs/agent-handoff/04-local-development-and-tests.md) | 启动、构建、测试、浏览器验收、常见故障 |
| [05 生产运维](docs/agent-handoff/05-production-operations.md) | SSH、维护状态、重载边界、保护成绩、部署与回滚 |
| [06 当前状态与后续工作](docs/agent-handoff/06-status-and-next-steps.md) | 这次确认了什么、哪些只是历史验证、下一步候选事项 |
| [机器可读快照](docs/agent-handoff/snapshot-2026-11-09.json) | Git、导出文件哈希、数据数量、线上只读状态 |

如需最短路径：先读本文、01、06；改页面读 02/04；补数据读 03；涉及线上必须读 05。

## 从 GitHub 取得当前代码

使用 CS Link 工作分支，不要默认克隆后停留在上游旧版的 `main`：

```sh
git clone --branch cslink-game-table --single-branch https://github.com/lynne2k/csgofriberg.git
cd csgofriberg
```

已经有 checkout 时先检查未提交内容，再切换/同步相应分支，不要直接覆盖工作区。2026-11-17 此次整理上传的是代码与交接说明；文中的运行状态快照仍是 **2026-11-09** 的观察结果，不代表上传时重新验收了生产。完整数据与照片仍按第 03 份文档单独交接。

## 第一轮接手动作

1. 查看 `git status --short`、当前分支与用户最新要求。交接时已有 `client/tsconfig.tsbuildinfo` 修改、未跟踪的 `promo/` 和 `scripts/.bot_tmp.mjs`，这些不是本次交接新增，不要顺手清理或全部提交。
2. 按本地运行说明只读检查服务、数据、照片和端口，再决定是否启动。不要抢占用户 Chrome 焦点。
3. 说明准备处理的具体问题，做最小必要改动，跑与改动相关的验证。
4. 报告实际结果与未验证部分。提交、推送、部署是不同动作，不要把“推 Git”说成“已经上线”。

## 给下一位 Agent 的开场提示

```text
请接手这个仓库中的 CS Link。先阅读 AGENT_HANDOFF.md，再按其中的阅读顺序了解产品、代码、数据和生产运维。
使用中文交流，先检查当前分支、工作区和用户最新要求，保留已有未提交内容。
当前正式产品是 /cslink/ 下的多页牌桌界面，不是原始猜选手首页。
数据和照片不全在 Git 中，先核对数据交接清单，不要重新抓整库。
以仓库当前代码和实际运行状态为准，把历史验收与本次验证分开。
先本地验证；未经本轮授权不要修改生产。部署必须确认没有进行中整场对局，并保留当天题目、成绩分区、Redis、天梯文件和身份密钥。
不要操作用户正在使用的 Chrome 来抢焦点。完成核对后汇报当前状态，再继续用户指定的任务。
```

## 旧文档的适用范围

原 [README](README.md)、[LOCAL_DEVELOPMENT](LOCAL_DEVELOPMENT.md) 和 `deploy/` 中的说明保留了上游玩法、旧 `/teammates/` 页面或 Docker 部署方案，不能直接当作当前 CS Link 的完整运维说明。[2026-10-27 验收报告](docs/cslink-feedback-2026-10-27.md)是历史证据；其中“首次升级”步骤已经执行过，不要再用旧日期初始化今日题。

本文档不包含 SSH 私钥、环境变量中的密钥、数据库口令、浏览器 Cookie 或玩家身份快照。换设备时这些访问权限应由项目所有者单独提供。
