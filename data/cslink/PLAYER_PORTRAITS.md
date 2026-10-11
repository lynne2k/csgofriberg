# HLTV 选手定妆照

2026-10-10：按用户授权，以当前游戏关系图的 1,620 个不同 HLTV 编号开始批量下载。855 条缺少编号的旧库身份不自动配图，避免把同名选手混在一起。照片只写入本地素材目录，没有修改网页或多人房间。

## 当前任务

- 输入清单：`.local-data/cslink/portrait-pilot-2026-10-10/photo-candidates.json`。
- 输出目录：`.local-data/cslink/player-portraits-v1/`。
- 图片：`images/<HLTV 编号>.png`（根据真实格式也可能为 jpg/webp）。
- 每人记录：`records/<HLTV 编号>.json`，含来源页面、原图 URL、页面昵称、原始昵称、尺寸、校验值和耗时。
- 进度：`status.json` 和 `PROGRESS.md`；逐次结果：`attempts.jsonl`。
- 后台进程：`process.json`；日志：`.local-logs/cslink-portraits-batch.log`。

## 运行和恢复

```sh
python3 scripts/cslink_portraits.py --status
python3 scripts/cslink_portraits.py
```

第二条命令用于前台运行或中断后恢复。文件锁阻止同一队列重复运行，输入清单指纹绑定输出目录。成功下载且校验值一致的图片，以及已识别为没有定妆照的页面会跳过；其他记录下次重跑时会重试。已有 NiKo #3741 样本直接复用，niko #10264 使用独立文件。

如要停止本任务，读取 `process.json` 的 PID，确认进程命令为本脚本后发送 SIGTERM；当前操作结束后会保存进度。任务运行时有一个绑定该进程的 `caffeinate -i`，只在该进程存活期间抑制 Mac 空闲休眠。Chrome 与 OpenCLI 扩展必须保持运行。

## 访问与验证

OpenCLI 使用独立后台浏览器会话顺序访问选手页，最短访问间隔 8 秒。图片地址从页面资料区读取，再下载该公开 HLTV CDN 文件；不通过昵称拼接图片 URL。下载后完整检查图片格式、尺寸与校验值。

自动安全验证页先等待最多 25 秒，再退避并正常重试一次。若仍未加载，暂停全部请求 5 分钟后重试同一选手，最多进行两轮冷却恢复；`status.json` 会记录 `nextRetryAt`。仍未恢复时保留页面、写入 `needs_browser_verification` 并停止继续发请求，供后续检查实际验证控件；脚本不把验证页标成“没有照片”，也不声称已完成交互式验证码。其他连续三次失败会保存进度并停止，避免异常状态下继续刷请求。

验证：9 项离线测试通过，覆盖冷却后恢复、重试次数上限和无照片不反复重试；实际首批已下载 HooXi、bottle 等真实图片，PNG 均能解码。按 8 秒访问间隔，1,620 人理想需约 3.6 小时，验证等待、页面变慢或失败重试会增加用时；并非每个选手都有可用定妆照。
