# CS Link 评论反馈修复与本地验收（2026-10-27）

本批先完成本地验证，再经用户授权于北京时间 2026-10-27 13:59 部署至 `https://cslink.cc`。抓取使用后台网络请求；验收使用独立无头 Chromium，没有操作用户正在使用的 Chrome。

## 用户可见的改动

- 手机和桌面都可直接点搜索结果放牌；仍支持拖到指定位置、换位、拖出撤牌。轻点桌上的牌和被系统取消的触摸手势不会误删牌；只处理起手的那根指针。
- 原样花名匹配优先于形近字符和相邻字母对调容错；大小写仍不区分。身份不按花名合并，NiKo / niko 仍是两个人。
- 同名选手（两位 rain 等）的卡片侧边展示最近收录队伍，在搜索叠牌时可区分；队伍标签不是实时转会信息。
- 手机上的证据标签简化为可点击的 `HLTV ↗`，完整赛事名仍在提示和无障碍名称中，避免长赛事名越出屏幕。
- 天梯匹配固定为每轮 40 秒，先到 3 分赢整场；自定义房间参数不改。
- 1254 张定妆照的 WebP 总体积为 15.91 MiB，PNG 原件为 151.95 MiB；原件保留，页面改用 WebP 并懒加载。缺图选手用统一占位卡。
- 关于弹层补充放牌即判定的玩法、HLTV 证据入口及收录范围；“未收录”不再被表述成肯定“没做过队友”。
- 外号记录放在 `docs/cslink-player-aliases.md`，包括小菊 / 荆芥 / 大 b / 海参。

## 本次核对并补录的同队比赛

每行录入该队当图五人阵容，保留 HLTV 单图、系列赛和赛事来源，而不只硬编码一条关系。

| 反馈 | 阵容与日期 | HLTV 单图证据 |
| --- | --- | --- |
| flying / rage | Invictus，2022-05-23；另含 0i、DeStRoYeR、Ayeon | [Mirage，138298](https://www.hltv.org/stats/matches/mapstatsid/138298/rare-atom-vs-invictus) |
| Starry / JamYoung | TYLOO，2024-08-05；另含 Jee、Mercury、Moseyuh | [Ancient，180671](https://www.hltv.org/stats/matches/mapstatsid/180671/tyloo-vs-rare-atom) |
| Alkaren / kyousuke | Spirit Academy，2025-02-26；另含 robo、syph0、Mokuj1n | [Nuke，193632](https://www.hltv.org/stats/matches/mapstatsid/193632/spirit-academy-vs-iberian-soul) |
| b1t / m0NESY | NAVI Junior，2020-11-18；另含 kapacho、Aunkere、Topa | [Overpass，112006](https://www.hltv.org/stats/matches/mapstatsid/112006/navi-junior-vs-hard-legion) |
| Alkaren 的早期队友 | CUBE，2023-12-03；另含 dosikzz、syph0、rinn、OxygeN | [Nuke，167550](https://www.hltv.org/stats/matches/mapstatsid/167550/cube-vs-stealth) |

也保留本批此前完成的两份 BC.Game Masters Championship Season 1 补录（mapstatsid 223825、223842），未覆盖旧库。相对分支 HEAD，当前导出从 2414 条身份 / 11450 条关系变为 2422 条身份 / 11502 条关系，净增加 52 条关系。这是完整关系图的数量，不是搜索可选人数；原有 2024 起 S/A 活跃名单和老将例外继续生效。

导出脚本已移入仓库：`node scripts/build-cslink-data.mjs`。源数据根可用 `CSLINK_SOURCE_ROOT` 指定，输出目录可用 `CSLINK_DATA_OUT` 指定，补录文件可用 `CSLINK_MANUAL_RELATIONS_FILE` 指定；源库不被改写。前端数据和定妆照仍属于忽略的大文件，部署包必须单独带上，不能只推 Git。

## 更新方式和成绩保留

新增可选的本地 Unix socket 管理通道，通过 `CSLINK_CONTROL_SOCKET` 启用，文件权限 0600。没有新增公网管理接口。

```sh
node scripts/cslink-control.mjs status
node scripts/cslink-control.mjs drain
node scripts/cslink-control.mjs reload
node scripts/cslink-control.mjs resume
node scripts/cslink-control.mjs check-restart
```

- `status` 只返回房间数、进行中对局数、排队数、版本和 Redis 状态，不返回昵称或身份。
- `drain` 暂停新建整场/匹配，现有对局继续；局间休息也计为进行中。`resume` 恢复。
- `reload` 重新校验补录关系、活跃名单、热度、照片列表和昵称词库。源 SQLite 库对象沿用本进程已加载版本；替换整套源库仍走计划重启。
- 构建通过后才一起切换图、统一证据视图和出题筛选。文件损坏时返回错误，继续使用原图；词库载入失败也保留旧审核规则。
- 重建图实测约 3 秒，因此有进行中对局时拒绝重载。重载期间临时禁止新开局，完成后恢复先前状态。已有房间保留创建时的图、选手信息和筛选条件。
- 当天题目两端和成绩分区写入 `cslink-daily-question.json`（默认与天梯文件同目录，可用 `CSLINK_DAILY_QUESTION_FILE` 指定）。新增数据、重载、服务重启不再随机换掉当天题目和分区。
- 每日成绩仍保存在 Redis；不迁数据库。Redis 必须正常运行并保留其持久化目录。缺 Redis 时的内存降级仍不能承诺重启保留成绩，`check-restart` 在这种情况下拒绝放行。
- 数据版本更新后，已经打开的每日/练习页面可能提示刷新；刷新后当天题目和已存成绩保留。整场房间按自己的固定版本判定。
- `scripts/cslink-safe-restart.sh` 先暂停新开局、确认无进行中对局且 Redis 正常，再调用服务重启；条件不满足则恢复开局并退出。首次升级的旧服务没有该控制接口，因此本次先核对旧服务房间为空闲，再切换目录并重启；此脚本用于后续版本。

静态 JS / 图片替换通常不需要服务端重启，但当前 HTML 的 CSP 哈希在进程启动时生成；本批修改了内联 HTML 脚本和服务端代码，首次上线仍需安排一次有保护的重启。没有声称整个网站已经实现代码热更新或双实例无缝切换。

## 首次部署前必须保留当天题目

旧生产版本尚未持久化当天题目；不能直接把新图覆盖后让它重新选题。第一次升级应在旧进程还运行时，用正常已通过 PoW 的会话读取 `/api/cslink/daily/today`，把返回的 `date`、`start.id`、`end.id`、`bucket` 保存成：

```json
{"date":"实际日期","startId":"实际起点 ID","endId":"实际终点 ID","bucket":"原返回 bucket，原样保留"}
```

放入持久状态目录的 `cslink-daily-question.json`，保留 Redis 和天梯文件。不要重算 bucket，也不要清 Redis。第一版服务没有新控制 socket，首次升级须先以旧版房间状态确认空闲；升级后才使用上述控制命令。部署完成后比对旧题两端、bucket、已通关人数和同一身份的成绩。

## 本地验证

独立测试服务使用 13001 端口、测试数据库副本和独立 Redis 6391。未连接生产 Redis 或生产服务器。

- CS Link 服务端关系、路径、每日、房间、Socket.IO、昵称和重载相关测试：15 个文件、138 项全部通过。
- 前端 39 个文件、195 项测试全部通过，完整构建通过；原站 Home 测试改为按 `/daily` 路由定位，避免误把另一个含“每日挑战”文案的 CS Link 入口当成同一按钮，不改原站页面行为。
- 390×844 手机视口实际点击选牌、手势取消、搜索容错、双 rain 区分。
- 每日挑战实际用搜索/点击完成：计时停止、排行榜本人只一条。
- 两个独立访客进入真实 Socket.IO 天梯房，验证 40 秒 / 3 分、手机放牌、放弃、局间状态和维护保护。
- 空闲时用有效新版本重载；破坏测试副本后重载失败，运行版本不变；题目和排行榜分区不变。浏览器共完成 14 项检查，无页面脚本异常。
- 实际停止并重新启动独立测试服务器进程：当天题目、Redis 排行榜、同一浏览器身份的成绩和停表状态全部保留。
- 运行日志、截图和逐项结果存于本地 `.local-data/feedback-check-20261027/`；其中浏览器身份及测试凭据不纳入版本管理。

## 生产部署与外网验收（2026-10-27）

- 首次检查发现 2 人正在对局，因此没有立即部署。等该房间停止轮转后再次确认：进行中对局 0、排队 0；原房间两位成员均已断开。大厅还有 1 个连接，未处于对局中。空闲检查与禁止新开局在同一次服务端操作内完成。
- 北京时间 13:59:06 停止旧进程，13:59:21 新服务开始监听；13:59:23 完成服务端校验。Redis、PostgreSQL 和 Caddy 均未重启。
- 每日题保持 **Snax（hltv:2553）→ latto（hltv:19045）**，成绩分区保持 `2026-10-27:normal:hltv:2553:hltv:19045`。
- 切换前后 Redis 该分区的 **90 条记录、43 条通关成绩逐条完全相同**，没有缺失或变化；天梯文件 **94 条积分记录**也完全一致。没有重置身份密钥或清理 Redis。
- 关系库版本由 `f1d313e12df48bc5f1cf` 更新到 `d1d1fb035acd033c5403`。WebP 图片和生成的关系 JSON 已随部署包上传；Git 中保留源码、补录数据和生成脚本。
- 公网无头浏览器实测：HTTPS + PoW 正常启动、今日题与榜单保留、5 组补录关系及 HLTV 证据可查询、昵称审核、390×844 手机点牌和 WebP 图片正常。
- 用两个独立访客从公网完成一局真实自定义房间对战（40 秒、1 分取胜）：出题同步、提交、放弃、结算及 HLTV 证据通过；测试结束退出房间，未写入每日成绩或天梯积分。无页面脚本异常。
- 管理 socket 已启用，权限 0600；临时调试端口已关闭。后续可以直接检查房间与维护状态。
- 服务器回滚目录：`/srv/cslink/state/deploy-20261027/`，保留旧程序、原配置、Redis 快照、原题和积分备份。该目录不在网站公开目录内；本机验证记录位于 `.local-data/deploy-20261027/`，不纳入 Git。
