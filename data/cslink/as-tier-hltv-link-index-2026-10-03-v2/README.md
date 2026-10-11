# A/S 地图的 HLTV 参考链接索引

此索引从 [冻结的赛事与地图编号快照](../as-tier-snapshot-2026-10-03/README.md)和同一批 Liquipedia 页面缓存的系列赛编号生成，覆盖 2023-07-13 至 2026-10-03 已发现的 **6,816 张单图和 3,118 场系列赛**。每条 `map-links.jsonl` 均保留 Liquipedia 赛程页、来源内容校验值、赛事级别、HLTV 单图编号和系列赛编号，并增加：

- `game_link`：兼容旧数据集 `historic_games_list.csv` 的相对单图路径字段。
- `hltv_map_url`：可点击的 HLTV 单图统计页。
- `hltv_series_url`：可点击的 HLTV 整场系列赛页面；若地图与两个系列赛模板关联，该字段留空并提供 `hltv_series_candidate_urls`。
- `hltv_link_status`：`constructed_from_liquipedia_id` 表示依据 Liquipedia 编号构造 URL；`map_url_constructed_series_ambiguous` 表示单图链接可构造，但系列赛关联需复核。均不代表逐条访问 HLTV 核验。

`series-links.jsonl` 按系列赛编号去重，其中 **3,097 场有单图编号，21 场暂无单图编号**，后者仍有系列赛参考链接。另有 **3 个单图编号在 Liquipedia 赛程模板里关联了两个系列赛**，详见 `series-map-conflicts.jsonl`；索引保留单图链接和两个候选系列赛链接，不擅自判定其归属。`report.json` 记录数量和输入 SHA-256，`manifest.json` 固定输出校验值。6 张标为已结束但缺单图统计编号的地图仍需补查，不能凭空构造其单图链接。

URL 末尾的 `/-` 是占位路径段：人工抽样中，[2023 年地图 159569](https://www.hltv.org/stats/matches/mapstatsid/159569/-) 跳转到 `vitality-vs-evil-geniuses`，[2025 年地图 190897](https://www.hltv.org/stats/matches/mapstatsid/190897/-) 跳转到 `betboom-vs-g2`，[系列赛 2378454](https://www.hltv.org/matches/2378454/-) 跳转到其实际比赛页。其余链接未逐条检查；失效或编号不匹配时需要隔离和修正。

旧数据来自 [tedtay 的数据仓库](https://github.com/tedtay/CS-GO-Pro-Matches-Comprehensive-Dataset)。其公开脚本 `main_gcp_vm.py` 读取预存在作者 GCP 中的 `historic_games_list.csv`，再用 Selenium 和固定 CSS 位置解析 HLTV 页面；它保留 `game_link` 字段，但不是可以直接接续至 2026 年的独立采集程序。这里复用链接字段与编号去重思想，没有运行该脚本或批量请求 HLTV。HLTV [使用条款 2.2](https://www.hltv.org/terms)禁止数据挖掘和网页抓取。若要把 2023 年后的**单图实际出场十人名单**投入网站，仍需取得许可明确的数据源；参考链接本身不能证明两位选手同队出场。

从仓库根目录使用已缓存的 Liquipedia 页面重建：

```bash
python3 scripts/cslink_tier_enrich.py
python3 scripts/cslink_hltv_link_index.py
python3 -m unittest discover -s scripts/tests -p 'test_cslink_*.py' -v
```

脚本拒绝覆盖内容有变的同名索引。新一轮来源刷新应使用新的版本目录，审查增减的编号和链接。`NiKo` 与 `niko` 的身份继续严格分开；本索引没有选手身份字段。
