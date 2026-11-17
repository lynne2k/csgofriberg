# 05 生产运维：先保状态，再更新

[返回接手入口](../../AGENT_HANDOFF.md)

这份说明记录现状和操作边界，**不是本次上线授权**。本次只做文档和只读检查。后续若用户已明确授权“无人对局时部署”，可按该条件执行，无需再次问同一问题；条件不满足时等待，不中断玩家。

## 当前部署结构

| 项目 | 当前配置 |
| --- | --- |
| 域名 | <https://cslink.cc/cslink/> |
| 主机 | 腾讯云香港，`43.161.196.208`，Ubuntu |
| SSH 用户/本机密钥路径 | `ubuntu` / `~/.ssh/cslink` |
| 服务 | `cslink.service`，单进程 Node |
| 工作目录/入口 | `/srv/cslink/app` / `/usr/local/bin/node server/dist/index.js` |
| 反向代理 | Caddy，公网 80/443 → 本机 3000 |
| 数据库 | PostgreSQL、Redis 均在服务端本机；不要为发版重启它们 |
| 数据与照片 | `/srv/cslink/data/` |
| 状态与配置 | `/srv/cslink/state/`；环境文件 `cslink.env` 内容保密 |
| 版本标记 | `/srv/cslink/state/deployed-commit.txt` |

目前不是 Cloudflare 临时 Tunnel，也不是上游 Docker 双实例发布架构。不要直接把 `deploy/` 的旧方案套到此服务器上。

## 只读检查

以下命令不启动维护、不改房间或成绩：

```sh
ssh -i ~/.ssh/cslink -o BatchMode=yes -o ConnectTimeout=10 ubuntu@43.161.196.208 \
  'cd /srv/cslink/app && node scripts/cslink-control.mjs status'

ssh -i ~/.ssh/cslink -o BatchMode=yes ubuntu@43.161.196.208 \
  'systemctl show cslink.service --property=ActiveState,SubState,MainPID,NRestarts,WorkingDirectory'

curl -fsS https://cslink.cc/api/health
```

管理命令默认连接 `/srv/cslink/state/control.sock`，由服务用户访问，权限 0600；没有公开管理 API。看 `activeMatches` 判断整场是否进行中，局间也包含在内。`rooms`、`connectedPlayers` 和活跃对局不是同一个指标。

正常营业且没有 drain 时，`safeToRestart: false` 是预期行为：只有先暂停新开局、确认无进行中对局并且 Redis 正常，它才会变成 true。**不能看到 false 就认为服务挂了，也不能看到 rooms=0 就跳过最终维护检查。**

不要为查在线数重开 Node inspector、发送调试信号或遍历堆对象；历史做法曾造成事件循环停顿，现在已有管理 socket。

## 状态保护清单

| 状态 | 位置/含义 | 更新时要求 |
| --- | --- | --- |
| 今日题 | `cslink-daily-question.json`：`date/startId/endId/bucket` | 原样保留，尤其 `bucket`；不按新数据版本重算 |
| 每日成绩 | Redis hash，代码 key `cslink:daily:<bucket>` 加 `REDIS_PREFIX` | 不清 Redis，不改前缀，保留持久化；必要时私有备份 |
| 天梯积分 | `cslink-ladder.json` | 不以仓库空文件覆盖，验证文件及条目保留 |
| 身份 | `cslink.env` 中密钥、用户数据库、浏览器 Cookie | 不轮换密钥或重置数据库来解决普通部署问题 |
| 房间 | Node 进程内存 | 不支持重启恢复，必须等整场结束 |

当前生产前缀为 `cslink:`，所以每日实体 key 会形如 `cslink:cslink:daily:<bucket>`；不要因双前缀看着重复就改掉。成绩 TTL 为 3 天是既定实现，不要求永久保存历史排行榜。Redis 不可用时有内存降级，但不能承诺重启保留；重启检查会拒绝这种状态。

每天北京时间零点题目自然切换。如果验证跨零点，按日期分别记录，不能把正常换题误判为数据丢失。若用户明确要求当天换题，需单独处理成绩分区，不能混入普通发布。

## 哪些能重载

| 改动 | 当前机制 |
| --- | --- |
| 手工关系、活跃/热度名单、照片名单、昵称词库 | `reload` 构建并校验后切换；有活跃对局拒绝执行 |
| 源 SQLite 候选/历史整库更换 | 本进程沿用已打开对象，需要计划重启 |
| 服务端代码 | 构建后计划重启，没有完整代码热加载 |
| 普通静态图片/JS | 通常无需 Node 重启，但要构建/同步并考虑浏览器缓存 |
| HTML 内联脚本 | CSP 哈希启动时生成，修改内联内容需配套重启，否则可能被浏览器拦截 |

`reload` 会同时校验今日题仍可用，失败保留旧图；重建图历史实测约 3 秒，所以不在正在计时的对局中运行。旧房间保留创建时的图与筛选快照。客户端导出 JSON 不会由管理命令自动生成，必须提前构建并和后端同步。

## 一次正确发布的顺序

1. 明确本次授权与改动范围；本地测试/构建完成。列出代码、构建产物、数据 JSON、WebP 的发布清单和哈希，准备回滚程序包。
2. 只读检查线上版本、对局、Redis 和当天题。将新文件传到**暂存目录**，不要一边等待玩家一边覆盖正在服务的 HTML 或配置。
3. 在主机 `/srv/cslink/app` 中执行 `node scripts/cslink-control.mjs drain`，再执行 `check-restart`。暂停的是新开整场/匹配，已有整场应继续；不通过则等待或执行 `resume` 撤销维护。
4. 维护窗口内保留今日题文件、天梯文件、对应 Redis 数据及原程序/配置。快照只放私有目录，不打印玩家身份或口令，不把备份加入 Git。
5. 按变更类型切换已校验的文件，执行 `reload` 或重启应用。保留 `.env`、数据库、持久数据路径和 Node 依赖的正确版本。当前不是一键原子部署系统，必须为切换失败准备回退方案。
6. 验证服务、Redis、版本标记、图版本、公开页面/CSP、图片和相关功能；比对**同一日期、同一题目分区、同一身份**的成绩。验收完成后确保 `draining=false`，必要时 `resume`。
7. 只在用户授权范围内提交/推送到 `fork` 的工作分支，记录实际上线 commit；如果部署时源码尚未提交，应在成功提交后校对版本标记，不能留伪造或错误 commit。

`scripts/cslink-safe-restart.sh` 会 drain → 检查空闲与 Redis → `systemctl restart cslink.service`，检查失败则恢复开局。它只是重启门闩，**不负责打包、上传、备份、完整健康轮询或成绩比对**。阅读实现后再用，不要把它当成全部发版流程。

旧私有目录 `/srv/cslink/state/deploy-20261027/` 是那次回滚备份；本地 `.local-data/deploy-20261027/deploy.sh` 含历史日期/初始化背景，不是通用部署命令。旧版首次初始化今日题已经完成，**不要再次把 10 月 27 日的题目写回生产**。

回滚优先恢复程序/资源与必要的配置，保留上线后合法新增的成绩。不要无差别恢复旧 Redis/天梯快照而抹掉玩家新成绩；涉及真实状态恢复时先明确损坏范围。
