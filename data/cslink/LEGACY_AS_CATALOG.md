# 2023 年 7 月前旧地图的 A/S 赛事候选与抓取队列

`scripts/cslink_legacy_as_catalog.py` 在本机离线读取固定旧版 `staging.sqlite3` 和已缓存的 Liquipedia A/S 分级索引、逐届页。截止日为 **2023-07-13（不含当日）**；旧库当日另有 30 张地图，应与新批次按地图编号去重后单独处理。脚本不修改旧库、现有可玩投影或网站关系图。

输出目录 `.local-data/cslink/legacy-as-catalog-v1/` 含：

| 文件 | 含义 |
| --- | --- |
| `events.jsonl` | 索引中的旧届次、分级、日期、逐届页缓存状态与修订指纹。索引页本身只产生候选。 |
| `events-to-fetch.jsonl` | 可复现的逐届页缓存目标目录；自动排除明显取消赛事、独立 Major 资格赛及索引冲突。 |
| `events-needing-map-links.jsonl` | 逐届页级别与日期吻合，但主页及已缓存子页仍未找到有效 HLTV 地图编号的赛事。 |
| `result-subpages-to-fetch.jsonl` | 逐届页中明确转引的同届结果子页面；只保留同一赛事路径下的阶段、分组、决赛等页面。 |
| `result-subpages-rejected.jsonl` | 资格赛、表演赛或无法识别的转引标题，等待人工检查。 |
| `map-candidates.jsonl` | 旧 `event_raw` 与索引名称、日期保守匹配的地图。赛事归属仍待证实，不能直接采纳。 |
| `exact-map-queue.jsonl` | 已缓存逐届页的级别、开始/结束日期与索引一致，`Match/Map.stats` 精确给出旧地图编号，并且旧图日期落在赛事赛期前后各两天内、赛事标题通过保守规则核对的地图；保留来源页 URL、修订 SHA-256、HLTV 系列编号、旧单图 URL、标题匹配规则。 |
| `quarantined-exact-links.jsonl` | 虽有精确地图编号链接，但赛事日期、标题或多赛事归属不明确的旧图；不得用于采集或题库。 |
| `capture-cover-plan.jsonl` | 从精确队列选一张或几张图，覆盖同届各旧队伍标签和各不同的五昵称组，字段可供 `cslink_hltv_collect.py --plan` 读取。 |
| `unresolved-events.jsonl` | 尚无可信索引名称匹配或精确地图链接的原始赛事名称、数量及示例编号。 |
| `report.json`、`manifest.json` | 分年覆盖、剩余缺口、抓取时间估算和输入/输出文件指纹。 |

旧 CSV 中双方五人统计组没有可靠的队伍归属；采样计划把每个五昵称组当**待检查的阵容变化线索**，不会据此给选手编号或建立队友关系。精确地图链接也仅证明逐届赛事页列出了这张地图，实际十人名单仍要从 HLTV 单图页面读取数字身份。所有记录都保持 `eligible_for_questions=false`。

早期 19 届试点留在 `.local-data/cslink/legacy-as-catalog-pilot-v1/` 作历史审计，不可当作当前采集队列；它当时尚未逐图核对赛事日期与标题。当前全历史队列保留了 2022 卡托维兹 109 张及 2023 年 7 月 13 日前的 2023 年 1,142 张旧图。过去只凭地图编号的关联曾把其他赛事误归属到 A/S 正赛；例如地图 #156891、#59490、#137137 已被新规则排除。

全历史当前离线目录版本为 `015ecc29658c3fb6a81c`，规则版为 `legacy-exact-scope-v2`。411 个抓取目标逐届页和 60 个结果子页全部已有校验缓存；405 届逐届页的级别、开始/结束日期与索引审核条件吻合，6 届逐届页缺可解析开始日期，留待人工核对。旧库截止日前有 127,659 张地图，其中 **10,977 张**通过赛期、标题与精确 `Match/Map.stats` 编号的联合核对，覆盖 211 届；另有 **8,894 张**精确编号引用被隔离。隔离原因计数是标题无法确认 8,869、超出赛期容忍窗口 15、多赛事链接冲突 25；一张图可能有多个原因，原因数不能直接相加当作图数。另有 3 届已核对赛事页仍没有可用地图链接。全历史保守采样计划 1,522 张，覆盖各旧队伍标签和五昵称组；按默认 10 秒请求起始间隔，跨度下界为 253.5 分钟，按 15 秒/图的排期示例为 380.5 分钟。实际时长受页面加载、失败重试和站点限制影响。

标题规则只接受规范化同名、明确的主赛事阶段后缀、同名加年份、IEM 赛季与举办地的对应关系，以及带赛事 URL 和 HLTV 单图抓取证据 SHA-256 的显式别名。当前显式别名账本是 `data/cslink/legacy-event-aliases-2026-10-08.json`；其他缩写、资格赛、`Regionals` 与待证实的历史别名保持隔离。`exact-map-queue.jsonl` 每行的 `event_name_match_status`、`event_name_match_rule` 记录了采用哪条规则；`manifest.json` 固定了规则版、脚本 SHA-256、别名账本 SHA-256 和所有输出文件 SHA-256。旧昵称仅作采样线索，身份仍须逐图核对 HLTV 数字编号。

| 旧图年份 | 原始地图 | 通过联合核对的精确链接 | 隔离的精确编号引用 |
| --- | ---: | ---: | ---: |
| 2012 | 466 | 66 | 0 |
| 2013 | 2,315 | 110 | 255 |
| 2014 | 2,479 | 248 | 334 |
| 2015 | 7,390 | 232 | 650 |
| 2016 | 11,331 | 466 | 1,070 |
| 2017 | 16,881 | 672 | 878 |
| 2018 | 17,999 | 982 | 1,057 |
| 2019 | 15,256 | 1,305 | 1,011 |
| 2020 | 13,946 | 1,660 | 846 |
| 2021 | 16,296 | 2,303 | 2,198 |
| 2022 | 14,312 | 1,791 | 569 |
| 2023 年 7 月 13 日前 | 8,988 | 1,142 | 1 |

“原始地图”覆盖旧仓库各种赛事级别，不能把未进入队列的图全部称作 A/S 缺失；其中有低级别比赛，也有名称、日期、结果页和原始记录质量问题。2012–2015 年 A 级归档索引缺失，不能推断这些年份的 A 级覆盖。表中通过、隔离两列互斥，但不是原始地图的穷尽划分。

在仓库根目录复算试点：

```sh
python3 scripts/cslink_legacy_as_catalog.py \
  --event-cache-dir .local-data/cslink/legacy-as-pilot-event-pages \
  --output-dir .local-data/cslink/legacy-as-catalog-pilot-v1
```

要扩展全历史，用生成的 `events-to-fetch.jsonl` 调用已有官方 API 缓存脚本；它对请求起点限速 2.2 秒，缓存后可断点续跑：

```sh
CSLINK_LP_CONTACT='你的公开项目联系地址' python3 scripts/cslink_liquipedia_fetch.py \
  --catalog .local-data/cslink/legacy-as-catalog-v1/events-to-fetch.jsonl \
  --cache-dir .local-data/cslink/legacy-as-event-pages --limit 411
python3 scripts/cslink_legacy_as_catalog.py
# 如报告仍有未缓存的结果子页面，再限速抓取并重算：
CSLINK_LP_CONTACT='你的公开项目联系地址' python3 scripts/cslink_liquipedia_fetch.py \
  --catalog .local-data/cslink/legacy-as-catalog-v1/result-subpages-to-fetch.jsonl \
  --cache-dir .local-data/cslink/legacy-as-result-subpages --limit 1000
python3 scripts/cslink_legacy_as_catalog.py
```

当前归档索引共有 454 届截止日前的条目，其中 411 届有可解析日期且未被明显取消赛事/独立 Major 资格赛规则排除；剩余条目仍留在审计目录。A 级归档索引始于 2016 年，所以 2012–2015 的 A 级覆盖未知。逐届页本身可能把结果放在子页面，主页面精确队列是下界；同名匹配、无日期行和缺失子页面不得自行补成“已确认”。
