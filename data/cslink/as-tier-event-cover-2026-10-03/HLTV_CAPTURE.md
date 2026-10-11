# HLTV 首轮出场采集运行说明

用户报告已收到 HLTV 管理员允许其个人非商用游戏自行采集的邮件。本地运行记录只标记为 `user_reported_admin_permission_personal_project`；本仓库不保存邮件，也不据此推断公开再分发权限。

2026-10-03 先按 [`pilot-sample.jsonl`](pilot-sample.jsonl) 完成 24 张地图试点：24/24 获得两队各五名实际出场选手及各自数字编号，0 张失败。随后启动 [`selected-series.jsonl`](selected-series.jsonl) 的 805 张首轮批次，复用已抓地图；目标是为每届赛事的每支赛程队伍先提供一张可复核单图，不代表补齐全部地图或赛事中全部阵容版本。

原始 805 张队列最终抓到 804 张，首图 `167590` 的构造链接返回 404。HLTV 官方赛事页实际给出 `167591`；纠错账本和已完成的独立续跑见 [2026-10-04 有效计划](../as-tier-event-cover-2026-10-04-corrected/README.md)。以下命令查看原始批次的历史状态：

```bash
python3 scripts/cslink_hltv_status.py
```

本地详细日志与原始结果保存在 Git 忽略目录 `.local-data/cslink/hltv-capture/`，其中 `full-batch.log` 是实时事件日志，`attempts.jsonl` 记录每次尝试与错误，`<mapstatsid>.json` 保存单图十人原始结果及来源。后台进程使用 `caffeinate -i` 防止空闲睡眠；若 Chrome 浏览器或 OpenCLI 扩展断开，队列最多重试一次，连续三张失败会停止。遇站点拒绝或验证页面立即停止该批次。

已抓结果会先校验两队各五人、十个不同的选手数字编号、选手 URL 与编号一致、地图编号一致、双方比分互反。脚本只从捕获内容产生**待复核候选**；`NiKo` 与 `niko` 按各自数字编号分开。中断后可运行以下命令复用现有有效文件并继续：

```bash
python3 scripts/cslink_hltv_collect.py \
  --plan data/cslink/as-tier-event-cover-2026-10-03/selected-series.jsonl \
  --interval 10 --retries 1
```

原始后台批次结束后，`scripts/cslink_hltv_finalize.py` 在 `.local-data/cslink/hltv-stage/` 生成了按数字身份去重的选手、候选队友边、逐图证据、缺图和疑似换阵报告；`.local-data/cslink/hltv-capture/full-batch-final.json` 保留原批次的部分完成状态。修正后的新目录另有完整报告。所有候选继续保留 `eligible_for_questions=false`，待逐届赛事范围、队伍身份、临时替补和证据复核通过后才能进入游戏题库。
