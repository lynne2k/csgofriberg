# 04 本地运行与验证

[返回接手入口](../../AGENT_HANDOFF.md)

## 在当前 Mac 接手

仓库位置：

```text
/Users/flippy/Library/Mobile Documents/com~apple~CloudDocs/Counter-Strike/csgofriberg
```

所有命令在仓库根运行，路径有空格时加引号。先检查，不要重复启动或杀掉其他进程：

```sh
git status --short
git branch --show-current
python3 scripts/local-mac.py status
```

运行工具链由项目管理：`.node-version` 为 **26.7.0**，`package.json` 指定 pnpm **11.13.1**；本地 Redis **7.4.7**。`scripts/local-mac.py` 面向 macOS，使用 Python 3.12+，自动选择 Apple Silicon/Intel Node 目录。

```sh
# 首次缺运行工具时才执行；会下载/安装依赖
python3 scripts/local-mac.py setup

# 已核对数据、服务未启动时
python3 scripts/local-mac.py start

# 只有需要停止本地服务时
python3 scripts/local-mac.py stop
```

`start` 会启动本地 Redis、执行本地 SQLite 迁移并启动后端和 Vite；不会自动下载完整比赛库/照片。先按 [数据交接清单](03-data-and-sources.md)恢复资源。它启动的后端是 `node --import tsx`，不是 watch 模式；**改后端源码不能假设它自动重启**，Vite 前端则有开发更新能力。

| 内容 | 默认位置/地址 |
| --- | --- |
| 实际首页 | <http://localhost:5173/cslink/> |
| 每日 / 练习 | `/cslink/daily.html` / `/cslink/practice.html` |
| 后端 | `http://127.0.0.1:3000` |
| 健康检查 | `http://127.0.0.1:3000/api/health` |
| 本地 Redis | `127.0.0.1:16379`，前缀 `csgofriberg-mac:` |
| 本地用户数据库 | `.local-data/development.sqlite3` |
| 日志、进程记录 | `.local-logs/`、`.local-data/mac-*.json` |
| 本地身份密钥 | `.local-data/jwt-secret.txt`，不要删除、打印或提交 |

早期的 5198/5199 是设计样板，13001/6391 是历史隔离验收环境；不是默认正式开发入口。`file://.../duel.html` 不能代替带 API/Socket 的 HTTP 网站。

## 构建和测试

```sh
python3 scripts/local-mac.py build
python3 scripts/local-mac.py test
```

`test` 使用唯一测试数据库和 Redis 前缀，避免污染日常开发成绩。仅后端可用 `backend-test`。工具链已存在时不要反复跑 setup。

手工跑某个测试前先确认 Node 版本和隔离环境。当前机器以前出现过“PATH 已改，但全局 pnpm 自带的启动器仍用旧 Node”的问题；优先通过上述 Python 包装调用仓库内 Node/pnpm，不要为了排错升级全局依赖。

主要回归入口：

- `server/test/services/cslinkDaily.test.ts`：首次放牌计时、成绩/题目持久化、分区。
- `cslinkRooms.test.ts`、`cslinkLadder.test.ts`：整场计分、匹配、放弃、断线与天梯。
- `cslinkManualRelations.test.ts`、`cslinkPaths.test.ts`：真实补录证据和路线判定。
- `cslinkDifficulty.test.ts`、`cslinkLiveData.test.ts`：人选过滤、版本切换。
- `cslinkNickModeration.test.ts`：昵称归一化和误伤。
- `server/test/socket/cslinkRooms.integration.test.ts`：真实 Socket 协议。
- `server/test/routes/cslink*.test.ts`：数据查询、证据、接口集成。
- `client/test/`：前端测试；HTML 中大量内联脚本仍需浏览器验证，编译通过不够。
- `scripts/tests/`：采集、导入、投影的 Python 测试；只改文案无需跑全部数据测试。

`scripts/cslink_duel_smoke.mjs` 可针对运行中的本地服务做访客/PoW/房间烟测，默认 `127.0.0.1:3000`，可用 `CSLINK_SMOKE_BASE` 指定隔离地址。它会真实创建测试身份和房间，不是只读探活，不要未经授权指向生产。仓库 `scripts/verify-production.*` 属于另一套验证入口，先阅读实现，不要因名字含 production 就直接在生产运行。

## 浏览器验收行为树

采用独立无头浏览器，不切换用户正在使用的 Chrome。多身份测试用独立 context；普通同源标签页共享身份。

| 场景 | 最低验证路径 |
| --- | --- |
| 首次打开 | PoW → 会话 → 数据和照片载入；无脚本异常；进入页面不偷跑每日计时 |
| 搜索 | 空输入、原样花名、大小写、形近字、`phyz` 对调、同名/双 rain、NiKo/niko；不混入无关卡 |
| 放牌 | 点选、拖入两张之间、换序、拖出撤回、触摸取消；断边可立即修改，不要求“重排”按钮 |
| 每日成功 | 自动提交 → 停表 → 本人榜单只一条 → 刷新仍停表且成绩保留；失败提交也能继续玩 |
| 练习 | 各难度、换题、合法不同路线、成功看最短路线；不写每日榜单 |
| 好友房 | 建房、链接/房号加入、关闭房间链接、准备、设置时间/目标分；不闪回旧左右半区页 |
| 多轮对战 | 等到场后开表、放弃、全员未完成、有人得分、未到目标继续、整场结束自动返回 |
| 排位 | 40 秒、3 分、取消匹配、断线重连、结果和 Elo；不要用真实玩家做测试对手 |
| 移动端 | 390×844 及更窄窗口、横竖切换、键盘弹出、中文输入法确认；顶部状态与“我的最佳”不遮挡 |
| 来源 | 左下角 HLTV 选手主页、每条队友关系比赛链接；页面缺边说“未收录” |
| 运维回归 | 在隔离环境验证重载失败保留原图、进行中拒绝维护、实际重启后题目/榜单/身份不变 |

文档/低影响可逆文案变动只需对应验证。涉及计时、身份、计分、图更新和状态保存时要覆盖服务端与浏览器，不能用截图代替真实提交。

## 常见排查顺序

1. **没题/没牌**：查看数据 JSON、照片链接是否存在，服务是否挂载 CS Link 图，再看 PoW/会话和浏览器控制台。
2. **页面连通但提交失败**：比对前后端版本、手工补录是否同时部署、照片别名折叠是否与服务器身份一致。
3. **428/重新验证**：走正常 PoW 更新流程；旧 Cookie 过期不能通过禁用安全校验解决。
4. **改了没变化**：确认访问的是 5173 实际 `/cslink/` 页面还是样板/生产；前端构建产物与后端运行源码不同。
5. **成绩消失**：先核对同一身份、题目 `bucket`、Redis 状态/前缀，别先清缓存或重建题目。
6. **Git/Hugging Face 下载失败**：按用户习惯先检查 `~/.zshrc` 中是否有代理配置，失败后再尝试启用；不要输出其中敏感值。
