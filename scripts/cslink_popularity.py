#!/usr/bin/env python3
"""Rank question endpoints by recent prominence instead of career map count.

Score = S-tier events played since 2024 (main), then A/S events since 2024, then career maps.
The 2023+ library samples about one map per team per event, so event count is the honest
activity signal. STARS are hand-picked big names who now play fewer events; they are
pinned to the top. Output: client/public/cslink/data/popularity.json
"""
import collections, json, sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LIB = ROOT / '.local-data/cslink/candidate-library-v1/library.sqlite3'
DATA = ROOT / 'client/public/cslink/data'
SINCE = '2024-01-01'
# Exact, case-sensitive display names (NiKo and niko are different players).
STARS = ['s1mple', 'device', 'jL', 'Jame']

def main():
    db = sqlite3.connect(LIB)
    s_events, all_events = collections.defaultdict(set), collections.defaultdict(set)
    for pid, url, tier, day in db.execute(
            "select a.player_id, m.event_url, m.tier, coalesce(m.event_start_date, substr(m.date_time_as_displayed,1,10)) "
            "from appearances a join maps m using(map_id)"):
        if day and day >= SINCE:
            all_events[pid].add(url)
            if tier == 'S-Tier':
                s_events[pid].add(url)
    players = json.loads((DATA / 'players.json').read_text())
    players = players['players'] if isinstance(players, dict) else players
    stars = set(STARS)
    scores = {}
    for row in players:
        pid, name, maps = row[0], row[1], row[3] or 0
        hltv = pid.split(':', 1)[1] if pid.startswith('hltv:') else None
        s, a = len(s_events.get(hltv, ())), len(all_events.get(hltv, ()))
        # Integer score keeps ordering exact: stars > S events > A/S events > career maps.
        scores[pid] = (1 if name in stars else 0) * 10**9 + s * 10**6 + a * 10**3 + min(maps, 999)
    out = {'method': 'S-tier events since 2024, then A/S events, then career maps; STARS pinned',
           'since': SINCE, 'stars': STARS, 'scores': scores}
    (DATA / 'popularity.json').write_text(json.dumps(out, ensure_ascii=False, separators=(',', ':')))
    print(f'wrote {len(scores)} scores')

if __name__ == '__main__':
    main()
