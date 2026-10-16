/* 样板共用数据层：读 tools/build-data.mjs 导出的真实选手和队友关系。
   players.json 每项 = [id, 花名, 照片编号或 null, 出场地图数, 旧库身份说明或 null, 最近队伍, 最后一次 S/A 出场年份或 null]
   edges.json   键 = 两个 id 排序后用 | 连接，值 = [赛事名, HLTV 地图页] */
(function () {
  var PLAYERS = {}, LIST = [], EDGES = {};
  // 搜索只放 2024 起还在 S/A 出场的选手；其他人仍留在数据里，判定关系时照常当中间人
  var ACTIVE_FROM_YEAR = 2024;
  // 搜索归一化：不分大小写，形近字符视为同一个（1/l/i、0/o、4/a、3/e、5/s、7/t）
  function norm(s) {
    return String(s).toLowerCase()
      .replace(/[1l!|]/g, "i").replace(/0/g, "o").replace(/[4@]/g, "a")
      .replace(/3/g, "e").replace(/[5$]/g, "s").replace(/7/g, "t").replace(/[\s_.-]/g, "");
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function tagOf(p) {
    if (p.ctx) return p.ctx.split(" · ")[0];       // 旧库同名选手：用那届比赛区分
    return p.maps + " 张图";
  }
  var ready = Promise.all([fetch("data/players.json").then(function (r) { return r.json(); }),
    fetch("data/edges.json").then(function (r) { return r.json(); }),
    // 老将名单：不再活跃但知名度够的人，照样能搜到；文件缺失时不影响其他数据
    fetch("data/popularity.json").then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; })]).then(function (res) {
    var legend = {};
    (res[2].legends || []).forEach(function (id) { legend[id] = true; });
    res[0].forEach(function (r) {
      var p = { id: r[0], name: r[1], img: r[2] ? "portraits/" + r[2] + ".png" : null, maps: r[3], ctx: r[4], team: r[5] || "", key: norm(r[1]),
        active: r.length < 7 || (r[6] != null && r[6] >= ACTIVE_FROM_YEAR) || !!legend[r[0]] };   // 旧格式没有年份时不过滤
      p.tag = tagOf(p);
      PLAYERS[p.id] = p; LIST.push(p);
    });
    EDGES = res[1];
    /* 旧库里借到同一张定妆照的身份就是同一个人：搜索只出一张牌（代表 = 出场最多的那条），
       判定时这张牌的所有身份都算。底层数据不合并，只在样板这一层合。 */
    var byPhoto = {};
    LIST.forEach(function (p) { if (p.img) (byPhoto[p.img] = byPhoto[p.img] || []).push(p); });
    Object.keys(byPhoto).forEach(function (k) {
      var g = byPhoto[k].sort(function (a, b) { return (a.ctx ? 1 : 0) - (b.ctx ? 1 : 0) || b.maps - a.maps; });
      var head = g[0]; head.alias = g.map(function (p) { return p.id; });
      head.maps = g.reduce(function (n, p) { return n + p.maps; }, 0);
      head.active = g.some(function (p) { return p.active; });   // 同一张照片的任一身份还活跃就算
      g.slice(1).forEach(function (p) { p.hidden = true; p.rep = head.id; });
    });
    LIST = LIST.filter(function (p) { return !p.hidden; });
    api.players = PLAYERS;
  });
  /* 联想：花名开头匹配排前面，其次包含；同档按出场地图数（越常见越靠前） */
  function search(q, taken, limit) {
    var s = norm(q.trim()), hits = [];
    if (!s) return { list: [], total: 0 };
    for (var i = 0; i < LIST.length; i++) {
      var p = LIST[i];
      if (taken[p.id] || !p.img || !p.active) continue;   // 只放有定妆照、且 2024 起还在 S/A 出场的选手
      var at = p.key.indexOf(s);
      if (at < 0) continue;
      hits.push({ id: p.id, rank: at === 0 ? (p.key === s ? 3 : 2) : 1, maps: p.maps });
    }
    hits.sort(function (a, b) { return b.rank - a.rank || b.maps - a.maps; });
    return { list: hits.slice(0, limit).map(function (h) { return h.id; }), total: hits.length };
  }
  function edge(a, b) {
    var A = PLAYERS[a] && PLAYERS[a].alias || [a], B = PLAYERS[b] && PLAYERS[b].alias || [b];
    for (var i = 0; i < A.length; i++) for (var j = 0; j < B.length; j++) {
      var x = A[i], y = B[j], e = EDGES[x < y ? x + "|" + y : y + "|" + x];
      if (e) return { event: e[0], href: e[1] };
    }
    return null;
  }
  function matches(id, q) { var s = norm(q.trim()); return !!s && PLAYERS[id].key.indexOf(s) >= 0; }
  var api = window.CSDATA = { ready: ready, players: PLAYERS, search: search, edge: edge, matches: matches, norm: norm, esc: esc };
})();

