# 旧数据库的高收益补抓流程

2026-10-10 更新：游戏关系改为[直接复用旧库名单与链接](data/cslink/LEGACY_DIRECT_IMPORT.md)。以下是可按需使用的补抓流程和历史批次记录，不再要求每张旧图都补抓后才能用于本地游戏。

此补抓流程用于解决身份歧义、修复冲突或增加直接观察证据；抓到的数字编号不能由昵称伪造。

## 当前基线（2026-10-09）

- 2023-07-13 前的 A/S 档精确赛事清单有 11,882 张地图，其中 598 张已取得并校验十人出场记录，27 张属于更早的逐图人工复核记录。两者可能重叠，不能直接相加当作独立地图数。
- 本地关系图还包含 802 张较新的地图，共有 1,620 名有编号的选手、7,887 对不同的队友关系。598 张旧图仍标为 `unreviewed`，可用于本地预览，不代表完成逐图人工复核或公开发布验收。
- 对未入库旧图，2,667 张的两组五人昵称可在**同一赛事**的已校验地图中找到完全相同的阵容；按现有证据推测，这些地图不会增加新的队友组合，故先延后逐图补抓。这不等于证明每张旧图都没有换人，也不等于把这些旧图录入游戏。
- 3,720 张有未知或有歧义的昵称，需单独发现身份。昵称大小写敏感；`NiKo` 和 `niko` 是不同选手，`rain` 等同名昵称不能跨赛事直接套用编号。

## 生成补抓队列

```bash
python3 scripts/cslink_legacy_pair_priority.py --top 50
python3 -m unittest scripts.tests.test_cslink_legacy_pair_priority -q
```

脚本只从当前**已入选游戏投影**的地图与 27 张人工复核图建立身份锚点，逐图重新检查旧库行与 Liquipedia 的精确 `Match/Map.stats` 链接、比分及地图名。它优先使用同一赛事中完全相同的五人昵称组；跨赛事的唯一昵称匹配仅用于估计采集收益。重名、多编号、缺人、队伍人数不对、比分或地图不符的图不会作为完整十人优先级候选。估计出的身份和关系只写入排序报告，绝不写进可玩关系图。

每轮按**尚未获得证据的新队友组合**的边际数量排序；一张图预测的组合若已被先前选中的图覆盖，就降低其优先级。因此不按赛事逐张重复抓同一阵容。当前冻结的下一轮前 50 张计划在 `.local-data/cslink/legacy-pair-priority-v1/versions/8797dce11184b8c369ad/top-50-collector-plan.jsonl`；以现有昵称假设估计，它们合计可能覆盖 228 对尚无证据的组合。这个数字仅用于选图，实际新增关系必须等 HLTV 抓取、校验和入库后才能统计。输入指纹、被延后的图、身份冲突和 Liquipedia 对照失败原因在同版本的 `manifest.json`、`report.json` 和各 JSONL 文件中。每次提升新地图后重跑脚本，队列会按新基线改变；采集时使用刚生成的完整版本路径。

对于仍有未知或重名昵称的地图，用第二阶段发现脚本从**已冻结的**部分身份清单中选少量地图，分别覆盖未见过的赛事内五人组、待识别昵称和重名上下文。它只输出待抓清单，不将昵称推断写入关系图：

```bash
python3 scripts/cslink_legacy_partial_discovery.py \
  --priority-dir .local-data/cslink/legacy-pair-priority-v1/versions/8797dce11184b8c369ad
```

当前冻结的 12 张发现清单在 `.local-data/cslink/legacy-partial-discovery-v1/versions/b3abae18b2fb6c6b1598/collector-plan.jsonl`。使用它时，采集器必须显式传入下节的历史抓取目录；若使用采集器默认输出目录，历史批次不会扫描到新文件。

## 有来源证据的采集与提升

在同一个已连接 OpenCLI Browser Bridge 的 Chrome 会话中，HLTV 地图页面可正常访问后，进行小批量采集：

```bash
python3 scripts/cslink_hltv_collect.py \
  --plan .local-data/cslink/legacy-pair-priority-v1/versions/8797dce11184b8c369ad/top-50-collector-plan.jsonl \
  --output .local-data/cslink/legacy-hltv-capture-pilot \
  --limit 3 --interval 10 --retries 1
```

采集器验证地图 URL 和十人结构，复用来源一致的已存文件，并保留逐次日志。目标地图返回 403、429 或 Cloudflare 验证页时立即停止整批；不自动处理人工验证，也不继续重试这类拒绝。2026-10-09 的初次试采中，[地图 102440](https://www.hltv.org/stats/matches/mapstatsid/102440/syman-vs-pro100) 的 OpenCLI trace 明确显示 403 和 `cf-mitigated: challenge`；用户在连接 OpenCLI 的 Chrome 中完成验证后，该地图及后续批次均正常抓取。先前单独获取的 [地图 139193](https://www.hltv.org/stats/matches/mapstatsid/139193/k23-vs-ex-mad-lions) 已使旧图从 473 增至 474。后续采集不应把临时超时当作阵容缺失或赛事不符。

### 2026-10-09 恢复采集记录

以 474 张旧图和 6,685 对队友关系为起点，按每轮新基线重排，依次采集 3、10、20、17 张不同地图。这 50 张均取得十人数字编号并通过赛事页面、地图、比分和日期校验；四轮提升后的历史批次为 `.local-data/cslink/historical-as-batch-v1/versions/1867df47dbbae35129cc/`，旧图达到 524 张，队友关系达到 7,240 对，实际净增 555 对。网站路由实测读到 1,326 张总地图、47,464 道题。独立核对还确认旧 474 张地图的来源文件指纹和数据库行未变，新增图带来 1,000 条地图级队友证据；部分关系在较新地图中已有证据，因此合并图净增的不同队友组合是 555 对。已有的两张比分冲突图继续隔离，本轮没有新增拒收，也没有丢失先前已入库地图。

四轮采集所用的冻结计划版本依次为 `c8b60b9d334548010ca0`、`dbb3863aed3cfc806adc`、`c4f118caf1f191871976`、`69d6b4f12892bb816508`。每轮按当时计划预测的边际新增关系依次为 53、147、214、141 对，入库后的实际增量与这四个数分别一致；这只能说明本轮的排序假设经受住了验证，不能保证下一轮仍然完全一致。每轮的抓取状态保存在 `.local-data/cslink/legacy-hltv-capture-pilot/attempts.jsonl`，版本化入库报告保存在历史批次对应的 `batch-report.json`。

随后用计划 `ab5391a26ac3a7791cea` 再抓 50 张，全部通过校验，关系净增 272 对。接着用部分身份计划 `a0b083d70cd2bf10f9c6` 和 `7634658b525b93a2f2bb` 各抓 12 张，分别增加 65 名、44 名有编号的选手，以及 204 对、171 对关系。两轮发现使“身份不完整”候选从 4,237 张降到 3,720 张；它只是说明更多旧图可用于后续排序，其余旧图并未自动入库。

本次恢复采集合计新增 **124 张旧图、109 名有编号的选手、1,202 对不同队友关系**。当前历史批次固定版本为 `.local-data/cslink/historical-as-batch-v1/versions/ed29b3e400303ef6eaca/`；网站路由实测读到 1,400 张总地图和 53,450 道题。独立跨版本核对确认旧 474 张地图的原始抓取文件和数据库行均未改变；新增 124 张各有两队五人的数字编号，形成 1,240 条出场记录与 2,480 条地图级队友证据，来源、日期、地图和比分均通过校验。本次各批次均未新增拒收，原先两张比分冲突地图仍隔离。下一轮应使用本文件前述的 `8797dce11184b8c369ad` 或 `b3abae18b2fb6c6b1598` 冻结计划；采集后重新排序，不能沿用已过期的收益预测。

有新抓取时，先构建独立 staging 并检查 `batch-report.json` 的 `rejected_captures`、`failed_capture_attempts`、`by_year` 与是否保留既有地图，再提升：

```bash
python3 scripts/cslink_legacy_batch.py \
  --output .local-data/cslink/historical-as-batch-staging-priority-v1
python3 scripts/cslink_legacy_batch.py \
  --promote-from .local-data/cslink/historical-as-batch-staging-priority-v1 \
  --output .local-data/cslink/historical-as-batch-v1
```

提升会检查新版本未丢失已入库地图，并以原子方式切换 `current`。本地服务需重启才能读到新版本；随后运行 `node scripts/cslink_local_route_smoke.mjs` 核对实际页面使用的地图和关系数量。
