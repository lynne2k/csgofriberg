# 02 代码地图

[返回接手入口](../../AGENT_HANDOFF.md) · 路径相对仓库根目录

## 技术栈与页面

Node.js 26、TypeScript、pnpm workspace；后端 Express 4 + Socket.IO 4 + Knex；生产 PostgreSQL / 本地 SQLite，Redis 保存会话相关状态和每日成绩等。前端 Vite 6，仓库包含 React 18，但 CS Link 主要是独立 HTML 页面配 TypeScript 通信模块。

| 位置 | 用途 |
| --- | --- |
| `client/cslink/index.html` | 正式橙蓝首页、单人入口、匹配/好友房入口 |
| `client/cslink/daily.html` | 每日牌桌、自动判边、计时、排行榜 |
| `client/cslink/practice.html` | 单人练习、难度和换题 |
| `client/cslink/lobby.html` | 创建/加入/分享房间、准备、选项 |
| `client/cslink/duel.html` | 多人牌桌、状态、计分板、自动推进 |
| `client/public/cslink/data.js` | `window.CSDATA`：数据加载、搜索、形近字/对调容错、本地关系判断 |
| `client/src/cslink/net.ts` | `window.CSNET`：真实 Socket.IO 房间通信 |
| `client/src/cslink/daily.ts` / `practice.ts` | 每日/练习 API 与身份接入 |
| `client/src/cslink/nick.ts` | 昵称输入、缓存、审核接入 |
| `client/public/cslink/bgm.js` / `wipe.js` | 背景音乐、关于弹层、页面转场 |
| `client/src/api/` | 通用 HTTP、PoW、会话、Socket.IO 客户端 |
| `client/vite.config.ts` | 多页面构建入口、API/Socket 代理、资源版本 |

多页之间存在重复的牌桌脚本，改每日交互不能假设练习/对战自动同步。别用大范围字符串替换删掉 `renderHud`、`beginClock` 等函数；历史上出现过这种回归。`client/src/pages/` 的旧游戏/关系查询页面仍存在，但不是当前首页实现。

## 后端职责

以下服务位于 `server/src/services/`，路由位于 `server/src/routes/`。

| 模块 | 职责 |
| --- | --- |
| `server/src/index.ts` | 加载多层数据、构建筛选、挂载路由/Socket、CSP、启动管理 socket |
| `cslinkPaths.ts` | 图结构、最短路径、合法提交、跳数/时间比较 |
| `cslinkPlay.ts` | 可玩关系图、题目、来源与证据 |
| `cslinkEvidence.ts` / `cslinkCandidates.ts` | 已复核证据层、采集候选层 |
| `cslinkLegacy.ts` / `cslinkMerged.ts` | 旧库/手工阵容接入、统一证据查询 |
| `cslinkDifficulty.ts` | 难度范围、按传入热度值生成端点名单 |
| `cslinkDaily.ts` | 上海日期、固定当日题、开始计时、提交、Redis 排行榜 |
| `cslinkRooms.ts` | 房间/回合/整场状态机、到场等待、放弃、匹配与结算 |
| `server/src/socket/cslinkRooms.ts` | Socket 事件、输入校验、身份和限流 |
| `cslinkLadder.ts` | Elo 与本地 JSON 持久化 |
| `cslinkLiveData.ts` | 可切换的关系图视图、筛选加载、房间快照 |
| `cslinkControl.ts` | 仅本机的 Unix socket 运维通道 |
| `cslinkNickname.ts` / `cslinkNickModeration.ts` | 昵称展示、归一化、本地词库审核 |

## 接口速查

| 接口/事件 | 说明 |
| --- | --- |
| `GET /api/health` | 基础服务健康，不能代替游戏数据和浏览器验收 |
| `/api/pow/*`、`POST /api/auth/session` | 浏览器工作量证明和访客会话；优先复用客户端封装 |
| `GET /api/cslink/daily/today` | 当日题、数据版本、成绩分区 |
| `POST /api/cslink/daily/start` | 建立/读取该身份今日记录；不等于开始计时 |
| `POST /api/cslink/daily/begin` | 首次放牌时开始计时 |
| `POST /api/cslink/daily/submit` | 服务端验证完整路线并更新成绩 |
| `GET /api/cslink/daily/leaderboard` | 榜单和本人状态；本人可能已在榜单中，渲染不能重复追加 |
| `POST /api/cslink/daily/nickname-check` | 昵称审核 |
| `/api/cslink/drill/question`、`/submit`、`/reveal` | 练习题/提交/答案；路由前缀是 `drill` |
| `GET /api/cslink/ladder/top` | 天梯排名 |
| `/api/cslink/play/*`、`/merged/*`、`/candidates/*` | 可玩图和来源查询，各子路由以源文件为准 |
| Socket `cslink:create/join/ready/options/start/arrive/submit/giveup/next/rematch/leave` | 房间流程，参数与确认回包见 socket 模块 |
| Socket `cslink:queue/unqueue/sync`、服务端 `cslink:state` | 匹配、取消、同步及状态推送 |

HTTP 游戏接口一般经过 PoW 和会话校验，裸 `curl` 返回 428 不等于接口故障。当前证明使用 `csgofriberg_pow` Cookie，默认有效期 600 秒，并绑定请求上下文；不要从旧验收日志复制 Token。PoW 是浏览器完成的工作量证明，用于限制滥用请求，不是玩家账户密码。

## 身份、状态与权威来源

- 排行榜/房间身份不是昵称；访客键与登录用户键分别走 `g:`、`u:` 体系。昵称是展示字段，可重复，不能据昵称合并成绩。
- 同源普通标签页共享浏览器会话；两名测试玩家应使用独立浏览器上下文，不能只开两个标签页。
- `CSDATA.edge()` 提供即时视觉反馈；最终有效路线、截止时间和成绩以服务端为准。
- 前端 `data.js` 会把借用同一照片的旧身份折叠成代表牌并尝试其别名关系，源数据库身份未合并。修改身份规则要同时测试前后端判边，不能只凭照片认定同一个人。
- CS Link 房间对象驻留进程内存；原站 Socket.IO Redis adapter 不代表 CS Link 房间可以跨进程恢复。
- 每日题固定文件、Redis 成绩和天梯 JSON 是三个不同状态源。详见 [生产运维](05-production-operations.md)。
