#!/usr/bin/env python3
"""Stage captured HLTV map rosters into review-only teammate evidence offline."""

import argparse
from collections import defaultdict
import hashlib
from itertools import combinations
import json
from pathlib import Path

from cslink_roster_pilot import validate_capture


ROOT = Path(__file__).resolve().parents[1]
PLAN = ROOT / 'data/cslink/as-tier-event-cover-2026-10-03/selected-series.jsonl'
CAPTURES = ROOT / '.local-data/cslink/hltv-capture'
OUTPUT = ROOT / '.local-data/cslink/hltv-stage'


def jsonl(rows):
    return ''.join(json.dumps(row, ensure_ascii=False, sort_keys=True) + '\n' for row in rows)


def stage(plan_path, captures_dir, output_dir):
    plan_raw = plan_path.read_bytes()
    plan = [json.loads(line) for line in plan_raw.splitlines() if line.strip()]
    if len({row['selected_mapstatsid'] for row in plan}) != len(plan):
        raise ValueError('Duplicate map IDs in selection plan')
    players = defaultdict(lambda: {'nicknames': set(), 'player_urls': set(), 'map_ids': set()})
    edges = defaultdict(list)
    event_teams = defaultdict(lambda: defaultdict(list))
    evidence = []
    missing = []
    invalid = []
    for row in plan:
        map_id = row['selected_mapstatsid']
        capture_path = captures_dir / f'{map_id}.json'
        if not capture_path.is_file():
            missing.append({'mapstatsid': map_id, 'event_url': row['event_url'],
                            'hltv_series_id': row['hltv_series_id'],
                            'source_url': row['hltv_map_url']})
            continue
        raw = capture_path.read_bytes()
        try:
            capture = json.loads(raw)
            if (capture.get('event_url') not in (None, row['event_url']) or
                    capture.get('hltv_series_id_from_liquipedia') not in (None, row['hltv_series_id'])):
                raise ValueError('Capture provenance disagrees with plan')
            if row.get('hltv_map_url') and capture.get('source_url') != row['hltv_map_url']:
                raise ValueError('Capture source URL disagrees with plan')
            if (row.get('source_revision_sha256') and
                    capture.get('source_revision_sha256') not in (None, row['source_revision_sha256'])):
                raise ValueError('Capture source revision disagrees with plan')
            verified = validate_capture(capture, map_id)
        except (ValueError, TypeError, json.JSONDecodeError) as exc:
            invalid.append({'mapstatsid': map_id, 'path': str(capture_path),
                            'reason': str(exc)[:350]})
            continue
        teams = verified['teams']
        for team in teams:
            ids = tuple(sorted((p['source_player_id'] for p in team['players']), key=int))
            roster_key = '|'.join(ids)
            event_teams[row['event_url']][team['name_as_displayed']].append(
                {'mapstatsid': map_id, 'roster_player_ids': list(ids),
                 'roster_fingerprint': hashlib.sha256(roster_key.encode()).hexdigest()})
            for person in team['players']:
                player = players[person['source_player_id']]
                player['nicknames'].add(person['nickname_as_displayed'])
                player['player_urls'].add(person['source_player_url'])
                player['map_ids'].add(map_id)
            for a, b in combinations(ids, 2):
                edges[(a, b)].append({'mapstatsid': map_id, 'source_url': verified['source_url'],
                                      'event_url': row['event_url'], 'event_name_candidate': row['event_name'],
                                      'team_name_as_displayed': team['name_as_displayed'],
                                      'date_time_as_displayed': verified['date_time_as_displayed'],
                                      'map_name_as_displayed': verified['map_as_displayed']})
        evidence.append({'mapstatsid': map_id, 'hltv_series_id_candidate': row['hltv_series_id'],
                         'source_url': verified['source_url'],
                         'source_sha256': hashlib.sha256(raw).hexdigest(),
                         'event_url': row['event_url'], 'event_name_candidate': row['event_name'],
                         'event_as_displayed': verified['event_as_displayed'],
                         'date_time_as_displayed': verified['date_time_as_displayed'],
                         'map_as_displayed': verified['map_as_displayed'],
                         'teams': teams, 'review_state': 'unreviewed',
                         'eligible_for_questions': False})
    players_rows = [
        {'hltv_player_id': player_id, 'nicknames_as_displayed': sorted(data['nicknames']),
         'player_urls': sorted(data['player_urls']), 'evidence_map_ids': sorted(data['map_ids']),
         'identity_review_state': 'numeric_source_id_only', 'eligible_for_questions': False}
        for player_id, data in sorted(players.items(), key=lambda item: int(item[0]))]
    edges_rows = [
        {'hltv_player_ids': [a, b], 'evidence': sorted(records, key=lambda record: record['mapstatsid']),
         'review_state': 'unreviewed', 'eligible_for_questions': False}
        for (a, b), records in sorted(edges.items(), key=lambda item: tuple(map(int, item[0])))]
    variation = []
    for event_url, teams in sorted(event_teams.items()):
        for team_name, records in sorted(teams.items()):
            if len({record['roster_fingerprint'] for record in records}) > 1:
                variation.append({'event_url': event_url, 'team_name_as_displayed': team_name,
                                  'observed_rosters': sorted(records, key=lambda record: record['mapstatsid']),
                                  'review_reason': 'different_five_player_rosters_in_sampled_maps'})
    report = {'schema_version': 1, 'plan_sha256': hashlib.sha256(plan_raw).hexdigest(),
              'planned_maps': len(plan), 'captured_valid_maps': len(evidence),
              'missing_maps': len(missing), 'invalid_captures': len(invalid),
              'distinct_player_ids': len(players_rows), 'candidate_teammate_pairs': len(edges_rows),
              'pair_map_evidence_records': sum(len(row['evidence']) for row in edges_rows),
              'observed_event_team_roster_variations': len(variation),
              'review_state': 'unreviewed',
              'authorization_status': 'user_reported_admin_permission_personal_project',
              'question_eligibility': False}
    output_dir.mkdir(parents=True, exist_ok=True)
    outputs = {'evidence.jsonl': jsonl(sorted(evidence, key=lambda row: row['mapstatsid'])),
               'players.jsonl': jsonl(players_rows), 'candidate-edges.jsonl': jsonl(edges_rows),
               'roster-variation-review.jsonl': jsonl(variation),
               'missing-maps.jsonl': jsonl(missing), 'invalid-captures.jsonl': jsonl(invalid),
               'report.json': json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2) + '\n'}
    for name, content in outputs.items():
        (output_dir / name).write_text(content)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path, default=PLAN)
    parser.add_argument('--captures', type=Path, default=CAPTURES)
    parser.add_argument('--output', type=Path, default=OUTPUT)
    args = parser.parse_args()
    print(json.dumps(stage(args.plan, args.captures, args.output), ensure_ascii=False, indent=2))
