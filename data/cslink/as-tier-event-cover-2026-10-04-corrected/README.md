# 首轮 HLTV 地图编号修正后的有效采集计划

本目录是在 [2026-10-03 冻结首轮计划](../as-tier-event-cover-2026-10-03/README.md)之上，应用 [2026-10-04 修正账本](../map-id-corrections-2026-10-04.jsonl)离线生成的新版本。原 Liquipedia 页面缓存、地图发现快照、链接索引及 805 行旧计划保持不变；它们准确记录了当时从 Liquipedia 读到 `167590` 的过程。

唯一变更是 CCT Season 1 Online Finals #5 的 HLTV 系列赛 `2368425` 首图 Overpass。原计划按 Liquipedia `stats=167590` 构造的地图 URL 两次返回 HTTP 404；经人工查看 HLTV 官方系列页，首图统计链接为 `https://www.hltv.org/stats/matches/mapstatsid/167591/into-the-breach-vs-9-pandas`。修正账本记录原始页面、原始行及旧计划的 SHA-256、两次失败 trace 编号、官方系列页、实际单图链接和按天记录的核验日期。当前没有单独保存 HLTV 系列页的不可变页面快照，因此链接核验方式明确标为人工观察，不能把它当成十人出场审核。

`selected-series.jsonl` 仍为 805 场，仅这一行改用 `167591` 和已核验的单图 URL；同一行以 `source_*` 字段保留原编号、原候选列表和原构造 URL。其他 804 行与旧计划相同。`correction-applied.jsonl` 把新旧行指纹与来源账本连接起来，`report.json` 和 `manifest.json` 固定旧输入、新计划及产物的 SHA-256。`roster_status=unverified` 和 `eligible_for_questions=false` 均未改变。赛事队伍覆盖表、24 场试点清单和赛事审核表没有依赖该有效地图编号，继续引用旧目录的相应文件。

在仓库根目录离线复现和验证：

```bash
python3 scripts/cslink_apply_map_corrections.py
python3 -m unittest scripts.tests.test_cslink_apply_map_corrections -v
```

采集器现已接受严格校验过的 HLTV canonical 单图链接。2026-10-04 的独立续跑目录 `.local-data/cslink/hltv-capture-2026-10-04-corrected/` 复用了旧批次 804 张有效捕获，并抓取 `167591` 一张。最终报告为 **805/805 张有效、0 缺图、0 无效捕获**；离线重建结果位于 `.local-data/cslink/hltv-stage-2026-10-04-corrected/`，完成标记在新捕获目录的 `full-batch-final.json`。旧采集报告、失败记录和原计划均保留为历史证据。

新捕获的 Overpass 单图通过十人、数字身份、队伍和互反比分校验：9 Pandas 13:11 Into the Breach，后者出场五人包括 Juve。HLTV [赛事页](https://www.hltv.org/matches/2368425/9-pandas-vs-into-the-breach-cct-2023-online-finals-5)也标注该场首图由 Juve 代替 rallen；这与后两图的 bevve 不同。此处完成的是首轮地图采集，不代表所有赛事地图或阵容版本已覆盖；候选关系仍是 `unreviewed` 且 `eligible_for_questions=false`，入正式题库前还需逐届赛事与证据复核。

查看新版本的状态：

```bash
python3 scripts/cslink_hltv_status.py \
  --plan data/cslink/as-tier-event-cover-2026-10-04-corrected/selected-series.jsonl \
  --captures .local-data/cslink/hltv-capture-2026-10-04-corrected
```
