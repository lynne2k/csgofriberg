# 旧图 A/S 赛事目录 v3：官方短名增量

v3 在 [v2 目录](../../.local-data/cslink/legacy-as-catalog-v2-015ecc29658c3fb6a81c/manifest.json)之上，只新增一条代码规则：旧图 `event_raw` 与**同一 Liquipedia 赛事页 Infobox 的单值 `tickername` 或 `shortname` 完全规范化相等**。必须同时满足逐届页 A/S 级及赛期审核、`Match.hltv` 系列编号与 `Map.stats` 单图编号的精确链接、旧图日期在赛事起止日前后两天内，以及逐图 Liquipedia `Match.date` 与旧图日期相差不超过一天。官方短名含 Wiki 模板/链接等复杂内容时不采用；旧名含 `Qualifier`、`Qualification`、`Regionals`、`Minor`、`Showmatch`、`All-Star` 等范围词时不采用这条规则。

固定版本为 `.local-data/cslink/legacy-as-catalog-v3-fa3577c0e653c6ed8378/`，`manifest.json` 版号为 `fa3577c0e653c6ed8378`，规则版为 `legacy-exact-scope-v3-official-shortname`。脚本是 `scripts/cslink_legacy_as_catalog_v3.py`；v2 脚本、manifest 和队列保持原样。v3 构建会核验固定 v2 manifest 与队列的 SHA-256，并要求 v2 的每张图在 v3 中保留原有字段值。候选数据仍未建立或批准选手数字身份，`eligible_for_questions=false`。

| 指标 | v3 结果 |
| --- | ---: |
| 通过的旧图合计 | 11,882 张 |
| 相比 v2 新增 | 905 张，21 届；S 级 594 张、A 级 311 张 |
| 新规则来源 | `tickername` 882 张、`shortname` 23 张 |
| 新图与 LP `Match.date` 相差 0/1 天 | 870 / 35 张 |
| 新增图独立采集计划 | 128 张，覆盖 21 届 |
| 完整 v3 采样计划 | 1,650 张，覆盖 232 届 |

`new-exact-map-queue.jsonl` 是 905 张新图的完整采集候选；`new-capture-cover-plan.jsonl` 是可传给已有采集器的 128 图增量计划。每张新图的 `official_alias_evidence` 保留官方字段名、原文、赛事页 URL、修订时间与 SHA-256，以及 Liquipedia 对应比赛日期；`new-map-admission-audit.jsonl` 逐张列出旧图日期、LP 比赛日期、两者相差天数、来源页 SHA-256 和 HLTV 链接。`new-official-alias-groups.jsonl` 列出 21 个来源组及其地图编号。完整 v3 队列、隔离清单、报告和所有输入/输出哈希也在同一版本目录。

固定文件 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| `manifest.json` | `378149d3108b4b28674e7d2d0e07d722a9aa2af9279aecc2b8ab71b4391c9e8c` |
| `exact-map-queue.jsonl` | `dfe6197b1bce97e10a1ba279b13fa8926477de85194146080b7da7a124b65fe0` |
| `new-exact-map-queue.jsonl` | `4f2c581702636d057f99f3eccb3a4e3148ce835cde0ade7ddcdf28b1c231c71f` |
| `new-capture-cover-plan.jsonl` | `ad977f4c6dcbabc42cafe381dcc58f779fa4eb4e552c320f31c634942f85f158` |

从仓库根目录复算会写到**工作用** `.local-data/cslink/legacy-as-catalog-v3/`，不会覆盖固定版本目录：

```sh
python3 scripts/cslink_legacy_as_catalog_v3.py
python3 -m unittest scripts.tests.test_cslink_legacy_as_catalog scripts.tests.test_cslink_legacy_as_catalog_v3 -q
```

在 10 秒请求起始间隔下，128 张新增采样图的请求起始跨度下界为 21.2 分钟；按 15 秒/图的排期示例是 32 分钟，均不代表实测完成时长。HLTV 数字选手身份仍需逐图抓取核验，然后由后续物化与审核流程决定是否进入可玩库。仅凭相似旧标题的其他 2022 年赛事、独立资格赛和 `Regionals` 仍在隔离清单，未借此规则自动放行。
