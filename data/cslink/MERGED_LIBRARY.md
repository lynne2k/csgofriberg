# 本地综合队友关系视图

`/teammates` 将旧已复核关系库与新采集地图按 HLTV 数字身份合并查询，不改写两份只读 SQLite。旧来源版本为 `69d3bb14fb82e70ea452`；新来源版本为 `83b8e177fa2c717a0e7d`。在本地玩法投影成功加载时，查询页与练习页共用 802 张新图的地图白名单；原始 805 张仍可在 `/teammates/library` 审计。合并视图版本包含来源与投影版本，查询必须带该版本，避免切库后混查。投影未加载时查询会回退到完整候选样本，接口以 `playScopeApplied=false` 明示。

| 范围 | 旧复核库 | 原始新候选库 | 原始合并 | 本地玩法范围合并 |
| --- | ---: | ---: | ---: | ---: |
| 可检索 HLTV 数字身份 | 208 | 838 | 997 | 987 |
| 地图 | 27 | 805 | 832 | 829 |
| 队友身份对 | 368 | 3198 | 3542 | 3500 |

两库共有 49 个相同数字身份、24 对相同队友身份，当前没有重复地图。相同身份仅通过 `hltv:<数字>` 关联；昵称只用于搜索，`NiKo`（3741）与 `niko`（10264）始终不同。关系来自单图同队五人，不会把对手连成队友。每张证据保留 HLTV 单图 URL、当时名单、比分、来源批次与指纹。

旧图的 `reviewState=verified` 只表示**该图的同队出场已经复核**；其赛事未全部按当前 A/S 规则验收，标为 `scopeStatus=legacy_scope_unreviewed`。本地玩法范围内的新图仍是 `reviewState=unreviewed`，但 `scopeStatus=as_tier_batch_approved` 表示用户决定批量纳入本地练习；原始候选页继续显示未逐图复核。同一对选手两种证据并存时，不会把候选图提升为已复核图。若将来两个来源包含同一地图，合并器先比对同队五人的数字 ID、地图名及以该队为基准的比分：一致时显示旧已复核证据，并保留第二来源链接、版本和指纹；不一致时返回 `CSLINK_MERGED_SOURCE_CONFLICT`，停止展示该对关系的混合结果。

开发环境的只读接口为 `/api/cslink/merged/{meta,players,relationship}`。`meta` 报告原始/展示地图数、排除图数及 `playScopeApplied`；来源缺一个时，`sourceAvailability` 明示降级，查询仅覆盖已加载来源；两者都缺时返回不可用。结果为空只表示加载的样本中没有证据，不是历史否定。本地范围合并后的 3500 对是**可查询且用于本地练习的关系**，不是已逐图人工复核的 A/S 正式发布关系。旧 27 图练习保留在 `/teammates/practice/legacy`，路径多人对战尚未接入房间。

在仓库根目录运行 `python3 scripts/local-mac.py stop` 和 `python3 scripts/local-mac.py start` 以加载最新后端；测试运行 `python3 scripts/local-mac.py backend-test`。构建器、审计清单及待复核项分别见 [CANDIDATE_LIBRARY.md](CANDIDATE_LIBRARY.md)、[CANDIDATE_AUDIT.md](CANDIDATE_AUDIT.md) 与 [SCOPE.md](SCOPE.md)。
