# 109 届 A/S 赛事：本地玩法批量纳入投影

用户在 2026-10-04 明确要求“新的109届比赛直接合并吧”。这个决定批准**当前已采集的 A/S 赛事样本用于本地玩法**，不等于逐张地图人工复核，也不更改候选 SQLite 中的 `review_state=unreviewed` 与 `eligible_for_questions=false`。原始候选库仍完整保留，生产发布、公开排行及来源使用权的审核另行处理。

投影由 [`scripts/cslink_local_play_projection.py`](../../scripts/cslink_local_play_projection.py) 离线生成，输入是校验过 SHA-256 的候选库、修正计划、审计报告和 [`as-tier-local-play-2026-10-04-approval.json`](as-tier-local-play-2026-10-04-approval.json)。输出位于 `.local-data/cslink/as-tier-local-play-v1/`：

- `manifest.json` 是本地玩法的地图白名单，包含 `included_map_ids`、109 个 `approved_event_urls`、3 张 `excluded_maps`、审批性质与候选来源指纹。`version` 按固定字段及顺序计算，可由后端独立复算；
- `report.json` 是校验统计和限制说明。后端须核对候选 SQLite 和 manifest 的 SHA-256，且白名单与排除名单无交集、合起来恰好覆盖该候选库的 805 张图。

当前 805 张候选图中，**802 张纳入、3 张排除**，109 届赛事仍各有正式地图可用。802 张图产生 828 名数字身份选手、3155 对队友身份关系及 16040 条“队友对 × 地图”证据。只使用同一张图同队的五名实际出场选手生成连边；地图 URL、十人名单、比分、赛事 URL、来源修订与抓取指纹仍在原候选 SQLite。昵称只是显示值，`NiKo`（HLTV 3741）和 `niko`（10264）不会合并。

排除依据是 HLTV 地图页显示的赛事名称与既定 A/S 正赛范围：

| HLTV 地图 | 页面显示赛事 | 排除原因 |
| --- | --- | --- |
| [179981](https://www.hltv.org/stats/matches/mapstatsid/179981/-) | BetBoom Dacha Belgrade Season 2 Europe Closed Qualifier | 独立封闭预选赛误挂在 BLAST Premier Fall Groups 2024 的候选计划下 |
| [198346](https://www.hltv.org/stats/matches/mapstatsid/198346/-) | Showmatch CS | IEM Melbourne 2025 期间的表演赛 |
| [198835](https://www.hltv.org/stats/matches/mapstatsid/198835/-) | Showmatch CS | MESA Nomadic Masters Spring 2025 期间的表演赛 |

`Play-in`、`Stage 1/2` 等属于同一赛事的阶段名称；当前白名单没有因为这些名称不同于赛事标题而自动排除。若未来更换候选库版本、抓取、计划、审计或排除决策，构建器会因锁定的哈希或范围冲突而停止，需要重新检查并更新审批输入。即使批量纳入，所采集的仍仅是每个选定系列赛的一张地图；不能推断未采集地图、整届恒定阵容或历史上不存在其他队友关系。

重建与测试：

```bash
python3 scripts/cslink_local_play_projection.py
python3 -m unittest scripts.tests.test_cslink_local_play_projection -v
```

构建器会逐图复算十人、两队各五人、互反比分、HLTV 数字 ID 与 URL、同队配对，以及完整来源元数据；发现缺项、跨队边、排除项未登记、名单变化或输入指纹变化时停止生成，不覆盖已存在的投影。
