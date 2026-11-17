# 03 数据、来源与素材交接

[返回接手入口](../../AGENT_HANDOFF.md) · 统计日期：2026-11-09

## 别混淆三种仓库

- **应用上游**：`shnlfriberg/csgofriberg`，我们在 `lynne2k/csgofriberg` 的 `cslink-game-table` 分支开发。
- **旧比赛数据源**：`tedtay/CS-GO-Pro-Matches-Comprehensive-Dataset`。固定版本、下载地址与 SHA-256 在 `data/cslink/source.lock.json`；源文件主要是 CSV。它不等于应用仓库自带一套已完备的 CS Link 图。
- **后续采集与补录**：HLTV 比赛/地图的实际阵容，经本地候选库、批准地图名单与人工补录进入游戏。照片是另一路资源。

`source.lock.json` 记录旧源 revision 为 `ce8a5f242a768c5698f8068828eeedc4fc134db1`，`rights_status` 仍为 `unconfirmed`。用户曾说明得到 HLTV 管理员邮件允许个人游戏采集；仓库不因此拥有官方 API 或无限制素材授权。保留来源记录，不把口头背景写成已核验的授权文件。

## 当前本地数量与口径

| 对象 | 当前数量 | 含义 |
| --- | ---: | --- |
| 前端 `players.json` | 2,422 | 全量身份记录，不是可搜索人数 |
| 前端 `edges.json` | 11,502 | 去重后的无向队友关系，每对前端保留一条证据 |
| `active-ids.json` | 736 | 2024 起仍有 S/A 收录出场的身份 |
| `popularity.json` 老将例外 | 37 | 与活跃名单合计 773 个 ID，仍不等于最终端点/搜索卡数 |
| 热度分记录 | 2,414 | 当前文件未覆盖全部 2,422 条身份；缺分按 0，后续补录要考虑是否重建 |
| 原始 PNG / 已转换 WebP | 各 1,254 | 约 151.95 MiB / 15.91 MiB，原件保留 |
| `manual-relations.json` | 52 人、12 图 | 人工补录的身份元数据与阵容，不能与全量简单相加 |
| 旧关系 `legacy-relations-v1/graph.json` | 2,009 身份、11,260 图 | 已接入的旧阵容层，早已超出最初 598 张复核样本 |
| 主 A/S 可玩投影 | 109 届赛事、802 图 | 只取批准地图；不是 109 届每张图全部抓完 |
| 历史补采可玩投影 | 161 届赛事、598 图 | 与旧关系图可能重叠，不应相加声称总比赛数 |

来源图数、去重关系数、身份数、可搜索卡数和出题端点数是不同指标。照片折叠、活跃/老将筛选、端点照片要求都会改变最终集合。

## 同机器/换机器所需文件

下表中的本地数据以 `.local-data/cslink/` 为根；**这些目录及前端导出被 Git 忽略**。换机器应由所有者移交现有数据包并校验文件，不要只运行 `pnpm install` 后重新全网抓取。

| 本地相对路径 | 生产对应位置（`/srv/cslink/data/` 下） | 用途 |
| --- | --- | --- |
| `versions/69d3bb14fb82e70ea452/` | `69d3bb14fb82e70ea452/` | 早期复核证据、`staging.sqlite3`；版本由 `data/cslink/local-review.json` 指定 |
| `candidate-library-v1/` | `candidate/` | 主采集候选库、SQLite、manifest |
| `as-tier-local-play-v1/` | `play/` | 批准可玩的地图清单与文件校验信息 |
| `legacy-relations-v1/` | `legacy/` | `graph.json`、旧关系导入报告 |
| `historical-as-batch-v1/current/library/` | `historical-library/` | 历史补采候选库 |
| `historical-as-batch-v1/current/play/` | `historical-play/` | 历史补采批准投影 |
| `player-portraits-v1/images/` | `portraits/` | 以 HLTV ID 命名的照片文件 |

另需：

- `client/public/cslink/data/{players,edges,active-ids,popularity}.json`：前端游戏导出；服务器端点筛选也读取其中部分文件。
- `client/public/cslink/portraits`：本机是指向 `../../../.local-data/cslink/player-portraits-v1/images` 的符号链接。换机需重建有效链接；上传网页时别留下指向 Mac 的失效链接。
- 历史审计/原始抓取资料可按需求另交，启动游戏不要求把所有抓取缓存复制一遍。
- 不要把 `.local-data` 整个公开打包：其中还有本地密钥、测试身份、数据库副本和部署快照。

## 导出与补录流程

1. 核实同队的**具体地图阵容**与 HLTV ID；保留 `mapstatsid` 页面，能拿到的系列赛、赛事链接也保留。不要把参加同一届赛事的所有选手两两连接。
2. 少量用户反馈优先追加 `data/cslink/manual-relations.json`，按现有结构保存该队五人、日期、来源和指纹；参考 `server/test/services/cslinkManualRelations.test.ts`。
3. 使用 Node 26 导出；脚本只读源库，逐个输出文件用临时文件替换，但**并非整组文件一次原子切换**，生产应先构建到暂存目录。

```sh
node scripts/build-cslink-data.mjs
python3 scripts/cslink_popularity.py
```

第一条支持 `CSLINK_SOURCE_ROOT`、`CSLINK_DATA_OUT`、`CSLINK_MANUAL_RELATIONS_FILE`；第二条目前固定使用本地目录，且统计的输入并不等于所有补录层，不要误以为两个脚本都有同样的可移植参数。热度变化会改变未来题目池，需审查前 60/150 名名单。

4. 验证新增关系的前端导出、服务端判定与 HLTV 证据一致；检查 NiKo/niko、同名人物未被误合并。缺图选手还需检查活跃筛选，单加关系不一定能搜索到。
5. 构建前端并带上数据和 WebP。`build-cslink-data.mjs` 不负责图片转码，也不会顺带更新热度文件。
6. 本地通过后按用户授权部署；手工关系和筛选可走受保护重载，替换源 SQLite 整库则计划重启。不要只更新前端边表。

`players.json` 行字段依次是：ID、花名、照片编号、来源图数、旧身份上下文、最近收录队伍、最后收录 S/A 出场年份。`edges.json` 键为按序排列的两个 ID 以 `|` 相连，值为赛事名与 HLTV 地图链接。前端导出同一对通常保留日期最新的证据，底层可有多条。

## 采集边界与已知缺口

当前新赛事大量使用每队首图/少量地图覆盖，足以快速发现多数常规阵容，但会漏掉赛事中途替补、短期混合阵容和低级别比赛。不能宣传“所有历史队友关系完整”。旧库已有五人分组和 HLTV 地图证据，直接导入的目标已完成，598 张并不代表整个旧库只接入 598 张。

采集脚本包括 `cslink_hltv_collect.py`、`cslink_hltv_stage.py`、`cslink_hltv_finalize.py`、`cslink_event_cover.py`，旧库导入是 `cslink_legacy_import.py`。先看脚本 `--help` 和当前 manifest，再决定操作；目录名、脚本存在不代表某批已上线。

B 级赛事试点原始目录为 `.local-data/cslink/btier-pilot-2026-10-24/`，有赛事清单及抓取缓存。此次没有重新核实其完备率或确认全量纳入生产，接手者不能把试点当已完成扩库。采集要限量、有断点和缺页报告，使用后台方式，不操纵用户正在工作的前台 Chrome。

昵称词库是 `data/cslink/nick-lexicon.json`，由 `scripts/build_nick_lexicon.mjs` 生成，人工放行见 `nick-lexicon-allow.json`；已有拆字/拼音等归一化，必须测误伤。照片抓取入口 `scripts/cslink_portraits.py`；PNG 转 WebP 的既有成品也需交接，不能仅交抓图脚本。
