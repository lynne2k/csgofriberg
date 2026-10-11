# 2023 年以后 A/S 赛事队友候选库：离线审核

本报告只审核已经保存到本机的首图抓取与候选关系，不发起网络请求，也不批准候选进入正式题库。数据范围是 805 场选定系列赛各一张地图，其中 S 级 566 张、A 级 239 张；不能推断这些赛事的其余地图或整届赛事始终使用相同阵容。

## 当前结果

以 `2026-10-04-provenance-complete` 重抓版本为准，805 张地图均有有效的十人出场记录，得到 838 个 HLTV 数字选手 ID、3198 对候选队友和 16100 条“队友对 × 地图”证据。审计从原始抓取逐图重算了每队十个配对，核对候选边的地图、队伍、赛事 URL、选手 URL 和来源哈希；未发现边跨队或脱离该图。完整性问题数为 0，所有候选仍是 `unreviewed`、`eligible_for_questions=false`。

旧的 `2026-10-04-corrected` 版本中，地图 `160519` 的抓取只含 HLTV 页面 URL 与十人数据，缺赛事 URL、系列赛 ID 和 Liquipedia 来源版本哈希。该原件的 SHA-256 为 `f3cecfb1e9b41b0c2e74037d826dc47534a4ec5f3656fc506263b3768d2463a1`；它在正式批次开始前已存在，有 OpenCLI 输出文件，但没有正式批次的 attempt 记录。因此不能把来源字段或采集时间倒填到旧文件。新版本在新目录独立重抓，完整性问题由 1 降至 0，旧文件保留供复核。

重抓版本与旧版本的选手 ID、昵称、两队阵容、关系对数及证据数一致。不过 `160519` 的页面显示时间从 `2023-08-04 11:30` 变成 `2023-08-04 17:30`，使该图对应的 20 条关系证据时间字段变化。这个无时区字段只可作为“页面所显示时间”，不能直接当作 UTC 时间或稳定时间排序键；六小时时差的原因尚待核对。逐字段差异见 [`v2-v3-comparison.json`](../../.local-data/cslink/candidate-audit/v2-v3-comparison.json)。

## 人工复核优先项

1. **同名不同人**：`NiKo`（HLTV ID `3741`）与 `niko`（`10264`）只在忽略大小写后同名；`Lucky`（`13497`、`13843`）及 `rain`（`8183`、`24963`）为完全相同昵称但不同 ID。三组都必须保持独立，不能凭昵称合并。对应选手页面与抽样地图链接在 [`identity-review.jsonl`](../../.local-data/cslink/candidate-audit/v3-provenance-complete/identity-review.jsonl) 和 [`player-source-index.jsonl`](../../.local-data/cslink/candidate-audit/v3-provenance-complete/player-source-index.jsonl)。本次未发现一个数字 ID 对应多个显示昵称。
2. **赛事内换阵**：paiN 在 [PGL Astana 2025 地图 `199399`](https://www.hltv.org/stats/matches/mapstatsid/199399/-) 与[地图 `199476`](https://www.hltv.org/stats/matches/mapstatsid/199476/-) 的五人名单不同。只应按每张实际地图建立队友边；人工核对详情见 [`roster-review.jsonl`](../../.local-data/cslink/candidate-audit/v3-provenance-complete/roster-review.jsonl)。
3. **赛事范围**：入样的 109 个赛事在冻结快照里仍为“赛事范围待审”，虽其 A/S 索引与赛事页等级一致，仍需逐项复核所涵盖阶段以及 HLTV 显示赛事名。清单见 [`event-review.jsonl`](../../.local-data/cslink/candidate-audit/v3-provenance-complete/event-review.jsonl)。
4. **显示时间**：核对 `160519` 的六小时差，并在数据模型中保留时区未知语义；正式时间字段须有明确时区与来源。

统一优先清单在 [`priority-review.jsonl`](../../.local-data/cslink/candidate-audit/v3-provenance-complete/priority-review.jsonl)。审计报告在 [`report.json`](../../.local-data/cslink/candidate-audit/v3-provenance-complete/report.json)。这些清单只供人工判断，不能把“完整性检查通过”视作身份、赛事范围、授权或问题可发布的审核通过。

## 重跑

在项目根目录执行：

```bash
python3 scripts/cslink_candidate_audit.py \
  --captures .local-data/cslink/hltv-capture-2026-10-04-provenance-complete \
  --stage .local-data/cslink/hltv-stage-2026-10-04-provenance-complete \
  --output .local-data/cslink/candidate-audit/v3-provenance-complete \
  --baseline-stage .local-data/cslink/hltv-stage-2026-10-04-corrected \
  --baseline-audit .local-data/cslink/candidate-audit/v2-corrected \
  --comparison-output .local-data/cslink/candidate-audit/v2-v3-comparison.json

python3 -m unittest scripts.tests.test_cslink_candidate_audit -v
```

首次比较之前应先运行脚本默认参数，生成旧版 `v2-corrected` 审计。脚本会覆盖独立审计输出，不修改任何冻结快照、抓取文件或候选 staging 文件。
