// 从本地选手库导出游戏用的 players.json / edges.json（只读源数据）
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
const ROOT = path.resolve(process.env.CSLINK_SOURCE_ROOT || path.resolve(import.meta.dirname, '../.local-data/cslink'));
const OUT = process.env.CSLINK_DATA_OUT ? path.resolve(process.env.CSLINK_DATA_OUT) : path.resolve(import.meta.dirname, '../client/public/cslink/data');
const PORTRAITS = path.join(ROOT, 'player-portraits-v1/images');
const have = new Set(fs.readdirSync(PORTRAITS).map(f => f.replace(/\.\w+$/, '')));
const players = new Map();   // id -> { id, name, hltv, ctx, maps }
const edges = new Map();     // "a|b" -> [event, url, date]
const nb = new Map();
// 每个 hltv 身份在 2023-07 后 A/S 库里最后一次出场的日期；用来算「2024 起还在 S/A 出场」
const asLast = new Map();
const ACTIVE_FROM_YEAR = 2024;
const addPlayer = (id, name, hltv, ctx, team, date) => {
  let p = players.get(id);
  if (!p) players.set(id, p = { id, name, hltv, ctx, maps: 0, team: null, teamAt: "" });
  p.maps++;
  if (team && date >= p.teamAt) { p.team = team; p.teamAt = date; }   // 最近一次出场的队伍
};
const addEdge = (a, b, event, url, date) => {
  const k = a < b ? a + '|' + b : b + '|' + a;
  const prev = edges.get(k);
  if (!prev || date > prev[2]) edges.set(k, [event, url, date]);   // 留最近一场，玩家更容易认出来
  for (const [x, y] of [[a, b], [b, a]]) { if (!nb.has(x)) nb.set(x, new Set()); nb.get(x).add(y); }
};
// 2023 年 7 月前：旧库；再并入手动补录（A/S 库外、玩家点名需要的阵容，格式同旧库）
const legacy = JSON.parse(fs.readFileSync(path.join(ROOT, 'legacy-relations-v1/graph.json'), 'utf8'));
const MANUAL = process.env.CSLINK_MANUAL_RELATIONS_FILE || path.resolve(import.meta.dirname, '../data/cslink/manual-relations.json');
if (fs.existsSync(MANUAL)) {
  const manual = JSON.parse(fs.readFileSync(MANUAL, 'utf8'));
  const known = new Set(legacy.players.map(p => p.id));
  legacy.players.push(...manual.players.filter(p => !known.has(p.id)));
  legacy.maps.push(...manual.maps);
}
const meta = new Map(legacy.players.map(p => [p.id, p]));
for (const m of legacy.maps) for (const [gi, g] of m.groups.entries()) {
  for (const x of g) { const p = meta.get(x.playerId); addPlayer(x.playerId, x.nickname, p?.hltvId ?? null, p?.identityContext ?? null, m.opponents?.[gi], m.dateRaw); }
  for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++)
    addEdge(g[i].playerId, g[j].playerId, m.event, m.sourceUrl, m.dateRaw);
}
// 2023 年 7 月后：两份 A/S 级候选库，只取游戏投影里批准的地图
for (const [lib, play] of [['candidate-library-v1', 'as-tier-local-play-v1'],
  ['historical-as-batch-v1/current/library', 'historical-as-batch-v1/current/play']]) {
  const ok = new Set(JSON.parse(fs.readFileSync(path.join(ROOT, play, 'manifest.json'), 'utf8')).included_map_ids);
  const db = new DatabaseSync(path.join(ROOT, lib, 'library.sqlite3'), { readOnly: true });
  const rows = db.prepare('select a.map_id, a.player_id, a.team_name, a.nickname, m.event_name, m.source_url, m.date_time_as_displayed d from appearances a join maps m using(map_id)').all();
  const teams = new Map();
  for (const r of rows) {
    if (!ok.has(r.map_id)) continue;
    const id = 'hltv:' + r.player_id;
    addPlayer(id, r.nickname, String(r.player_id), null, r.team_name, r.d);
    if (String(r.d ?? '') > (asLast.get(id) ?? '')) asLast.set(id, String(r.d));
    const k = r.map_id + '|' + r.team_name;
    if (!teams.has(k)) teams.set(k, { r, ids: [] });
    teams.get(k).ids.push(id);
  }
  for (const { r, ids } of teams.values())
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) addEdge(ids[i], ids[j], r.event_name, r.source_url, r.d);
  db.close();
}
// 人工复核过的地图（服务端 cslink_review 来源）：cs-person 身份按 external_ids.hltv 换成 hltv:编号
{
  const cfg = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '../data/cslink/local-review.json'), 'utf8'));
  const file = path.join(ROOT, 'versions', cfg.version, 'staging.sqlite3');
  if (fs.existsSync(file)) {
    const db = new DatabaseSync(file, { readOnly: true });
    const hltvOf = new Map(db.prepare('select player_id, record_json from players').all()
      .map(r => [r.player_id, JSON.parse(r.record_json).external_ids?.hltv]).filter(([, h]) => h));
    const maps = db.prepare("select map_id, source_url, date_raw, record_json from maps where review_status='verified'").all();
    const app = db.prepare('select group_no, player_id, nickname_raw from appearances where map_id=? order by group_no, slot');
    for (const m of maps) {
      const meta = JSON.parse(m.record_json).metadata ?? {};
      const groups = new Map();
      for (const a of app.all(m.map_id)) {
        const h = hltvOf.get(a.player_id);
        if (!h) continue;
        const id = 'hltv:' + h;
        addPlayer(id, a.nickname_raw, h, null, meta.teams_display?.[a.group_no - 1], m.date_raw);
        if (!groups.has(a.group_no)) groups.set(a.group_no, []);
        groups.get(a.group_no).push(id);
      }
      for (const ids of groups.values())
        for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++)
          addEdge(ids[i], ids[j], meta.event_raw ?? 'HLTV', m.source_url, m.date_raw ?? '');
    }
    db.close();
  }
}
// 旧库无编号身份：同名 + 至少 2 个共同队友且明显领先，才借用那位 HLTV 选手的照片（身份和关系不动）
const byNick = new Map();
for (const p of players.values()) if (p.hltv) { if (!byNick.has(p.name)) byNick.set(p.name, []); byNick.get(p.name).push(p); }
let borrowed = 0;
for (const p of players.values()) {
  if (p.hltv) { p.img = have.has(p.hltv) ? p.hltv : null; continue; }
  const mine = nb.get(p.id) ?? new Set();
  const sc = (byNick.get(p.name) ?? []).map(q => [q, [...(nb.get(q.id) ?? [])].filter(x => mine.has(x)).length]).sort((a, b) => b[1] - a[1]);
  p.img = null;
  if (sc.length && sc[0][1] >= 2 && (sc.length === 1 || sc[1][1] < sc[0][1]) && have.has(sc[0][0].hltv)) { p.img = sc[0][0].hltv; p.photoFrom = sc[0][0].id; borrowed++; }
}
fs.mkdirSync(OUT, { recursive: true });
const activeYear = id => { const m = /^(\d{4})/.exec(asLast.get(id) ?? ''); return m ? Number(m[1]) : null; };
const list = [...players.values()].sort((a, b) => b.maps - a.maps)
  // 紧凑数组：id, 花名, 照片编号, 地图数, 旧库身份说明, 最近队伍, 最后一次 S/A 出场年份（2023-07 后，没有则 null）
  .map(p => [p.id, p.name, p.img, p.maps, p.ctx, p.team, activeYear(p.id)]);
const write = (name, value) => { const dest = path.join(OUT, name); fs.writeFileSync(dest + '.tmp', JSON.stringify(value)); fs.renameSync(dest + '.tmp', dest); };
write('players.json', list);
write('edges.json', Object.fromEntries([...edges].map(([k, v]) => [k, [v[0], v[1]]])));
// 出题/搜索可用名单：2024 起还在 S/A 出场的 hltv 身份。只是过滤名单，源库和关系都不删
const activeIds = list.filter(p => p[6] != null && p[6] >= ACTIVE_FROM_YEAR).map(p => p[0]).sort();
write('active-ids.json', { fromYear: ACTIVE_FROM_YEAR, ids: activeIds });
const withImg = list.filter(p => p[2]).length;
const searchable = list.filter(p => p[2] && p[6] >= ACTIVE_FROM_YEAR).length;
console.log(JSON.stringify({ players: list.length, withPhoto: withImg, borrowedPhoto: borrowed, edges: edges.size,
  active: activeIds.length, withPhotoActive: searchable, withPhotoInactive: withImg - searchable }));
