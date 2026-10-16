#!/usr/bin/env python3
"""给题目两端排热度，决定简单/普通/困难档的人选。

score = 2 × R + F
  R（近期出场）= Σ 2023-07 起每届 S/A 赛事 × 年份权重 × 级别权重
      年份权重：2026=1.0，2025=0.85，2024=0.6，2023=0.35；级别权重：S=1，A=0.5
  F（知名度）= 1.5 × 打过的 Major 届数 + 0.15 × 其他 S/A 届数（A 级再 ×0.5），新老两段数据都算
STARS 手动置顶，保证几位大牌一定进简单档。
LEGENDS：2024 起不再打 S/A、但知名度 F 排进前 LEGEND_TOP 的老将，放回搜索和出题。
按届数而不是图数：2023 以后的库每队每届只录约一张图，图数不可比。
用法：python3 scripts/cslink_popularity.py
输出：client/public/cslink/data/popularity.json
"""
import collections, json, os, sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
NEW_LIB = ROOT / '.local-data/cslink/candidate-library-v1/library.sqlite3'
OLD_GRAPH = ROOT / '.local-data/cslink/legacy-relations-v1/graph.json'
PORTRAITS = ROOT / '.local-data/cslink/player-portraits-v1/images'
DATA = ROOT / 'client/public/cslink/data'
YEAR_WEIGHT = {'2023': 0.35, '2024': 0.6, '2025': 0.85, '2026': 1.0}
TIER_WEIGHT = {'S-Tier': 1.0, 'A-Tier': 0.5}
MAJOR, OTHER, RECENT_X = 1.5, 0.15, 2.0
LEGEND_TOP = 150
# 区分大小写的花名（NiKo 和 niko 不是一个人）
STARS = ['s1mple', 'device', 'NiKo', 'ZywOo', 'donk', 'm0NESY', 'jL', 'Jame']
# 早年 Major 的赛事名里不带 "Major"，按库里的原名补上
OLD_MAJORS = {'DreamHack Winter 2013', 'ESL One: Katowice 2015', 'ESL One: Cologne 2014', 'DreamHack Winter 2014',
              'ESL One: Cologne 2015', 'DreamHack Open Cluj\u2060-\u2060Napoca 2015', 'ESL One: Cologne 2016'}

def fame(name, tier):
    return MAJOR if 'Major' in name or name in OLD_MAJORS else OTHER * TIER_WEIGHT.get(tier, 0.5)

def main():
    recent, famous = collections.Counter(), collections.Counter()
    db = sqlite3.connect(NEW_LIB)
    rows = db.execute('select distinct a.player_id, m.event_url, m.event_name, m.tier, m.event_start_date '
                      'from appearances a join maps m using(map_id)')
    for pid, _url, name, tier, start in rows:
        pid = 'hltv:' + pid
        recent[pid] += YEAR_WEIGHT.get((start or '')[:4], 0.35) * TIER_WEIGHT.get(tier, 0.5)
        famous[pid] += fame(name, tier)
    old = collections.defaultdict(set)
    for m in json.loads(OLD_GRAPH.read_text())['maps']:
        for group in m['groups']:
            for p in group:
                old[p['playerId']].add((m['event'], m['tier']))
    for pid, events in old.items():
        for name, tier in events:
            famous[pid] += fame(name, tier)

    players = json.loads((DATA / 'players.json').read_text())
    players = players['players'] if isinstance(players, dict) else players
    names = {p[0]: p[1] for p in players}
    active = set(json.loads((DATA / 'active-ids.json').read_text())['ids'])
    portraits = {'hltv:' + f.split('.')[0] for f in os.listdir(PORTRAITS)}
    stars = set(STARS)
    scores = {}
    for row in players:
        pid = row[0]
        weighted = RECENT_X * recent[pid] + famous[pid]
        # 整数分：置顶 > 加权分（保留一位小数）> 生涯图数
        scores[pid] = (10**9 if row[1] in stars else 0) + round(weighted * 10) * 1000 + min(row[3] or 0, 999)
    by_fame = sorted((p for p in names if p in portraits), key=lambda p: (-famous[p], p))
    legends = [p for p in by_fame[:LEGEND_TOP] if p not in active]
    pool = sorted((p for p in names if p in portraits and (p in active or p in legends)), key=lambda p: (-scores[p], p))
    out = {'method': '2*R + F; R = recent S/A events x year weight, F = 1.5*Majors + 0.15*other S/A; STARS pinned',
           'weights': {'year': YEAR_WEIGHT, 'tier': TIER_WEIGHT, 'major': MAJOR, 'other': OTHER, 'recentX': RECENT_X},
           'stars': STARS, 'legends': legends, 'scores': scores}
    (DATA / 'popularity.json').write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')))
    print(f'wrote {len(scores)} scores; legends restored ({len(legends)}): {" ".join(names[i] for i in legends)}')
    print('easy top60:', ' '.join(names[p] for p in pool[:60]))
    print('normal 61-150:', ' '.join(names[p] for p in pool[60:150]))

if __name__ == '__main__':
    main()

