# 2022 卡托维兹 FaZe 换阵试点

旧库的 `IEM Katowice 2022` 有 109 张地图记录，FaZe 出现于其中 20 张；这只是历史 CSV 的候选记录，原始选手昵称没有稳定身份编号。此试点从中选出三场不同系列赛的各一张地图，逐张用 HLTV 地图统计页读取两队十名实际出场者和数字选手编号。赛事范围另由 [Liquipedia 的 IEM Katowice 2022 页面](https://liquipedia.net/counterstrike/Intel_Extreme_Masters/Season_XVI/Katowice)及本地缓存的 `Match/Map.stats` 精确地图链接交叉确认，赛事分级为 S-Tier。

| 地图 | FaZe 在该图实际出场的五人 | 换阵情况 |
| --- | --- | --- |
| [134047：对 Liquid，Mirage](https://www.hltv.org/stats/matches/mapstatsid/134047/liquid-vs-faze) | karrigan #429、jks #4679、rain #8183、Twistzz #10394、broky #18053 | jks 上场，ropz 未上场 |
| [134118：对 fnatic，Overpass](https://www.hltv.org/stats/matches/mapstatsid/134118/faze-vs-fnatic) | karrigan #429、rain #8183、Twistzz #10394、ropz #11816、broky #18053 | rain 与 ropz 同场，jks 未上场 |
| [134388：对 G2，Inferno](https://www.hltv.org/stats/matches/mapstatsid/134388/g2-vs-faze) | karrigan #429、jks #4679、Twistzz #10394、ropz #11816、broky #18053 | jks 与 ropz 同场，rain 未上场 |

这里的“未上场”只指对应的这一张地图，不表示整届赛事都缺席。队友关系仅由单图同队出场产生，不按赛事报名名单、旧 CSV 的昵称或赛前阵容推断。HLTV 页面显示的时间只保留为来源原文，尚未校准时区。三图的两队各五人、十个不同数字编号、编号与选手页面 URL 一致、双方比分互反均通过结构检查；试点名单与选手数字编号另做校验。三张图尚未由人工逐图审阅全部字段，库内仍为 `unreviewed`、`eligible_for_questions=false`；单独的本地玩法投影准许在个人本地使用这些观察证据，不代表公开题库验收。

可复现的运行顺序（在仓库根目录，Chrome 的 OpenCLI Browser Bridge 已连接时）：

```bash
python3 scripts/cslink_legacy_roster_pilot.py plan
python3 scripts/cslink_hltv_collect.py \
  --plan .local-data/cslink/historical-as-v1/plan/selected-series.jsonl \
  --output .local-data/cslink/historical-as-v1/captures \
  --opencli .local-tools/opencli/node_modules/.bin/opencli \
  --interval 10 --retries 1 --timeout 70
python3 scripts/cslink_legacy_roster_pilot.py build
python3 scripts/cslink_legacy_local_play.py
python3 -m unittest discover -s scripts/tests -p 'test_cslink_legacy_roster_pilot.py' -v
```

`plan/manifest.json` 固定旧 CSV 与 `exact-map-queue.jsonl` 的哈希。后者每行必须将旧地图 URL 精确连到 Liquipedia 赛事页缓存中的 `Match/Map.stats`，并绑定赛事页修订哈希；否则计划拒绝生成。`plan/correction-ledger.jsonl` 是真实的空文件，哈希为 `e3b0c442...`，用于满足候选库的统一来源字段，表示本试点没有地图编号修正。抓取保存单图来源 URL、捕获时间、赛事页和来源修订哈希，失败日志可在 `captures/attempts.jsonl` 查。`library/` 复用现有候选库 SQLite schema，`play/` 是带地图白名单和版本哈希的独立本地投影。旧库、候选库和未经个人本地放行的赛事不因试点被更改。

截至 2026-10-08，本次最终候选库版本为 `bc8e76c697119bc4d071`，本地投影版本为 `583f3152d17aab171a8e`：3 图、21 个数字身份、45 对候选队友、60 条逐图证据。最初以旧 CSV 哈希代替赛事页哈希的抓取与候选库已保存在 `.local-data/cslink/historical-as-v1/captures-initial-csv-provenance/` 和 `library-initial-csv-provenance/`，不在最终白名单中。版本随新抓取或扩大历史范围而改变，不应在服务代码中硬编码。
