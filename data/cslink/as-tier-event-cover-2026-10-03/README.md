# A/S 赛事队伍首轮覆盖队列

本队列从 [2026-10-03 冻结赛事／地图编号快照](../as-tier-snapshot-2026-10-03/README.md)和本地带校验值的 Liquipedia MediaWiki API 缓存离线生成，**没有访问 HLTV、5E 或完美世界比赛页**。队伍只按每届赛事页的原始 `TeamOpponent` 标记分组，不把选手昵称当身份，也不自动合并队伍别名。

目标是为“曾在正式地图同队出场”的关系图，挑选一个较小的首轮证据采集清单。每届赛事内先选能同时覆盖两支新队伍的系列赛，再为剩余队伍补选比赛；每场先取第一张已有编号的地图。算法是确定性的贪心覆盖，不保证数学上的最少场数。补抓替补、教练代打及赛事内换阵所需的地图后，实际总量可能增加。

| 文件 | 内容 |
| --- | --- |
| `selected-series.jsonl` | 805 场首轮系列赛、各自第一张待核验地图、候选其余地图、构造的 HLTV 链接和来源页指纹 |
| `pilot-sample.jsonl` | 从首轮清单中按年份和 A/S 分级分层挑出的 24 场，尽量选不同届赛事，供数据来源小批量验收 |
| `team-coverage.jsonl` | 1,577 个“赛事 × 原始队伍标记”分别由哪场首轮比赛覆盖；未做队伍身份审核 |
| `event-review.jsonl` | 赛事范围审核、队名计数差异或无地图的待处理项；其中 31 届队名计数与参赛名额不同，EPL S24 在快照时尚无地图编号 |
| `report.json`、`manifest.json` | 输入校验值、数量、产物校验值 |

`hltv_map_url` 和 `hltv_series_url` 仅按 Liquipedia 所列数字编号构造，**没有逐条打开确认**。地图的十人实际出场、选手稳定编号、来源许可和公开证据链接也都尚未验收；全部记录保持 `roster_status=unverified`、`eligible_for_questions=false`。未抽样的地图不能用来断言某位选手没有出场，基于此队列也不能生成声称“唯一答案”的正式题目。

拿到允许批量使用的逐图实际名单来源后，按本队列逐场验证两队各五人、选手编号、地图／比分／赛事及原站证据链接。若出现同队不同五人组合，再从 `candidate_mapstatsids_in_series` 或同届其他比赛补抓，保留两份来源与状态；不能直接把报名名单当作出场名单。

在仓库根目录从冻结缓存重建，并验证确定性：

```bash
python3 scripts/cslink_event_cover.py
python3 -m unittest scripts.tests.test_cslink_event_cover -v
```

脚本会核对缓存校验值及冻结地图集合；若现有输出被改变，会拒绝覆盖。赛事范围与使用权限的详细规则见 [SCOPE.md](../SCOPE.md) 和仓库根目录的 `DATA_CLEANING.md`。

技术对接样本可完全离线复验：

```bash
python3 scripts/cslink_roster_pilot.py \
  .local-data/cslink/opencli-probe-2026-10-03/cli-map-159569.json \
  .local-data/cslink/opencli-probe-2026-10-03/cli-map-215532.json \
  .local-data/cslink/opencli-probe-2026-10-03/cli-map-238674.json
```

此命令只读此前保存的三张单图 JSON，不发网络请求；其中两张属于首轮队列并通过十人、数字身份和比分校验，一张属于首轮未选地图。结果只写入 Git 忽略的 `.local-data/cslink/as-tier-event-cover-pilot/`，状态仍为技术样本、来源权限未确认、不可入正式题库。
