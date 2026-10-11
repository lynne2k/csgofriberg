# Mac 本地开发

## CS Link 路径房间

本地入口：`http://localhost:5173/teammates/duel`。创建房间后分享房间链接或房间号，其他玩家加入并准备，房主开始。默认双人、180 秒，可选择最多 8 人及回合时长。所有人连接同一对选手，在截止前可以继续提交更短路径；先比跳数，同跳数比较最佳路径首次有效提交时间。结算展示每一跳的 HLTV 比赛来源。

房间使用查询和练习当前已载入的综合关系库，开局固定数据版本。复用原站点的游客/登录身份与 Socket.IO 连接；路径房间与原猜选手房间的状态分开。刷新或网络短暂断开后，以同一身份恢复房间、剩余时间与已有最佳成绩。主动退出对局会记为弃权，不能退出再加入来重置成绩。

当前为本地单服务进程版本：房间保存在服务内存中，重启后需要新建房间；尚未接入跨服务器房间存储和公开排名。两个浏览器窗口测试时要使用不同身份；同一个浏览器的普通标签页共用身份，可以分别打开 `localhost:5173` 与 `127.0.0.1:5173` 来取得独立游客身份。现有启动配置只供本机访问。

端到端回归脚本（真实游客身份、两个实时连接，需等待一轮 60 秒倒计时）：

```sh
node scripts/cslink_duel_smoke.mjs
```

测试通过后写入 `.local-data/cslink/duel-smoke.json`。自动检查创建/加入、同题同版本、无效提交、同跳数时间排名、重复请求、断线恢复、对手路径隐藏、到期结算、来源链接与再来一局。

2026-10-10 验收：后端 45 个测试文件 / 282 项、前端 39 个文件 / 195 项通过，前后端类型编译及前端打包通过；真实服务回归 17 项通过。IAB 与 Chrome 两个独立游客在同一房间完成 3 分钟对局，均提交 `snow → nqz → brnz4n → Qikert → KaiR0N-` 的 4 跳路径，81.03 秒者胜过 127.89 秒者。双端结果与 4 条 HLTV 地图链接一致；验证了无效路径拒绝、刷新恢复最佳成绩、赛后重开和退出。截图保存在 `.local-data/cslink/duel-room-verification.jpg`。验收房间已退出清理。

已有站点每个身份最多同时连接 3 个游戏页面。若超限，页面会明确提示并提供“重新连接”，不调整原有限额。双身份验收建议使用两个不同浏览器；不同主机名的独立游客身份也可使用。

## 既有功能记录

已于 2026-09-29 在 Apple Silicon Mac 上完成原项目启动与验证。基础版本：`fe71776fe5cabd53e457e6cf11caf225a0a09cee`。2026-10-03 新增本地队友证据查询、共同队友候选出题与单人练习，以及当时的独立路径校验与计分草案；2026-10-10 已统一为一种计分并接通本地路径房间。2026-10-04 另加入 805 张 A/S 赛事首轮采样地图的候选关系库；随后按用户决定，将其中 802 张正式正赛地图以独立投影纳入本地练习。原候选库的审核状态不变。

## 环境

- 项目独立 Node.js 26.7.0（官方压缩包，已校验 SHA-256）。
- 项目独立 pnpm 11.13.1，依照现有锁文件安装依赖。
- 项目独立 Redis 7.4.7，监听 `127.0.0.1:16379`，启用本地持久化。
- 开发数据库使用 SQLite，保存在 `.local-data/development.sqlite3`。
- Python 3.12+ 用于启动脚本；编译 Redis/SQLite 需要 Xcode Command Line Tools。
- 系统默认 Node 和全局包配置未修改。正式部署仍需使用 PostgreSQL 并满足仓库的生产配置要求。

## 日常使用

在项目目录运行：

```bash
python3 scripts/local-mac.py start
python3 scripts/local-mac.py status
python3 scripts/local-mac.py stop
```

`start` 在后台启动 Redis、后端和 Vite，等待接口与网页就绪；重复调用会复用已启动的服务。`stop` 只停止该脚本记录且核对过可执行文件的进程，不会清空数据。

本机访问地址：

- 主页面：[http://localhost:5173](http://localhost:5173)
- 综合队友关系查询：[http://localhost:5173/teammates](http://localhost:5173/teammates)
- 已复核旧样本：[http://localhost:5173/teammates/reviewed](http://localhost:5173/teammates/reviewed)
- 新地图候选库：[http://localhost:5173/teammates/library](http://localhost:5173/teammates/library)
- 109 届赛事共同队友练习：[http://localhost:5173/teammates/practice](http://localhost:5173/teammates/practice)
- 旧 27 张地图样本练习：[http://localhost:5173/teammates/practice/legacy](http://localhost:5173/teammates/practice/legacy)
- 第二名访客：[http://127.0.0.1:5173](http://127.0.0.1:5173)
- 后端健康状态：[http://127.0.0.1:3000/api/health](http://127.0.0.1:3000/api/health)

两个网页地址的浏览器 Cookie 分开，可以在同一台 Mac 模拟两个玩家。进入“多人联机”，一方创建房间，另一方输入房间码加入并准备，房主开始对局。当前随机匹配需要邮箱验证账号；本地直接使用游客邀请房间即可。

## 安装、测试与构建

```bash
python3 scripts/local-mac.py setup
python3 scripts/local-mac.py test
python3 scripts/local-mac.py build
```

首次安装或缺少本地工具时使用 `setup`。测试使用单独的 SQLite 文件和 Redis key 前缀，不复用开发数据库。`.local-tools/`、`.local-data/`、`.local-logs/` 都已被仓库忽略；会话密钥在本地单独生成，不写入源码。

日志保存在 `.local-logs/`，本轮的安装、构建与测试记录分别为 `install.log`、`build.log`、`tests.log`；运行日志为 `redis.log`、`server.log` 和 `client.log`。

## 本地队友证据查询

主页的“队友关系”和“查选手”页右上角均可进入综合查询。旧版已复核查询保留在 `/teammates/reviewed`：输入昵称、姓名或 HLTV 编号后，必须点击具体候选身份；搜索 `niko` 会同时列出 `NiKo / Nikola Kovač / 3741` 与 `niko / Nikolaj Kristensen / 10264`。查询及结果高亮均使用稳定编号，不按昵称重新猜身份。

在旧版已复核查询点击“试试 NiKo + jks”可查看 IEM Dallas 2023 的两条地图证据（157818、157822），包括赛事、比分、同队名单、HLTV 单图统计链接及可展开的来源复核、原始 CSV 位置和记录指纹。没有结果只表示当前复核库未找到证据。

`data/cslink/local-review.json` 固定使用版本 `69d3bb14fb82e70ea452`。启动脚本将其目录传给后端；后端校验 SQLite 与报告文件的 SHA-256 后，以只读方式打开。当前覆盖 208 个身份、27 张已核实地图。原游戏的五名种子选手与本查询库分开保存。

缺少数据时先按 [DATA_CLEANING.md](DATA_CLEANING.md) 下载、构建和校验。切换数据版本时修改上述配置，然后执行 `stop`、`start`；已运行的服务不会自动重载版本。缺文件或校验失败会使查询接口返回 503，原游戏仍可启动，详见 `.local-logs/server.log`。页面只在 Vite 开发模式提供，后端只在 `NODE_ENV=development` 启用；尚未作为线上题库发布。

## 2026-10-04 新地图候选关系库

从“队友关系”页进入“新地图候选库”，或直接打开 [本地候选库](http://localhost:5173/teammates/library)。本地只读 SQLite 库包含 805 张首轮采样地图、838 个 HLTV 数字身份、3198 对候选队友和 16100 条同图同队证据。按昵称搜索后必须选择具体编号；`NiKo`（3741）和 `niko`（10264）始终是两个身份。每条关系展示同队五人、对手五人、比分、HLTV 单图链接、赛事范围来源、原始抓取指纹与待复核状态。未找到仅表示首轮样本中没有证据。

构建方法、来源摘要及库表结构见 [CANDIDATE_LIBRARY.md](data/cslink/CANDIDATE_LIBRARY.md)；独立审计及复核优先级见 [CANDIDATE_AUDIT.md](data/cslink/CANDIDATE_AUDIT.md)。启动脚本发现 `.local-data/cslink/candidate-library-v1/manifest.json` 后把目录传给后端；后端校验库与报告摘要后只读加载。新库生成或变更后需执行 `python3 scripts/local-mac.py stop` 再 `python3 scripts/local-mac.py start`。候选接口是开发模式下的 `/api/cslink/candidates/{meta,players,relationship}`，与原已复核接口、练习和多人判题分开。

综合查询 `/teammates` 调用开发模式下的 `/api/cslink/merged/{meta,players,relationship}`。它按 HLTV 数字 ID 合并选手搜索和关系结果；同一地图重复时先检查五人名单、地图名和比分，一致才优先展示已复核记录并保留第二来源，不一致则报冲突。每张地图保留自己的来源批次、指纹和审核状态。原始两库合并有 997 个身份、832 张地图、3542 对关系；按本地玩法投影排除三张异常图后，查询页实际显示 987 个可检索身份、829 张地图、3500 对关系。旧 27 张地图的出场记录已复核，但赛事范围未按当前 A/S 标准全部验收；新 802 张地图已批量纳入本地玩法，仍待逐图人工复核。接口 `playScopeApplied` 说明是否应用投影。它们均不是可公开发布的正式题库关系；多人房间仍未接入。数据契约和审核边界见 [MERGED_LIBRARY.md](data/cslink/MERGED_LIBRARY.md)。

该库的 805 张是每个入选系列赛的一张首轮地图，不是全部比赛地图。109 届入样赛事的范围、3 组相似或同名昵称和已观察到的换阵仍在人工复核队列中；所有候选均为 `unreviewed`、`eligible_for_questions=false`。地图 `160519` 已在独立目录重新抓取补齐来源字段，旧抓取保留；新旧页面显示时间相差六小时，不能当成已核实的标准时区时间。

## 2026-10-03 查询功能验证

- 后端：37 个测试文件、222 项测试通过（新增证据接口 7 项）。
- 前端：34 个测试文件、172 项测试通过（新增身份与证据相关 7 项）。
- 前端生产构建和后端 TypeScript 编译通过；原有大体积 chunk 提示仍在。
- 真实浏览器覆盖身份候选区分、NiKo + jks 的两条来源证据、原始记录展开、niko + jks 的限定空结果，以及手机宽度布局。
- [本轮验收记录](.local-data/cslink/website-validation-2026-10-03.json) 记录实际来源页核对、浏览器结果和只读数据库校验。
- 测试和构建日志：`.local-logs/cslink-all-tests.log`（后端通过，首次前端菜单顺序回归失败）、`.local-logs/cslink-client-full-tests.log`（修正后的前端全量通过）、`.local-logs/cslink-ui-build.log`。

## 109 届赛事本地练习

用户于 2026-10-04 决定将当前 109 届赛事样本直接合并用于个人本地游戏。投影白名单纳入 802/805 张已采集地图，排除两张表演赛及一张误挂的独立资格赛；每届仍有正赛地图。它和旧 27 张已复核地图按 HLTV 数字编号组成单独的本地可玩关系图，保留地图 URL、五人名单、来源指纹和各自的逐图审核状态。新地图的“批量纳入”不等于“逐图人工复核”。[投影说明](data/cslink/LOCAL_PLAY_PROJECTION.md)记录排除清单、输入哈希和重建方法。

打开 `/teammates/practice` 可做共同队友题，提交确切编号后查看两侧 HLTV 地图证据；固定链接包含题库版本。后端 `/api/cslink/play/meta` 报告实际题目数和数据版本，`/api/cslink/play/path` 可查询当前采样图内的最短路径及逐跳证据。它们只在 Mac 开发服务可用；线上多人房间尚未接入这张图，也不计公开排名。更换投影或候选库后请重启本地服务。

2026-10-04 实际加载得到 109 届、802 张新地图，连同旧样本生成 3500 对关系、14199 道共同队友题；其中跨阵容 12004 道、多答案 4825 道。本机后端 262 项、前端 185 项测试和构建通过。重启后网页实际展示 `802` 张新地图与两侧 HLTV 来源，搜索 `niko` 同时列出 `niko`（10264）和 `NiKo`（3741）。在本地图内，MAJ3R（150）到 HooXi（10096）求得 4 跳，MAJ3R 到 Zilkenberg（8622）求得 6 跳；每跳均有地图 URL 和各自审核状态。

## 旧样本练习与复核导出

旧样本练习保留在 `/teammates/practice/legacy`。默认使用跨阵容候选，也可以切换到多答案检查或全部候选。选定具体身份后验证答案；每个成立的答案都展示两侧队伍、赛事、地图、五人名单和来源链接。可继续找其他答案，或展开本版本的全部答案。“固定这道题的链接”包含题目编号和题库版本，刷新或在同一站点打开会得到相同题面；题库版本失效时会明确提示重新出题。换题或切换模式会清掉地址栏中旧题目的固定参数。练习不计排名、不保存答案进度。

后端使用稳定编号构建无向关系，枚举完整共同邻居集合，只保留答案数量为 1–3 的整道题；超过 3 个答案时排除整题，不截断答案集。不提前将答案放进题面响应，服务端按题目编号及题库版本核对提交；换题时废弃旧请求。搜索仍面向全部登记身份，不根据正确答案过滤候选。

目前从 27 张已核实地图生成 412 道候选：56 道端点尚无直接同队证据的跨阵容候选、356 道三个答案的题。前者不代表端点历史上从未同队。当前开发样本含 A/S 范围外赛事，候选数量不等于题目质量或完整历史覆盖，仍需人工验收。

导出可重复核对的题库与 100 道样本：

```bash
python3 scripts/local-mac.py questions
```

输出 `.local-data/cslink/question-banks/<题库版本>/review.json` 和 `manifest.json`。当前题库版本 `9adb5cb92e81a3975eab`，绑定数据版本 `69d3bb14fb82e70ea452`。100 道样本由全部 56 道跨阵容候选和 44 道多答案题组成，每道保留全部已知答案及两侧完整证明。相同输入重复导出必须字节一致；已有产物被改动会拒绝覆盖。

自动一致性检查通过不会修改 `reviewStatus=pending` 或 `releaseReady=false`。正式题库的人工复核、覆盖与授权，以及多人同步仍未完成。可读复核清单见仓库上一级的 `CS_LINK_QUESTION_REVIEW_2026-10-03.md`。

路径对战规则见仓库上一级的 `CS_LINK_PATH_DUEL_RULES.md`。2026-10-10 统一为一种计分：限时内连通，先比跳数，同跳数比较最佳路径完成时间；允许截止前继续提交更短路径。`server/src/services/cslinkPaths.ts` 负责逐跳校验，`server/src/services/cslinkRooms.ts` 已在综合关系图上实现 2–8 人房间与结算。旧的 27 张复核样本不代表当前游戏的关系覆盖；现有综合库见 `data/cslink/LEGACY_DIRECT_IMPORT.md`。

本轮后端 38 个文件 / 229 项、前端 35 个文件 / 177 项测试及生产构建通过。新增检查覆盖多个合法答案、端点排除、缺失关系、大小写不同身份、过期题库、泄露答案防护与换题期间的过期请求。日志为 `.local-logs/cslink-practice-tests.log`、`.local-logs/cslink-practice-build.log`、`.local-logs/cslink-questions-export.log` 和 `.local-logs/cslink-questions-repeat-export.log`。

## 2026-09-29 原游戏基线验证

- 后端：36 个测试文件、215 项测试通过。
- 前端：32 个测试文件、165 项测试通过。
- 前端打包与后端 TypeScript 编译通过。构建仍有原项目的大体积 chunk 提示，测试有 React Router 升级提示，均未造成失败。
- 浏览器验证：主页、选手搜索、单人提交、答案揭晓与结算。
- 两个独立游客完成 BO1 房间 `ACWJZ`：创建、加入、准备、同步开始、提交正确答案 NiKo、两端分别显示 1:0 和 0:1 的结算。败方刷新后仍恢复该已结束对局。
- 自动化测试包含 Socket.IO 集成和 Redis 7.4 实际命令验证；本轮浏览器没有单独模拟长时间断网后恢复。

当前开发库只有仓库自带的 5 名示例选手，适合验证交互和联机，不代表完整、准确的职业选手数据。没有部署公网服务，也没有创建 GitHub fork。
