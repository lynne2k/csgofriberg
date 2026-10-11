# CS Link 数据清洗与复核

2026-10-10 更新：本地游戏现在按[旧库直接导入](data/cslink/LEGACY_DIRECT_IMPORT.md)复用原始五人分组和 HLTV 比赛链接，无需逐图重抓数字选手编号。下文保留早期严格复核管线的说明；它不再是所有旧关系进入本地游戏的前置条件。

本地清洗工具使用 Python 标准库，将固定版本的历史数据整理成带来源、可复核的比赛记录。输出存放在独立暂存库，不写入网站开发数据库。

## 运行

需要 Python 3.11 或更新版本。在仓库根目录执行：

```bash
python3 scripts/cslink_data.py fetch
python3 scripts/cslink_data.py build
python3 -m unittest discover -s scripts/tests -p 'test_cslink_data.py' -v
```

`fetch` 只下载来源锁定文件中指定的 GitHub 文件，校验文件大小与 SHA-256，不运行上游抓取脚本。已存在且校验通过的文件直接复用；已存在但被修改的文件不会被覆盖。

默认来源目录为 `.local-data/dataset-audit-20260930`，可用 `--source-dir` 指定其他目录。`build` 输出路径为 `.local-data/cslink/versions/<版本号>`，并在终端打印实际路径。

版本号由来源配置、选手身份表、复核记录和清洗程序共同决定。相同输入重新构建时，程序会核对所有产物的文件校验值；结果不同或旧产物被修改会报错，保留已有版本。失败的构建不会成为正式版本目录。

单独核对已有产物：

```bash
python3 scripts/cslink_data.py verify --version-path .local-data/cslink/versions/<版本号>
```

## 输入与身份规则

- [source.lock.json](data/cslink/source.lock.json)：来源仓库、固定提交、文件大小及校验值，以及独立的数据使用授权状态。
- [players.json](data/cslink/players.json)：真实选手的内部编号、外部编号和身份依据。
- [reviews.json](data/cslink/reviews.json)：绑定具体地图与记录指纹的复核结果。
- [audits/2026-10-03.json](data/cslink/audits/2026-10-03.json)：30 张来源页的独立观察记录、显式审核决定和逐槽修正。
- [SCOPE.md](data/cslink/SCOPE.md)：正式赛事实际出场及特殊比赛的纳入规则。

`NiKo` 与 `niko` 分别是 `cs-person-000001` 和 `cs-person-000002`，HLTV 编号分别为 3741 和 10264。两人始终是独立身份，原始昵称也保留大小写。

搜索键只负责找候选。例如搜索 `niko` 可以找到两人，但不能直接将任一出场记录分配给某个人。即使某个昵称目前只有一个候选，也不会自动完成身份映射。只有经过具体地图复核的出场位置才有正式 `player_id`。

## 数据处理规则

1. 按来源链接的 `mapstatsid` 合并原始比赛列表与原始选手明细；这个编号对应单张地图。
2. 重复明细仅在比赛内容一致时去重，仍保留每次收集的原始记录位置。冲突版本全部保留并隔离。
3. 比赛列表中的两队顺序与统计表中的两组顺序分别保存。半场总分只能提供顺序诊断，不能自动确定选手属于哪支队伍。
4. 原始时间按字符串保留，时区标为未知，不自动转成 UTC。网页显示会受时区影响，可能跨日；新批次独立记录网页日期元素的时间戳，不覆盖 CSV 原值。
5. 缺少明细、姓名或关键字段的记录进入结构问题队列。同名或大小写冲突是身份核验提示，不自动判定数据错误。
6. 对已核实的官方地图，先核对十个不同的真实选手身份，再由每队五人生成十组关系。关系合并后保留每张地图的证据。
7. 昵称修正必须绑定本图指纹、原值、具体组和槽位及来源，且十个选手链接编号均通过检查。原始 `names_raw` / `nickname_raw` 不变，修正结果另存 `names_reviewed`，状态为 `corrected_with_evidence`。`NaN` 作为普通字符串处理。

## 产物

| 文件 | 用途 |
| --- | --- |
| `matches.jsonl` | 全部比赛清单、原始队伍与名单、诊断、来源和复核状态 |
| `staging.sqlite3` | 可查询的比赛、选手、出场记录和已核实关系证据 |
| `review_queue.jsonl` | 有结构问题、身份冲突提示、已排除或暂缓的记录；未出现在此文件不代表已核实 |
| `identity_candidates.jsonl` | 按原始昵称汇总的出场次数、样本位置和候选身份；每行不是一个真实选手 |
| `review_samples.json` | 30 张跨年份和异常类型的复核样本，各自保留复核状态 |
| `legacy_reconciliation.json` | 整理版 CSV 与带链接原始数据的对照，包含此前 7 条歧义的处理结果 |
| `players.json` | 当前版本使用的身份表 |
| `teammate_edges.jsonl` | 仅由逐图核实的出场关系生成的选手关系及证据 |
| `report.json` | 覆盖情况、各类问题数量、复核进度和发布限制 |
| `manifest.json` | 输入配置与所有产物的文件校验值 |

`structurally_complete` 仅代表通过结构检查；`review_status=verified` 才表示本图身份及实际出场已经核对。`deferred` 和 `excluded` 不会生成身份出场分配或队友关系。授权状态为 `unconfirmed` 时，所有记录的 `eligible_for_questions` 都为 `false`。`release_ready` 当前固定为 `false`，报告分别列出授权、题目覆盖和多人集成三个验收项；清洗工具不能独自宣告题库可发布。

## 继续复核

先从 `review_samples.json` 选择一张地图，打开其来源，核对双方实际出场名单、地图和赛事。将来源中能确认的选手外部编号记录到身份表；不得按昵称大小写自动选择身份。

参照 [现有复核记录](data/cslink/reviews.json) 添加新条目：

- `map_id` 与 `record_sha256` 必须与当前原始记录一致。
- `decision=verify` 必须有复核原因、证据链接、实际进行的官方比赛确认、两组对应的队伍位置，以及按原始出场顺序填写的两组内部选手编号。
- `group_team_indices=[0,1]` 表示统计组顺序与比赛列表相同；`[1,0]` 表示相反。只能根据本图证据填写。
- `decision=exclude` 与 `decision=defer` 同样需要明确原因、证据和原始指纹。
- 新批次的 `evidence_schema_version=2` 还要求 `observed_groups`：逐槽昵称、HLTV 编号和选手链接必须与出场位置对应；按昵称匹配时严格区分大小写。
- `nickname_corrections` 支持有证据的单图昵称修正；原始缺失明细、关键元数据或冲突版本仍不能强行批准。没有批准的修正也不会自动解除隔离。

可用离线复核编译器生成候选配置。它只处理明确记录的观察和决定，不联网抓取，不因名字相似而自动批准地图：

```bash
python3 scripts/cslink_review.py \
  --batch data/cslink/audits/2026-10-03.json \
  --version-path .local-data/cslink/versions/a5fdf6b003121e3826a9 \
  --output-dir .local-data/cslink/review-candidates/2026-10-03
python3 scripts/cslink_data.py build \
  --players .local-data/cslink/review-candidates/2026-10-03/players.json \
  --reviews .local-data/cslink/review-candidates/2026-10-03/reviews.json
```

批次必须指向实际查看过的旧版本及原始指纹。编译器先验证旧版本文件，再检查逐图名单、比分、地图与选手链接，写出候选配置；遇到不同的既有复核不会覆盖。先查看结果并通过检查，再将候选配置替换到 `data/cslink/players.json` 和 `reviews.json`。同一批次重复编译不会新增编号或复核记录。

修改后重新运行测试和构建。旧复核指纹不匹配、重复身份或未知选手编号都会拒绝导入。已核实的某张地图不会自动授权其他同名出场记录。

## 当前边界

2026-10-03 的版本为 `69d3bb14fb82e70ea452`：登记 208 人，累计确认 27 张地图、270 个出场位置、540 条证据、368 组队友关系；另外 1 张排除、4 张暂缓。28 项管线测试及全量重复构建校验通过。30 张固定样本已逐页核对，但主要选手历史队友覆盖、定向替补/转会样本和 100 道题验收仍待完成。

原始数据、SQLite 和生成结果在 `.local-data` 中被 Git 忽略。代码、来源锁定配置、身份与复核记录可纳入版本控制。原猜选手玩法与正式题库未改动，另设开发模式下的本地共同队友练习。

## 在本地网站查看关系证据

`data/cslink/local-review.json` 指定展示版本。运行 `python3 scripts/local-mac.py start` 后，打开 [队友关系](http://localhost:5173/teammates)。查询库保持只读，与原游戏数据库分离；数据加载失败不会回退到昵称或未经核实的名单。

开发模式下的接口（沿用原项目 PoW 校验）：

| 接口 | 用途 |
| --- | --- |
| `GET /api/cslink/meta` | 当前版本、覆盖数量、部分覆盖标记与示例选手 |
| `GET /api/cslink/players?search=niko` | 返回候选的内部编号、姓名、HLTV 编号及来源个人页；不自动选择身份 |
| `GET /api/cslink/relationship?playerA=cs-person-000001&playerB=cs-person-000004&version=69d3bb14fb82e70ea452&offset=0` | 返回双方已核实的同队单图证据，每页最多 50 条 |

关系接口限定已复核的正式比赛实际出场，并逐条检查两人处于相同统计组和来源 URL 一致。返回单图编号、赛事、原始时间、比分、对应队伍、五人名单、HLTV 链接、复核信息、原始记录位置及指纹。相反参数顺序返回同一组证据；相同身份或非法参数返回 400，未知身份返回 404，客户端版本过期返回 409。未找到证据返回 `not_found_in_reviewed_data`，不推断完整历史关系。

这项查询便于检查证据，并不改变数据授权状态、`eligible_for_questions` 或题库发布验收。具体启动与验证记录见 [LOCAL_DEVELOPMENT.md](LOCAL_DEVELOPMENT.md)。

## 共同队友候选题

`server/src/services/cslinkQuestions.ts` 是候选生成与本地判题的同一实现，运行 `python3 scripts/local-mac.py questions` 可导出带版本的完整候选和 100 道复核样本。所有关系都从当前只读库的已核实边提取，并经关系接口相同的来源与同队检查；由稳定编号计算完整共同邻居，不按昵称推断。筛选的答案数范围是 1–3，不会为了达标裁掉答案。

每个答案绑定“端点一—答案”和“端点二—答案”的来源、地图编号、记录指纹及该侧证据总数；两侧可以来自不同年份、队伍和赛事。样本保留五人名单与原始 CSV 位置。题库版本由数据版本、生成规则和候选内容决定；每次提交都要携带题目编号与题库版本，旧版本返回 409。纯候选和本地练习的发布状态始终为 false。

新增本地接口沿用开发模式限制与原有 PoW：`GET /api/cslink/practice/meta`、`GET /api/cslink/practice/question?pool=bridge|multiple|all`、`GET /api/cslink/practice/question/:questionId?bankVersion=...`、`POST /api/cslink/practice/answer`、`POST /api/cslink/practice/reveal`。固定题目接口按题目编号与题库版本读取题面，旧版本返回 409；不返回答案。两个 POST 接收 `questionId` 与 `bankVersion`，提交答案另传 `playerId`。题面响应不含答案，提交后返回 `accepted` / `not_confirmed` / `endpoint`；未证实不等于历史上错误。该接口不记录分数或多人房间。

## 2026-10-03：补充历史数据的小规模访问试验

实测结果：浏览器可以读取 2023 年下半年、2024、2025、2026 各一张地图的实际出场名单；普通 Python HTTP 请求被 Cloudflare 返回 403。这证明当前浏览器会话下的样本提取可行，尚不能证明独立采集程序可以长期无人值守运行。

| 年份 | 地图样本 | 提取结果 |
| --- | --- | --- |
| 2023 下半年 | [Metizport vs The Witchers，Vertigo](https://www.hltv.org/stats/matches/mapstatsid/168497/metizport-vs-the-witchers) | 两队、十名选手及其 HLTV 编号 |
| 2024 | [Insilio vs Heimo，Ancient](https://www.hltv.org/stats/matches/mapstatsid/190072/insilio-vs-heimo) | 两队、十名选手及其 HLTV 编号 |
| 2025 | [Prestige vs NAVI Junior，Ancient](https://www.hltv.org/stats/matches/mapstatsid/216083/prestige-vs-navi-junior) | 两队、十名选手及其 HLTV 编号 |
| 2026 | [The Huns vs NEXVOID，Inferno](https://www.hltv.org/stats/matches/mapstatsid/240548/the-huns-vs-nexvoid) | 两队、十名选手及其 HLTV 编号 |

每张样本还保留赛事、比分、地图编号、地图 URL、系列赛 URL、网页显示日期与原始毫秒时间戳。四张图共 40 个出场位置，均通过两组各五人、十个不同选手编号及链接编号一致性检查。按统计表表头对应队伍，不按昵称大小写合并选手。

旧脚本的两个表格位置在已检查的样本上仍能命中，但统计列已经变化。例如旧代码把第二列当作击杀数据，现在该列是首杀/首死，且表格含隐藏的经济修正列；直接运行可能产生字段错位。此外，原脚本绑定作者的 GCP 存储桶、凭据路径及 Linux ChromeDriver 路径。本次没有运行它，而是在浏览器已加载页面上，用 `table.totalstats` 与选手链接提取队友图实际需要的字段。

试验记录位于 `.local-data/cslink/hltv-probe-2026-10-03/probe.json`，HTTP 状态与响应另存为 `http-probe.json` / `http-response.html`。浏览器部分是工具返回的 DOM 结构化观察记录，未保存完整原始 HTML：当前内置浏览器不支持内容导出。初次页面的自动安全检查自行完成，没有交互式验证码操作。未使用新增付费服务，未写入现有关系数据库，样本状态为 `probe_only`，授权状态仍为 `unconfirmed`。

页面列表当时显示 2024 年 18,264 张、2025 年 21,855 张、2026 年截至访问时 20,695 张地图。这是站点显示的统计数量，不是已经抓取或核实的数量。2023 年列表显示的 16,646 张是全年数量，不能全部计作旧快照之后的缺口。

赛事范围已调整为逐届确认的 Liquipedia A/S 级正式正赛（排除独立资格赛、取消及未来赛事）；详见 [纳入规则](data/cslink/SCOPE.md)和[赛事量预算](../CS_LINK_AS_TIER_VOLUME_2026-10-03.md)。HLTV `Big events` 仍只作粗筛入口，在浏览器显示：2023-07-14 至 2023-12-31 为 418 张、2024 全年 986 张、2025 全年 1,305 张、2026 截至访问时 880 张，合计 3,589 张候选。对应筛选页为 [2023 下半年](https://www.hltv.org/stats/matches?startDate=2023-07-14&endDate=2023-12-31&matchType=BigEvents)、[2024](https://www.hltv.org/stats/matches?startDate=2024-01-01&endDate=2024-12-31&matchType=BigEvents)、[2025](https://www.hltv.org/stats/matches?startDate=2025-01-01&endDate=2025-12-31&matchType=BigEvents)、[2026](https://www.hltv.org/stats/matches?startDate=2026-01-01&endDate=2026-12-31&matchType=BigEvents)。这个总数既不是 A/S 级准确数量，也不是已采集数量；需要按逐届分级和赛事编号核对，再在允许使用的数据渠道中取得地图记录。

另用 [StarLadder Budapest Major 2025 的一张地图](https://www.hltv.org/stats/matches/mapstatsid/215532/faze-vs-vitality)验证赛事范围内页面：HLTV 赛事编号 8042、地图编号 215532、Vitality 与 FaZe 各五名选手及十个不同的 HLTV 选手编号均可从浏览器页面提取。该样本只记在试验记录中，不进入当前混合赛事关系图。

后续工作量估计（不是实测吞吐量或完成承诺）：实现独立的 100 张地图采集试验、缓存、失败记录和结构校验约半天至一天；验证跨会话恢复及无人值守更新还需要至少 24–72 小时观察。此前按所有比赛计算的 60,814 张和 7 天理想串行时间，不再作为 A/S 级范围的预算；应先完成逐届赛事分类，再测可持续速度和失败率。

## 2026-10-03：2023 年后候选来源与公开证据

5E 与完美世界赛事数据中心均列为 2023 年后 A/S 级正式正赛的候选出场来源。当前只完成少量网页抽查，尚未证明逐届覆盖率、无人值守采集稳定性或批量使用授权。新增批次不以取得 HLTV 单图链接为前置条件；旧批次已核实的 HLTV 证据保留。

| 抽查项 | 结果 |
| --- | --- |
| [5E BLAST 春季小组赛 2024](https://event.5eplay.com/csgo/events/csgo_tt_7552) | 页面标为 S 级，能进入赛程和比赛详情 |
| [5E G2 对 NIP](https://event.5eplay.com/csgo/matches/csgo_mc_2368874) | Vertigo 13:7、Anubis 13:2；点击 Vertigo 后双方各五名选手的统计切换为单图值，页面 URL 仍为系列赛链接 |
| [完美世界 G2 对 NIP](https://data.wanmei.com/csgo/matches/2368874) | 同一比赛也显示逐图统计；另抽查 [2023 年 Vitality 对 EG](https://data.wanmei.com/csgo/matches/2365224)和 [2026 年 NRG 对 Aurora](https://data.wanmei.com/csgo/matches/2398101)可切换单图 |
| 选手身份 | 5E 的 [NiKo 3741](https://event.5eplay.com/csgo/player/csgo_pl_3741)与 [niko 10264](https://event.5eplay.com/csgo/player/csgo_pl_10264)是不同档案；完美世界对应档案同样分开 |

采集记录必须保存实际读取的来源链接、来源版本或原始快照指纹、赛事、日期、对阵、地图序号与名称、比分、同队五名实际出场选手及其稳定编号。公开展示可以选择另一站的比赛链接，但须逐图核对以上关键字段一致，并分别保存 `ingest_source_url` 与 `public_evidence_url`；不能因为两站比赛数字编号相同就把它们当作两份独立证据。当前两站抽查的地图切换未产生独立的单图 URL，因此证据卡还要显示“第几图／地图名／比分”，让读者进入比赛页后能定位到对应地图。

5E 的 S/A/S+ 页面标签只供发现候选，不自动覆盖 [逐届赛事纳入规则](data/cslink/SCOPE.md)。例如 [IEM 北京 2026 封闭预选](https://event.5eplay.com/csgo/events/csgo_tt_9293)在 5E 标为 A 级，但独立资格赛仍被本项目范围排除。面向海外玩家时，本网站应提供英文题目和英文证据摘要，保留原站中文链接供复核；海外可达性、页面稳定性及数据使用许可仍需单独验收。

## 2026-10-03：HLTV 开源工具与访问路径复核

本次只做小批量可行性试验，没有启动第三方仓库的批量采集。Mac 上用普通 HTTP 请求访问 [已知单图](https://www.hltv.org/stats/matches/mapstatsid/215532/faze-vs-vitality)返回 403；同一页面在浏览器完成站点自动验证后可读取。浏览器从 [2023 年 Overpass](https://www.hltv.org/stats/matches/mapstatsid/159569/-)、[2025 年 Overpass](https://www.hltv.org/stats/matches/mapstatsid/215532/faze-vs-vitality)、[2026 年 Cache](https://www.hltv.org/stats/matches/mapstatsid/238674/-)三张样本都提取到两队各五名选手及十个选手链接编号。只核实了这三张图的页面结构；没有测自动批量访问成功率。

| 仓库 | 与本项目的匹配度 | 实际核查 |
| --- | --- | --- |
| [OpenCLI HLTV 浏览器适配器](https://github.com/jackwener/OpenCLI/blob/main/docs/adapters/browser/hltv.md) | 最接近逐图证据需求 | `match-map` 的[实现](https://github.com/jackwener/OpenCLI/blob/main/clis/hltv/utils.js)按 `stats-table totalstats`、队名与选手链接提取地图编号、选手编号、同队分组；三张上述样本的关键选择器均存在。2026-10-03 已做本机安装与单图解析试验，结果见下节。 |
| [gigobyte/HLTV](https://github.com/gigobyte/HLTV) | 有 `getMatchMapStats`，可作字段与旧版结构参考 | 每图会请求统计页和性能页；当前页面仍有 `.st-player a`，但其解析器还读取已不存在的 `.st-kdratio` 和旧 rating 标记，不能直接视为现行完整字段解析器。普通 HTTP 路径在本机仍是 403。 |
| [akimerslys/hltv-async-api](https://github.com/akimerslys/hltv-async-api) | 可参考系列赛发现和选手编号 | 已检查的 `get_match_info` 从系列赛两张总统计表取选手，未构成逐图实际出场证据；仓库文档本身展示 403 情况。 |
| [OldFella/hltv_scraper](https://github.com/OldFella/hltv_scraper) 与 [hltv_api](https://github.com/OldFella/hltv_api) | 有逐图数据模型和现成第三方接口 | 抓取器的旧 `stats-menu-link` 选择器在现行样本为 0。此前用本项目 A/S 队列测其接口 12 个系列赛，只有 2 个返回至少一张完整十人地图，见 `.local-data/cslink/csapi-probe-2026-10-03/report.json`；不能当作完整历史库。 |
| [jparedesDS/hltv-scraper](https://github.com/jparedesDS/hltv-scraper) | 不适合队友图主采集 | 实现从 `stats/teams` 出发，产出选手和战队的汇总 CSV，缺逐图的对阵与十人出场记录。 |

当前优先级：继续保留 5E／完美世界作为新数据的候选采集与公开证据来源；HLTV 的 OpenCLI 浏览器路径已在三张单图上成功，但有重复导航失败，尚不能据此评估持续采集能力。开源抓取代码的许可证不授予 HLTV 数据使用权；[HLTV 条款第 2.2 条](https://www.hltv.org/terms)对网站数据挖掘及抓取有限制，正式使用前另行确认数据使用范围。

## 2026-10-03：OpenCLI 单图实测

- 在 `/tmp/cslink-opencli-probe-20261003` 隔离安装 `@jackwener/opencli@1.8.8`（禁用安装脚本）；`opencli --version` 和 `opencli hltv match-map --help` 正常。`opencli doctor` 显示守护进程可启动，但 Browser Bridge 扩展未连接。
- 对 [2025 年 Vitality–FaZe Overpass 单图](https://www.hltv.org/stats/matches/mapstatsid/215532/faze-vs-vitality)实际执行 `opencli hltv match-map <URL> -f json`，退出码 69，错误为 `BROWSER_CONNECT`。因此**完整命令没有成功读取 HLTV 页面**，也没有测得自动发现或批量采集成功率。
- 为单独检验解析器，用浏览器当前可见页面的赛事信息框与两队统计表做只读片段，调用安装包原版 `readMatchMap` 函数。返回 10 行、两队各五人、10 个不同选手编号、地图编号 `215532`、赛事 `StarLadder Budapest Major 2025`、`Overpass`、Vitality 13:2 FaZe；逐行选手链接均指向 HLTV。六项结构检查全部通过。结构化摘要保存在 `.local-data/cslink/opencli-probe-2026-10-03/offline-parser-result.json`，原页面片段只暂存于 `/tmp`，片段 SHA-256 为 `2328e95451f2d65a26c31ff58bcf72a6045b5e9073ebd04c1c5c89343fde1a90`。这证明当前解析器适配该样本，不证明 Browser Bridge 可用。
- `match-map` 每行的 `url` 是**选手页面**，不是比赛证据页面；正式入库时要额外保存命令输入的单图 URL 为 `ingest_source_url`／`public_evidence_url`，再按赛事、地图与比分过滤。选手身份仍按数字编号区分，不能只按昵称大小写归并。
- 当时浏览器工具禁止访问 `chrome://extensions/`，因此没有代装扩展或绕过限制。用户后来自行安装了 Browser Bridge；完整命令的复测结果见下节。

## 2026-10-03：Browser Bridge 安装后的真实命令复测

用户自行安装扩展后，`opencli doctor` 显示守护进程运行、Browser Bridge `v1.0.24` 已连接，连接测试通过。真实 `opencli hltv match-map <单图 URL> -f json` 在以下三张单图返回了逐人 JSON；每张均通过“10 行、两队各五人、10 个不同数字选手编号、地图编号一致、赛事／日期／地图齐全、选手链接含对应编号、双方比分互相对应”七项校验：

| 单图证据 URL | 解析出的赛事与结果 | 运行模式 |
| --- | --- | --- |
| [2023 Vitality–Evil Geniuses](https://www.hltv.org/stats/matches/mapstatsid/159569/-) | BLAST Premier Fall Groups 2023，Overpass，16:6 | `--window foreground --keep-tab true` |
| [2025 Vitality–FaZe](https://www.hltv.org/stats/matches/mapstatsid/215532/faze-vs-vitality) | StarLadder Budapest Major 2025，Overpass，13:2 | `--window background` 首次运行 |
| [2026 NRG–Aurora](https://www.hltv.org/stats/matches/mapstatsid/238674/aurora-vs-nrg) | StarLadder StarSeries Fall 2026，Cache，7:13 | `--window foreground --keep-tab true` |

每张图的原始命令 JSON、源单图 URL、选手编号与校验结果保存在 `.local-data/cslink/opencli-probe-2026-10-03/`；2025 图的在线命令结果与上一节离线解析结果逐队逐编号一致。**失败也必须计入**：后台模式在首次成功之后，对 2023、2026（含守护进程重启后）和重跑 2025 页面共四次返回 `COMMAND_EXEC: Navigation rejected`。改用前台并保留调试页后，两张新样本成功，但前台模式再次重跑 2026 仍报同样错误；改用持久站点会话重跑 2025 也失败。因此目前没有找到稳定的重复导航方式，不能把前台参数视为修复。日期字段是 HLTV 页面显示值，尚未核定时区；不能直接当标准化时间戳。

结论仅限于“浏览器内单图采集路径可行”，且目前连续运行不可靠。没有测 A/S 赛事发现、连续批量成功率、断点续抓、覆盖率和数据使用许可；在这些验收通过前，不将本次试验数据导入正式题库。正式记录还需保留命令输入的单图 URL 作为比赛证据链接，因为 OpenCLI 返回行内 `url` 指向选手页面。

## 2026-10-03：`Navigation rejected` 定位与批量路线

本机为 Chrome `154.0.8037.93`、OpenCLI `1.8.8`、扩展 `1.0.24`。六次导航失败均约半秒返回；`doctor` 仍显示扩展连接，三张已打开的单图均能解析且通过结构校验。这把问题定位到页面读取之前的 OpenCLI／Chrome 页签导航层，而非十人表格解析层；尚无本机扩展内部堆栈，不能断言是 HLTV 拒绝访问。OpenCLI 的 [issue #2487](https://github.com/jackwener/opencli/issues/2487)描述了扩展在 `chrome.debugger.detach` 后调用 `chrome.tabs.update` 遇到同样错误，[issue #2533](https://github.com/jackwener/opencli/issues/2533)描述了 `doctor` 正常而适配器偶发导航拒绝；[修复 PR #2512](https://github.com/jackwener/opencli/pull/2512)截至本次检查仍未合并。这里是与本机现象高度吻合的上游解释，不是已证明的唯一根因。

本机又对同一 2025 单图做小型对照：后台模式加 `--trace retain-on-failure` 连续两次成功，随后不加 trace 也成功一次；三个输出与首次成功的 10 行逐字段一致。源码中 trace 会在导航前开启网络捕获，扩展在捕获已开启时跳过导航前的调试器断开。trace 与成功相关，但本机未证明它能稳定修复；不能靠增加并发或无限重试把这条路径当作批量能力。诊断记录见 `.local-data/cslink/opencli-probe-2026-10-03/report.json`。

批量采集应拆成以下可验收阶段，且数据源授权先于正式抓取：

1. 直接复用[现有冻结快照](data/cslink/as-tier-snapshot-2026-10-03/README.md)：已有 110 届赛事候选与 6,816 个去重单图编号，其中 6,811 个未见于旧 CSV。按[A/S 赛事纳入规则](data/cslink/SCOPE.md)逐届复核正式正赛，处理 6 张缺编号地图和增量赛事；无需再从 HLTV 全站发现。Liquipedia 的[官方 API 使用条款](https://liquipedia.net/api-terms-of-use)要求缓存、署名和限速：MediaWiki API 免费但有请求间隔限制，LiquipediaDB API 需获批；不能批量请求其普通 HTML 页面。API 赛事层用于发现与分级，不等同于地图实际出场证据。
2. 在允许批量使用的来源中取得足以覆盖每届赛事中各队实际阵容的单图十人统计；首轮无需把全部地图读完，发现替补或换阵时再补图。HLTV [第 2.2 条](https://www.hltv.org/terms)明确禁止数据挖掘／抓取，普通账号和非商用目的不构成批量许可；要把 HLTV 作为主采集源，需取得相应数据授权。5E／完美世界目前只是技术候选，也要分别确认其数据使用范围。不得用代理轮换、验证码自动处理等方式绕过站点限制。
3. 采集器采用单工作队列、按来源限速、持久检查点和 `来源 + 单图编号` 去重。每张图保存赛事与级别依据、来源 URL、抓取时间、原始内容指纹、地图顺序／名称／比分、两队各五人的来源编号与原始昵称；批次失败只对明确的本地瞬时错误有限重试，遇到 403／验证页／权限拒绝则暂停该来源。这个设计是目标规格，尚未在 HLTV 上验收。
4. 进入现有 `cslink_data.py` 隔离与人工复核流程：十人／两队／比分／选手编号不完整就隔离；保留 `ingest_source_url` 与 `public_evidence_url`，以数字编号区分 `NiKo` 与 `niko`，不凭昵称合并。用跨 2023–2026 年的少量样本先验证覆盖与断点续跑，再扩大批次；未经来源权利确认及题库验收不发布关系边。

### 队友图优先的赛事覆盖策略

目标是证明两名选手曾在一张正式地图实际同队出场，不是收集全部地图的统计。首轮先在**每届赛事内**挑选尽量少的系列赛，让每个已出场队伍至少出现在一场被选比赛中；从每场被选比赛选一张有完整十人名单的地图。每队每届一次是初始采样规则，不是“该队整届阵容不变”的结论，也不能凭赛事报名名单推断某人实际上场。

2026-10-03 对冻结赛程缓存做了只读覆盖计算：110 届赛事候选、3,097 场有地图编号的系列赛、6,816 张不同地图。解析已缓存的 `Match` 模板中 `TeamOpponent` 标记后，109 届有地图的赛事共有 1,577 个“赛事 × 原始队伍标记”；在每届赛事内优先选择覆盖两支尚未覆盖队伍的比赛，再补选剩余队伍，得到一个包含 **805 场系列赛、首轮约 805 张地图** 的覆盖方案。另一届 ESL Pro League Season 24 在此快照中尚无地图编号。赛事页标称参赛队伍总数为 1,544，而赛程里出现 1,577 个原始队伍标记，提示队名别名、赛事中替换队伍或统计口径等仍需核对；805 是基于原始标记的队列规模估计，须核实队伍身份和赛事范围后再生成正式采集清单。它比逐图读取少约 88%，不代表完整赛事出场覆盖。

补抓规则：若同队在赛事期间出现替补、教练代打、选手转入转出，或首张地图名单与其他来源的阵容记录冲突，按新的实际五人组合再找有证据的地图；无法判断是否换阵时，标记为覆盖未确认。只有读到并核对过的单图十人名单才能产生正向队友关系；未抽到的关系不能据此判为不存在，也不能据此宣称一道“唯一答案”题目已覆盖整段历史。完整逐图数据库是另一项更大的采集目标，不能拿首轮队友图冒充。

[可重复生成的首轮覆盖队列](data/cslink/as-tier-event-cover-2026-10-03/README.md)和 `scripts/cslink_event_cover.py` 已落地；缓存指纹、冻结地图集合、队伍覆盖和输出校验值均会检查。`scripts/cslink_roster_pilot.py` 用既有三张 OpenCLI 样本离线验证其中两张入选地图的两队各五人、不同数字身份和互反比分；未访问新页面，也未将样本导入正式关系图。2026-10-03 对 5E 和完美世界各一张公开比赛页的普通 HTTP 单次试取均返回 200，但 HTML 分别只有约 1.2 KB 和 1.6 KB 的前端框架，没有逐图名单；因此不能把这两站当成“整场一次普通 HTTP 请求即可取完”的已验证接口。

另对一届赛事做了单次 Liquipedia 官方 MediaWiki API `action=parse` 试取（BLAST Premier Fall Groups 2023，原始回复约 576 KB，本地缓存和校验值位于 `.local-data/cslink/liquipedia-parse-probe/`）。渲染结果包含比赛和 HLTV 地图链接，但该场比赛卡附近没有可确认的实际十人名单；批量 `action=parse` 不能据此替代逐图出场来源。[LiquipediaDB Match 数据模型](https://liquipedia.net/commons/Help:LiquipediaDB/Match)另有 `match2players` 和逐图 `participants` 字段，是否在 CS2 具体记录中完整、以及能否取得其 API 访问权限，仍需单独验证；当前没有把该模型定义当成已拿到的数据。

可申请的候选还有 [GRID Open Access](https://grid.gg/open-access/)：其官方说明列出 CS2 比赛／选手数据并面向独立开发者提供申请入口，但获批范围与本清单的 2023–2026 A/S 赛事重合度未知；先以 24 场试点清单验收后才可估计覆盖。另据 [PandaScore 官方套餐表](https://developers.pandascore.co/docs/plan-reference)，CS 比赛内选手统计属 Historical 套餐；当前没有密钥或该套餐访问权限。这些来源都不能仅凭产品说明直接标记为已取得逐图十人证据。

## 2026-10-03：获告知个人项目许可后的 HLTV 实际采集

用户报告已通过邮件取得 HLTV 管理员允许其为个人非商用游戏自行采集的答复；本仓库没有保存该邮件，也不推断它允许公开再分发原始数据。基于该授权陈述，开始按首轮覆盖队列使用现有 Chrome／OpenCLI 单工作进程读取 HLTV 单图页面。每次请求起点至少间隔 10 秒；只对浏览器导航等瞬时错误有限重试，遇站点拒绝立即停止，连续三张失败也停止。采集文件在 Git 忽略的 `.local-data/cslink/hltv-capture/`，逐次记录来源单图 URL、抓取时间、输出 SHA-256、原计划赛事与系列赛编号；输出中的 `eligible_for_questions` 仍为 `false`，等待赛事范围、身份和实际出场证据复核。

先跑按年份及 A/S 分级分层的 24 场试点：24 张均取得两队各五名选手及独立数字编号，0 张导航或结构失败；其中 22 张新抓，2 张复用已有抓取。随后启动 805 场首轮队列的后台断点续跑；运行状态可随时执行 `python3 scripts/cslink_hltv_status.py`，捕获日志为 `.local-data/cslink/hltv-capture/full-batch.log`。进程结束后 `cslink_hltv_finalize.py` 会自动重建本地候选关系与覆盖报告，结果在 `.local-data/cslink/hltv-stage/`，完成标记在 `.local-data/cslink/hltv-capture/full-batch-final.json`。这不是完整 6,816 图回填；换阵、替补及缺图仍需按证据补抓。

## 2026-10-04：首轮采集完成与候选关系库

原始批次完成 804/805 张；剩余一张的来源编号 `167590` 返回 404。由 [HLTV 系列赛页](https://www.hltv.org/matches/2368425/9-pandas-vs-into-the-breach-cct-2023-online-finals-5)核实首图编号应为 `167591`，已在[独立修正计划](data/cslink/as-tier-event-cover-2026-10-04-corrected/README.md)和账本保留前后编号与来源。修正后 805/805 张有效、0 缺图、0 无效捕获。旧批次及失败 trace 没有覆盖。

另一张早期缓存地图 `160519` 缺少采集时的赛事、系列赛和来源修订字段，已在独立目录重新抓取，不回填原文件。新旧抓取的十人名单相同，但页面显示时间相差六小时；该字段目前只保留为无时区的来源显示值。[审计报告](data/cslink/CANDIDATE_AUDIT.md)记录了差异及人工复核清单。

新[候选队友关系库](data/cslink/CANDIDATE_LIBRARY.md)从来源字段齐全的 805 张地图离线生成只读 SQLite：838 个数字选手身份、3198 对候选队友、16100 条逐图证据；独立复算未发现跨队配对或来源完整性缺口。本地网站的[候选库页面](http://localhost:5173/teammates/library)可以按数字身份查询双方五人和 HLTV 单图链接。109 届入样赛事范围、三组昵称撞名及观测到的换阵仍需复核；所有关系保持 `unreviewed` 和 `eligible_for_questions=false`，不进入正式题库或多人结算。

综合查询现将旧已复核地图与新候选地图按 HLTV 数字 ID 并列展示：旧 208 个身份、27 张地图、368 对关系；新 838 个身份、805 张地图、3198 对关系；交集 49 个身份、24 对关系、0 张地图，合并视图预期 997 个身份、832 张地图、3542 对不同身份关系。重叠关系的证据仍逐图保持原状态，不因另一批次已复核而自动提升。109 届入样赛事均未完成正式范围批准，因此现有审计可直接提升到 A/S 正式题库的新增地图与关系数均为 0；综合查询不是正式判题图。

## 2026-10-04：109 届赛事纳入个人本地玩法

用户明确要求将当前 109 届赛事直接合并用于本地游戏。独立的[本地玩法投影](data/cslink/LOCAL_PLAY_PROJECTION.md)保留候选库原貌，以地图白名单纳入 802/805 张：两张表演赛地图和一张误挂到其他赛事的独立资格赛地图被排除，109 届赛事均仍有正赛地图。纳入图与旧复核样本按 HLTV 数字身份合并，题目、路径以及每一跳的 HLTV 单图证据使用同一投影版本。新图仍标记为未逐图人工复核；这个批量决定不把原始候选记录改为已复核，不代表完整赛程覆盖或公开多人结算验收。
