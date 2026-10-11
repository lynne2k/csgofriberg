# 首轮 HLTV 候选队友关系库

`scripts/cslink_candidate_library.py` 从修正后的 805 行首轮采集计划与逐图原始抓取，在本机离线生成 `.local-data/cslink/candidate-library-v1/`。产物为 `library.sqlite3`、`report.json` 和 `manifest.json`。它可以与旧已复核关系库按 HLTV 数字 ID 在本地综合查询中并列展示，但审核状态与游戏题库隔离；全库保持 `review_state=unreviewed`、`eligible_for_questions=false`。

每张图须有 HLTV 单图 URL、互反比分、两队各五位数字 ID 选手。只有同一张图、同一队五名出场选手之间才生成队友证据；每队十组，整图二十组。选手以 HLTV 数字 ID 为主键，昵称逐图按原样保存，绝不按大小写或相似字形合并。因此 `NiKo` 与 `niko` 只有在数字 ID 相同时才会视作同一人。重复出场合并为一条候选关系，同时保留每张图的证据，不把同场对手连成队友。

构建器逐图复用 `validate_capture`，再核对采集 URL、计划的赛事 URL、HLTV 系列 ID、来源修订指纹。若旧抓取缺少后三个元数据字段，只能核对其单图 URL；地图会被显式标记为 `capture_provenance_status=metadata_missing`，报告列出缺失字段。元数据存在但与计划冲突时构建直接失败。修正计划及修正账本的摘要也须与计划清单吻合。构建器不会凭计划回填抓取本身缺少的证明。

库结构：

- `players`：数字 ID、展示昵称、原样昵称合集、HLTV 选手链接及出现地图数；
- `maps`：单图、系列赛、赛事、地图名、时间、HLTV 来源链接、来源修订、抓取 SHA-256 和溯源状态；
- `appearances`：逐图选手、当时昵称、队名及双方比分；
- `edges`：按数字 ID 排序的候选队友对与证据图数；
- `edge_evidence`：一组队友在某张图同队出场的记录，可联接 `appearances` 找到完整五人名单。

`manifest.json` 记录库文件及报告的字节数与 SHA-256，也记录计划、计划 manifest、修正账本、805 份抓取内容合集的摘要。`version` 是 SQLite 文件 SHA-256 的前 20 位。地图表另有逐份抓取的 SHA-256；改动任一原始文件后须重新构建，不能沿用旧 manifest。应用层可把该库作为本地候选证据预览或带状态的综合查询来源，不得用 `edges` 直接生成正式题目。

在仓库根目录运行：

```bash
python3 scripts/cslink_candidate_library.py \
  --plan data/cslink/as-tier-event-cover-2026-10-04-corrected/selected-series.jsonl \
  --captures .local-data/cslink/hltv-capture-2026-10-04-provenance-complete \
  --output .local-data/cslink/candidate-library-v1
python3 -m unittest scripts.tests.test_cslink_candidate_library -v
```

上述 `--captures` 目录包括补抓后的 `160519`：其赛事 URL、系列 ID 与来源修订元数据齐备；原先缺少这些字段的缓存保留在旧批次，不作为本库输入。当前首轮计划覆盖每场选取的一张图，不代表全部比赛地图或全部阵容变化。上线题库仍需独立审核具体出场、队伍归属、来源使用条件和题目可解性。
