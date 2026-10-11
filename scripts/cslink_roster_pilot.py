#!/usr/bin/env python3
"""Validate existing OpenCLI sample files against the event-cover queue offline.

This is a technical sample only. It does not download pages or approve rights,
rosters, edges, or questions for publication.
"""

import argparse
from collections import defaultdict
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[1]
PLAN = ROOT / 'data/cslink/as-tier-event-cover-2026-10-03/selected-series.jsonl'
OUTPUT = ROOT / '.local-data/cslink/as-tier-event-cover-pilot'


def validate_capture(data, selected_map_id):
    source_url = data.get('source_url')
    url = urlsplit(source_url or '')
    match = re.fullmatch(r'/stats/matches/mapstatsid/(\d+)/[^/]+', url.path)
    if url.scheme != 'https' or url.netloc != 'www.hltv.org' or not match or url.query or url.fragment:
        raise ValueError('Invalid HLTV map URL')
    map_id = int(match.group(1))
    if map_id != selected_map_id:
        raise ValueError('Capture map ID differs from selected map ID')
    rows = data.get('rows')
    if not isinstance(rows, list) or len(rows) != 10:
        raise ValueError('Expected exactly ten player rows')
    teams = defaultdict(list)
    seen_ids = set()
    for row in rows:
        if row.get('matchStatsId') != str(map_id):
            raise ValueError('Player row map ID mismatch')
        player_id = row.get('playerId')
        if not isinstance(player_id, str) or not re.fullmatch(r'[1-9][0-9]*', player_id):
            raise ValueError('Missing stable numeric player ID')
        if player_id in seen_ids:
            raise ValueError('Duplicate player ID within map')
        seen_ids.add(player_id)
        if not isinstance(row.get('playerName'), str) or not row['playerName'].strip():
            raise ValueError('Missing displayed player name')
        player_url = urlsplit(row.get('url') or '')
        if player_url.scheme != 'https' or player_url.netloc != 'www.hltv.org' or not re.match(
                rf'^/stats/players/{player_id}/[^/]+$', player_url.path):
            raise ValueError('Player URL does not bind numeric ID')
        team = row.get('team')
        if not isinstance(team, str) or not team.strip():
            raise ValueError('Missing team name')
        details = row.get('details')
        if not isinstance(details, dict):
            raise ValueError('Missing map details')
        for key in ('event', 'dateTime', 'map', 'opponent', 'teamScore', 'opponentScore'):
            if details.get(key) is None:
                raise ValueError(f'Missing map detail: {key}')
        teams[team].append(row)
    if len(teams) != 2 or sorted(map(len, teams.values())) != [5, 5]:
        raise ValueError('Expected two teams of five')
    shared = ('event', 'dateTime', 'map')
    if any(len({row['details'][key] for row in rows}) != 1 for key in shared):
        raise ValueError('Event/date/map differs across player rows')
    names = list(teams)
    scores = {}
    for team in names:
        values = {(row['details']['opponent'], row['details']['teamScore'],
                   row['details']['opponentScore']) for row in teams[team]}
        if len(values) != 1:
            raise ValueError('Team score or opponent differs among its players')
        opponent, own_score, other_score = next(iter(values))
        if opponent not in teams or opponent == team or not all(type(x) is int and x >= 0
                                                                 for x in (own_score, other_score)):
            raise ValueError('Invalid opponent or score')
        scores[team] = (own_score, other_score)
    if scores[names[0]] != tuple(reversed(scores[names[1]])):
        raise ValueError('Team scores are not reciprocal')
    return {'mapstatsid': map_id, 'source_url': source_url,
            'event_as_displayed': rows[0]['details']['event'],
            'date_time_as_displayed': rows[0]['details']['dateTime'],
            'map_as_displayed': rows[0]['details']['map'],
            'teams': [{'name_as_displayed': team, 'score': scores[team][0],
                       'players': [{'source_player_id': row['playerId'],
                                    'nickname_as_displayed': row['playerName'],
                                    'source_player_url': row['url']} for row in teams[team]]}
                      for team in names],
            'roster_status': 'technical_sample_unreviewed',
            'rights_status': 'unconfirmed', 'eligible_for_questions': False}


def run(plan_path, capture_paths, output_dir):
    plan = {row['selected_mapstatsid']: row for row in
            (json.loads(line) for line in plan_path.read_text().splitlines() if line.strip())}
    if len(plan) != sum(bool(line.strip()) for line in plan_path.read_text().splitlines()):
        raise ValueError('Duplicate selected map IDs in plan')
    validated = []
    skipped = []
    for path in capture_paths:
        raw = path.read_bytes()
        data = json.loads(raw)
        url = data.get('source_url', '')
        match = re.search(r'/mapstatsid/(\d+)/', url)
        map_id = int(match.group(1)) if match else None
        if map_id not in plan:
            skipped.append({'capture_file': str(path), 'mapstatsid': map_id,
                            'reason': 'not_selected_in_first_cover'})
            continue
        row = validate_capture(data, map_id)
        row['event_url'] = plan[map_id]['event_url']
        row['hltv_series_id'] = plan[map_id]['hltv_series_id']
        row['capture_sha256'] = hashlib.sha256(raw).hexdigest()
        row['capture_file'] = str(path)
        validated.append(row)
    if len({row['mapstatsid'] for row in validated}) != len(validated):
        raise ValueError('Duplicate capture for a selected map')
    validated.sort(key=lambda row: row['mapstatsid'])
    report = {'schema_version': 1, 'selected_maps_in_plan': len(plan),
              'capture_files': len(capture_paths), 'validated_selected_samples': len(validated),
              'skipped_not_selected': len(skipped),
              'remaining_selected_maps_without_capture': len(plan) - len(validated),
              'rights_status': 'unconfirmed', 'question_eligibility': False,
              'note': 'Offline technical pilot from pre-existing files; no new requests'}
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / 'validated-samples.jsonl').write_text(''.join(
        json.dumps(row, ensure_ascii=False, sort_keys=True) + '\n' for row in validated))
    (output_dir / 'skipped.jsonl').write_text(''.join(
        json.dumps(row, ensure_ascii=False, sort_keys=True) + '\n' for row in skipped))
    (output_dir / 'report.json').write_text(json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2) + '\n')
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path, default=PLAN)
    parser.add_argument('--output', type=Path, default=OUTPUT)
    parser.add_argument('captures', nargs='+', type=Path)
    args = parser.parse_args()
    print(json.dumps(run(args.plan, args.captures, args.output), ensure_ascii=False, indent=2))
