# A/S 级赛事与单图编号发现快照

核对日期：2026-10-03。范围为旧 CSV 最后日期 2023-07-13 起至本日，包含首日重叠以便按单图编号去重。来源为 [Liquipedia Counter-Strike](https://liquipedia.net/counterstrike/) 的 [MediaWiki API](https://liquipedia.net/api-terms-of-use)；Liquipedia 内容适用 [CC BY-SA 3.0](https://liquipedia.net/api-terms-of-use)，使用或再发布时须保留来源归属并遵守该许可。每条赛事和地图候选都记录赛事或赛程子页 URL；本快照不包含原始页面全文。

| 产物 | 含义 |
| --- | --- |
| `events.jsonl` | 110 届索引候选、逐届 Infobox 分级和日期、缓存校验值、异常标记 |
| `map-id-queue.jsonl` | 6,816 个不同的单图编号、对应 HLTV 系列赛编号和 Liquipedia 赛程页；只作发现队列 |
| `new-map-id-queue.jsonl` | 与旧版本 `69d3bb14fb82e70ea452` 按单图编号去重后，6,811 个未出现于旧库的候选 |
| `report.json` | 数量、旧库重叠及未解决问题 |
| `manifest.json` | 以上文件的 SHA-256 和字节数 |

四个 A/S 分级索引通过 API `action=parse` 获取；110 届赛事主页及 17 个赛程阶段子页通过 API `action=query` 获取 Wikitext。请求使用项目联系方式标识、gzip、连接复用与缓存，分别遵守 `action=parse` 至少间隔 30 秒、普通 API 请求至少间隔 2 秒的限制。联系方式仅在请求头中使用，不写入仓库。原始 API 回复和响应校验记录位于本地忽略目录 `.local-data/cslink/as-tier-api`、`as-tier-event-pages`、`as-tier-subpages`。

赛事索引与逐届 Infobox 的 A/S 级分级一致；这仍不代替逐届范围复核。独立资格赛和 Major RMR 已在索引候选阶段排除。队列对同一单图编号去重，隔离了 8 处把系列赛编号误写入 `stats` 字段的值。另有 6 张标为已结束而未给出有效单图统计编号，需补查。2026-10-03 刚开赛的 ESL Pro League Season 24 当时尚无单图编号；新比赛应在后续增量扫描中补入。旧库重叠的 5 张地图编号为 159569、159572、159576、159579、159581。

**全部地图仍为 `roster_status=unverified`、`eligible_for_questions=false`。** Liquipedia 赛事报名名单与地图实际出场不同；仅凭赛事级别、系列赛编号或单图编号，不能生成正式队友关系。还需取得许可允许的单图十人实际出场数据，逐图核验双方归属和稳定选手编号。`NiKo` 与 `niko` 依旧按不同身份处理。本冻结文件不包含 HLTV URL；[补充链接索引](../as-tier-hltv-link-index-2026-10-03-v2/README.md)按已知编号生成了单图和系列赛可点击链接，但 HLTV 赛事编号及身份映射仍待补齐。

在仓库根目录重建本地缓存和候选快照：

```bash
export CSLINK_LP_CONTACT='项目公开邮箱或 HTTPS 主页'
python3 scripts/cslink_liquipedia_fetch.py --indices
python3 scripts/cslink_tier_catalog.py
python3 scripts/cslink_liquipedia_fetch.py
python3 scripts/cslink_tier_subpages.py
python3 scripts/cslink_liquipedia_fetch.py \
  --catalog .local-data/cslink/as-tier-catalog/subpage-catalog.jsonl \
  --cache-dir .local-data/cslink/as-tier-subpages --limit 17
python3 scripts/cslink_tier_enrich.py
python3 scripts/cslink_tier_snapshot.py
python3 -m unittest discover -s scripts/tests -p 'test_cslink_tier_catalog.py' -v
```

重新获取页面可能遇到赛事分级或赛程修订，不能覆盖已冻结快照；脚本会拒绝覆盖内容变化的现有快照。新一轮应另建日期目录并审查差异。
