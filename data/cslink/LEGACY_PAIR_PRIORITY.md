# 旧图补抓优先级（离线）

运行 `python3 scripts/cslink_legacy_pair_priority.py --top 50`，会在
`.local-data/cslink/legacy-pair-priority-v1/versions/<版本>/` 写出不可变结果；
`top-50-collector-plan.jsonl` 可直接传给 `cslink_hltv_collect.py --plan`。
`manifest.json` 记录输入、脚本和所有输出文件的 SHA-256 校验值。

输入限于冻结的 2023-07-13 前 A/S 赛事精确地图队列、旧 staging 库、
当前已入选的 802 张新图和 473 张旧图，以及旧库 27 张人工复核地图。
不使用 capture 目录中尚未通过验收的文件作为身份锚点。旧库昵称只作
补抓排序假设：采用 Unicode NFC 规范化，严格保留大小写；同名对应多个
HLTV 数字编号时保持歧义。同一赛事中，完整且完全相同的五个昵称如在已入选
地图出现过，会优先采用该地图的五人编号组合；跨赛事仅使用单昵称的唯一候选，
仍不能证明旧地图实际出场。

每张未抓地图先核对旧库两组各五个昵称、Liquipedia 的唯一 Match/Map.stats
引用、赛事源页面修订、单图日期、地图名和双方比分。已入选地图、既知抓取失败
和源数据冲突会排除。排序依据是若昵称假设成立，该地图可能增加多少尚无证据的
队友关系；每选一张图就从剩余地图的预估收益中扣除重复关系。两个五人组都已在
同赛事锚定且不增加关系的地图另存为低优先级清单。

主要结果：`priority.jsonl` 为排序与每组身份依据；
`partial-identity.jsonl` 保留未知或重名昵称；
`liquipedia-rejections.jsonl` 和 `conflicts.jsonl` 保留隔离原因；
`deferred-double-anchored.jsonl` 是已被同赛事五人锚点覆盖的旧图。
所有预估关系均为**待验证候选**，此脚本不修改当前可玩图、网站或旧数据库。
