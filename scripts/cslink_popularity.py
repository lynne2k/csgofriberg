#!/usr/bin/env python3
"""Rank question endpoints by weighted S/A event history (old era vs new era).

score = W_NEW * E(2023-07 起) + W_OLD * E(2023-07 以前)，E = S 级届数 + 0.5 × A 级届数。
按届数而不是图数：2023 以后的库每队每届只录约一张图，图数不可比。
STARS 手动置顶。LEGENDS：2024 起已不在 S/A 出场、但加权排名进前 LEGEND_TOP 的老将，
重新放回搜索和出题（服务端和前端都读这份名单）。
用法：python3 scripts/cslink_popularity.py [--w-new 1.0] [--w-old 0.6]
输出：client/public/cslink/data/popularity.json
"""
import argparse, collections, json, os, sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NEW_LIB = ROOT / '.local-data/cslink/candidate-library-v1/library.sqlite3'
OLD_GRAPH = ROOT / '.local-data/cslink/legacy-relations-v1/graph.json'
PORTRAITS = ROOT / '.local-data/cslink/player-portraits-v1/images'
DATA = ROOT / 'client/public/cslink/data'
A_TIER_WEIGHT = 0.5
LEGEND_TOP = 150
# 区分大小写的花名（NiKo 和 niko 不是一个人）
STARS = ['s1mple', 'device', 'jL', 'Jame', 'donk']

def eras():
    new, old = (collections.defaultdict(lambda: [set(), set()]) for _ in range(2))
    db = sqlite3.connect(NEW_LIB)
    for pid, url, tier in db.execute('select a.player_id, m.event_url, m.tier from appearances a join maps m using(map_id)'):
        new['hltv:' + pid][0 if tier == 'S-Tier' else 1].add(url)
    for m in json.loads(OLD_GRAPH.read_text())['maps']:
        for group in m['groups']:
            for p in group:
                old[p['playerId']][0 if m['tier'] == 'S-Tier' else 1].add(m['eventUrl'])
    return new, old

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--w-new', type=float, default=1.0)
    ap.add_argument('--w-old', type=float, default=0.6)
    args = ap.parse_args()
    new, old = eras()
    events = lambda d: len(d[0]) + A_TIER_WEIGHT * len(d[1])
    players = json.loads((DATA / 'players.json').read_text())
    players = players['players'] if isinstance(players, dict) else players
    active = set(json.loads((DATA / 'active-ids.json').read_text())['ids'])
    portraits = {'hltv:' + f.split('.')[0] for f in os.listdir(PORTRAITS)}
    stars = set(STARS)
    scores = {}
    for row in players:
        pid, name = row[0], row[1]
        weighted = args.w_new * events(new[pid]) + args.w_old * events(old[pid])
        # 整数分：置顶 > 加权届数（保留一位小数）> 生涯图数
        scores[pid] = (10**9 if name in stars else 0) + round(weighted * 10) * 1000 + min(row[3] or 0, 999)
    pool = sorted((p for p in players if p[0] in portraits), key=lambda p: (-scores[p[0]], p[0]))
    legends = [p[0] for p in pool[:LEGEND_TOP] if p[0] not in active]
    out = {'method': 'w_new*E_new + w_old*E_old, E = S events + 0.5*A events; STARS pinned',
           'weights': {'new': args.w_new, 'old': args.w_old, 'aTier': A_TIER_WEIGHT},
           'stars': STARS, 'legends': legends, 'scores': scores}
    (DATA / 'popularity.json').write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')))
    names = {p[0]: p[1] for p in players}
    print(f'wrote {len(scores)} scores; legends restored: {[names[i] for i in legends]}')
    print('top60:', ' '.join(p[1] for p in pool[:60]))

if __name__ == '__main__':
    main()
