# 2023 年 7 月前 A/S 赛事增量入库

> 2026-10-10 更新：游戏现已直接使用旧库五人名单和 HLTV 链接，见 [旧库直接导入](data/cslink/LEGACY_DIRECT_IMPORT.md)。下文仅描述需要补充数字选手编号时的可选抓取流程，不再是旧比赛进入游戏的前置条件。

`scripts/cslink_legacy_batch.py` 把旧数据库中有赛事页面精确 `Match/Map.stats` 链接、且已取得完整 HLTV 地图统计的比赛加入本地队友关系库。旧数据库里的昵称仅用于寻找地图；选手身份和同队关系一律来自该地图的 HLTV 数字选手编号及实际十人出场记录。相同系列的多张地图可以分别入库，以保留图间换阵或替补。

按新增队友组合的预期收益选择下一批地图，见 [旧数据库的高收益补抓流程](LEGACY_PAIR_PRIORITY.md)。

默认输入：

- `.local-data/cslink/legacy-as-catalog-v3-fa3577c0e653c6ed8378/`：当前默认的固定旧赛事清单、精确地图队列和采样计划。它在 v2 冻结队列上累计新增官方赛事短名证据；脚本核对 v2 manifest 与队列的指纹绑定、新增地图逐图准入审计、官方短名分组和 Liquipedia 原页中的 `tickername` / `shortname`、比赛日期。
- `.local-data/cslink/legacy-as-catalog-v2-015ecc29658c3fb6a81c/`：保留供审计的旧版本，不能用它重建当前 v3 批次，否则会漏掉 v3 新增赛事。
- `.local-data/cslink/legacy-hltv-capture-pilot/` 与 `.local-data/cslink/historical-as-v1/captures/`：已抓取的 HLTV 地图文件。可重复传入 `--captures 路径` 添加新的抓取目录。
- `.local-data/cslink/versions/69d3bb14fb82e70ea452/staging.sqlite3`：冻结的旧地图索引；其文件指纹必须与历史清单一致。

运行：

```bash
python3 scripts/cslink_legacy_batch.py
python3 -m unittest scripts.tests.test_cslink_legacy_batch -v
```

构建 v3 到独立 staging 并核对报告：

```bash
python3 scripts/cslink_legacy_batch.py \
  --catalog .local-data/cslink/legacy-as-catalog-v3-fa3577c0e653c6ed8378 \
  --output .local-data/cslink/historical-as-batch-staging-v3
python3 scripts/cslink_legacy_batch.py \
  --promote-from .local-data/cslink/historical-as-batch-staging-v3 \
  --output .local-data/cslink/historical-as-batch-v1
```

提升前应检查 staging `batch-report.json` 中的 `rejected_captures`、`failed_capture_attempts`、`by_year`，并确认旧 `current` 的全部地图均在新版本。提升命令还会自动阻止旧图消失。若抓取目录继续增加，先重跑 staging 构建再提升；`--promote-from` 固定使用已核验的 staging 版本。

需要先单独审计一个批次时，用 `--output .local-data/cslink/historical-as-batch-staging-v2` 构建到独立目录；审计通过后执行 `python3 scripts/cslink_legacy_batch.py --promote-from .local-data/cslink/historical-as-batch-staging-v2`。提升过程再次核对整个版本及旧 `current` 中的地图，并原子切换指针，不重新选取当时可能仍在增长的抓取目录。

脚本先核对历史清单每个文件的大小和 SHA-256，并确认赛事名称规则版本、规则代码指纹和有抓取证据的别名账本指纹。每张图还要复核旧数据库行、赛事 A/S 档次与起止日期、Liquipedia 页面修订及 `Match/Map.stats` 精确链接。原始赛事页的 `Match.date` 必须与旧图和 HLTV 显示日期相差不超过一天；地图名、双方回合分数（含加时）、赛事名称规则和两队各五人的数字选手编号也必须一致。Liquipedia 的队伍短代码会保存为来源证据，但短代码本身不能直接当作 HLTV 队伍身份。页面、地图、系列、比分或选手身份不一致时，该地图不进入候选库。自动识别的表演赛和独立预选赛也不会进入本地游戏投影。

构建成果存放在 `.local-data/cslink/historical-as-batch-v1/versions/<版本号>/`，包含 `plan/`、`captures/`、`library/`、`play/`、`batch-report.json`、`remaining-cover-plan.jsonl`、`remaining-cover-status.jsonl` 和 `remaining-exact-map-queue.jsonl`。`current` 是原子更新的版本符号链接；只有全部校验成功后才切换。原先的 `.local-data/cslink/historical-as-v1/` 三张 Katowice 试验图不会被覆盖；默认构建还要求这三张图持续存在。已入库的地图不能因后续抓取文件丢失或出错而从 `current` 中悄悄消失。

再次采集后直接重跑同一命令即可增量纳入通过校验的地图。已经抓到但不在首轮覆盖计划中的地图，只要还在最终精确地图队列并通过相同校验，也会保留。若同一地图重复抓取，时间戳等元数据可以不同；脚本比较地图/系列 URL、来源修订、赛事和比赛日期、比分及十人数字身份，一致时优先保留原 Katowice 试验文件，真正冲突时隔离该图。未抓地图留在两个剩余队列里；覆盖采样队列另有逐图状态，区分未尝试、采集失败和抓取文件校验失败。比如返回十一名选手的地图会保留失败原因，不能假定其中任意十人同场出赛。

`current` 默认拒绝任何导致已入库地图消失的重建。这是为了避免临时抓取失败把关系从游戏里悄悄删掉。如果日后确认某张已入库地图本身有误，需要先建立带原因和来源证据的显式撤销记录，经过人工审计后再实现受控撤销；当前脚本没有隐式撤销开关。

此脚本的 `play/` 只包含补抓得到的地图，仍标记为 `unreviewed`，不表示逐图人工复核完成。游戏同时加载旧库直接导入的五人名单与原有 HLTV 链接；因此此脚本的采集进度不等于当前游戏的历史覆盖进度。
