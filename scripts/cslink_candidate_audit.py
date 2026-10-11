#!/usr/bin/env python3
"""Audit HLTV teammate candidates offline without approving any identity or edge.

The source snapshot establishes the A/S event scope, the effective plan selects
one map per series, captures contain observed player rows, and stage files are
derived candidates. This audit checks the joins between those layers. It never
changes input files and does not claim that sampling one map proves a stable
event-wide roster.
"""

import argparse
from collections import Counter, defaultdict
import hashlib
from itertools import combinations
import json
from pathlib import Path
import re
from urllib.parse import urlsplit

from cslink_roster_pilot import validate_capture


ROOT = Path(__file__).resolve().parents[1]
PLAN = ROOT / 'data/cslink/as-tier-event-cover-2026-10-04-corrected/selected-series.jsonl'
SNAPSHOT = ROOT / 'data/cslink/as-tier-snapshot-2026-10-03'
CAPTURES = ROOT / '.local-data/cslink/hltv-capture-2026-10-04-corrected'
STAGE = ROOT / '.local-data/cslink/hltv-stage-2026-10-04-corrected'
OUTPUT = ROOT / '.local-data/cslink/candidate-audit/v2-corrected'


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def read_jsonl(path):
    return [json.loads(line) for line in path.read_bytes().splitlines() if line.strip()]


def write_jsonl(path, rows):
    path.write_text(''.join(json.dumps(row, ensure_ascii=False, sort_keys=True) + '\n'
                            for row in rows), encoding='utf-8')


def player_url_binds_id(url, player_id):
    parts = urlsplit(url or '')
    return (parts.scheme == 'https' and parts.netloc == 'www.hltv.org' and
            re.fullmatch(rf'/stats/players/{re.escape(str(player_id))}/[^/]+', parts.path) is not None and
            not parts.query and not parts.fragment)


def canonical_record(record):
    return json.dumps(record, ensure_ascii=False, sort_keys=True)


def audit(plan_path=PLAN, snapshot_dir=SNAPSHOT, captures_dir=CAPTURES,
          stage_dir=STAGE, output_dir=OUTPUT):
    plan_raw = plan_path.read_bytes()
    plan = read_jsonl(plan_path)
    source_events = {row['event_url']: row for row in read_jsonl(snapshot_dir / 'events.jsonl')}
    source_maps = {row['mapstatsid']: row for row in read_jsonl(snapshot_dir / 'map-id-queue.jsonl')}
    evidence_rows = read_jsonl(stage_dir / 'evidence.jsonl')
    player_rows = read_jsonl(stage_dir / 'players.jsonl')
    edge_rows = read_jsonl(stage_dir / 'candidate-edges.jsonl')
    stage_report = json.loads((stage_dir / 'report.json').read_text())

    issues = []
    def problem(priority, code, subject, **details):
        issues.append({'priority': priority, 'code': code, 'subject': str(subject), **details})

    map_ids = [row['selected_mapstatsid'] for row in plan]
    if len(map_ids) != len(set(map_ids)):
        problem(0, 'duplicate_plan_map_id', 'plan')
    plan_by_id = {row['selected_mapstatsid']: row for row in plan}
    if stage_report.get('plan_sha256') != digest(plan_raw):
        problem(0, 'stage_plan_hash_mismatch', 'stage report',
                observed=stage_report.get('plan_sha256'), expected=digest(plan_raw))
    for flag in ('question_eligibility',):
        if stage_report.get(flag) is not False:
            problem(0, 'stage_release_gate_changed', flag, observed=stage_report.get(flag))

    event_maps = defaultdict(list)
    for row in plan:
        map_id = row['selected_mapstatsid']
        event_url = row['event_url']
        event_maps[event_url].append(map_id)
        source_event = source_events.get(event_url)
        if source_event is None:
            problem(0, 'event_absent_from_snapshot', map_id, event_url=event_url)
        else:
            expected = {'tier': source_event['page_tier'], 'event_name': source_event['event_name'],
                        'event_start_date': source_event['page_start_date']}
            for field, value in expected.items():
                if row.get(field) != value:
                    problem(0, 'event_source_binding_mismatch', map_id, field=field,
                            observed=row.get(field), expected=value, event_url=event_url)
            if source_event['index_tier'] + '-Tier' != source_event['page_tier']:
                problem(1, 'event_index_page_tier_disagree', map_id, event_url=event_url)
        if row.get('tier') not in {'A-Tier', 'S-Tier'}:
            problem(0, 'outside_a_s_scope', map_id, event_url=event_url, tier=row.get('tier'))
        source_map_id = row.get('source_selected_mapstatsid', map_id)
        source_map = source_maps.get(source_map_id)
        if source_map is None:
            problem(0, 'map_absent_from_source_snapshot', map_id, source_map_id=source_map_id)
        else:
            for field in ('event_url', 'hltv_series_id', 'source_page_url',
                          'source_revision_sha256', 'tier'):
                if row.get(field) != source_map.get(field):
                    problem(0, 'map_source_binding_mismatch', map_id, field=field,
                            observed=row.get(field), expected=source_map.get(field))
        if source_map_id != map_id and (not row.get('map_id_correction_id') or
                                       row.get('hltv_link_status') !=
                                       'verified_from_official_hltv_series_page'):
            problem(0, 'unbound_map_id_correction', map_id, source_map_id=source_map_id)
        if row.get('eligible_for_questions') is not False or row.get('roster_status') != 'unverified':
            problem(0, 'plan_release_gate_changed', map_id)

    staged_by_id = {}
    for item in evidence_rows:
        map_id = item['mapstatsid']
        if map_id in staged_by_id:
            problem(0, 'duplicate_stage_map', map_id)
        staged_by_id[map_id] = item
    for map_id in sorted(set(plan_by_id) - set(staged_by_id)):
        problem(0, 'missing_stage_map', map_id)
    for map_id in sorted(set(staged_by_id) - set(plan_by_id)):
        problem(0, 'unplanned_stage_map', map_id)

    expected_players = defaultdict(lambda: {'nicknames': set(), 'urls': set(), 'map_ids': set()})
    nickname_ids = defaultdict(set)
    folded_nickname_ids = defaultdict(set)
    expected_edges = defaultdict(list)
    rosters_by_event_team = defaultdict(list)
    displayed_events = defaultdict(set)
    valid_capture_count = 0
    capture_without_provenance = []
    for map_id, row in sorted(plan_by_id.items()):
        item = staged_by_id.get(map_id)
        capture_path = captures_dir / f'{map_id}.json'
        if not capture_path.is_file():
            problem(0, 'missing_capture', map_id, path=str(capture_path))
            continue
        raw = capture_path.read_bytes()
        try:
            capture = json.loads(raw)
            validated = validate_capture(capture, map_id)
            valid_capture_count += 1
        except (ValueError, TypeError, json.JSONDecodeError) as exc:
            problem(0, 'invalid_capture', map_id, reason=str(exc), path=str(capture_path))
            continue
        expected_meta = {'event_url': row['event_url'],
                         'hltv_series_id_from_liquipedia': row['hltv_series_id'],
                         'source_revision_sha256': row['source_revision_sha256']}
        missing_fields = [field for field in expected_meta if field not in capture]
        if missing_fields:
            capture_without_provenance.append(map_id)
            problem(1, 'capture_missing_provenance_fields', map_id,
                    missing_fields=missing_fields, capture_sha256=digest(raw),
                    source_url=validated['source_url'], event_url=row['event_url'],
                    hltv_series_url=row.get('hltv_series_url'))
        for field, expected in expected_meta.items():
            if field in capture and capture[field] != expected:
                problem(0, 'capture_provenance_mismatch', map_id, field=field,
                        observed=capture[field], expected=expected)
        if capture.get('source_url') != row['hltv_map_url']:
            problem(0, 'capture_map_url_mismatch', map_id,
                    observed=capture.get('source_url'), expected=row['hltv_map_url'])
        if item is None:
            continue
        expected_stage = {'source_sha256': digest(raw), 'source_url': row['hltv_map_url'],
                          'event_url': row['event_url'], 'event_name_candidate': row['event_name'],
                          'hltv_series_id_candidate': row['hltv_series_id']}
        for field, expected in expected_stage.items():
            if item.get(field) != expected:
                problem(0, 'stage_capture_binding_mismatch', map_id, field=field,
                        observed=item.get(field), expected=expected)
        for field in ('event_as_displayed', 'date_time_as_displayed', 'map_as_displayed'):
            if item.get(field) != validated[field]:
                problem(0, 'stage_capture_content_mismatch', map_id, field=field)
        if item.get('eligible_for_questions') is not False or item.get('review_state') != 'unreviewed':
            problem(0, 'stage_evidence_release_gate_changed', map_id)
        displayed_events[row['event_url']].add(validated['event_as_displayed'])
        raw_teams = {team['name_as_displayed']: team for team in validated['teams']}
        stage_teams = {team['name_as_displayed']: team for team in item.get('teams', [])}
        if set(raw_teams) != set(stage_teams):
            problem(0, 'stage_team_names_mismatch', map_id,
                    capture_teams=sorted(raw_teams), staged_teams=sorted(stage_teams))
        for team_name, team in raw_teams.items():
            staged = stage_teams.get(team_name)
            players = team['players']
            ids = sorted((person['source_player_id'] for person in players), key=int)
            if staged and Counter(map(canonical_record, staged['players'])) != Counter(
                    map(canonical_record, players)):
                problem(0, 'stage_roster_differs_from_capture', map_id, team=team_name)
            rosters_by_event_team[(row['event_url'], team_name)].append(
                {'mapstatsid': map_id, 'player_ids': ids,
                 'players_as_displayed': sorted(({'hltv_player_id': person['source_player_id'],
                                                  'nickname': person['nickname_as_displayed']}
                                                 for person in players),
                                                key=lambda person: int(person['hltv_player_id'])),
                 'source_url': validated['source_url']})
            if len(set(ids)) != len(ids):
                problem(0, 'duplicate_player_in_team', map_id, team=team_name)
            for person in players:
                player_id = person['source_player_id']
                url = person['source_player_url']
                nickname = person['nickname_as_displayed']
                if not player_url_binds_id(url, player_id):
                    problem(0, 'player_url_id_mismatch', map_id, player_id=player_id, player_url=url)
                expected_players[player_id]['nicknames'].add(nickname)
                expected_players[player_id]['urls'].add(url)
                expected_players[player_id]['map_ids'].add(map_id)
                nickname_ids[nickname].add(player_id)
                folded_nickname_ids[nickname.casefold()].add(player_id)
            for left, right in combinations(ids, 2):
                expected_edges[(left, right)].append({
                    'mapstatsid': map_id, 'source_url': validated['source_url'],
                    'event_url': row['event_url'], 'event_name_candidate': row['event_name'],
                    'team_name_as_displayed': team_name,
                    'date_time_as_displayed': validated['date_time_as_displayed'],
                    'map_name_as_displayed': validated['map_as_displayed']})

    staged_players = {}
    for item in player_rows:
        player_id = item['hltv_player_id']
        if player_id in staged_players:
            problem(0, 'duplicate_stage_player_id', player_id)
        staged_players[player_id] = item
    for player_id in sorted(set(expected_players) | set(staged_players), key=int):
        item = staged_players.get(player_id)
        expected = expected_players.get(player_id)
        if item is None or expected is None:
            problem(0, 'stage_player_set_mismatch', player_id,
                    expected=expected is not None, staged=item is not None)
            continue
        for field, values in (('nicknames_as_displayed', expected['nicknames']),
                              ('player_urls', expected['urls']),
                              ('evidence_map_ids', expected['map_ids'])):
            if set(item.get(field, [])) != values:
                problem(0, 'stage_player_evidence_mismatch', player_id, field=field)
        if item.get('identity_review_state') != 'numeric_source_id_only' or item.get(
                'eligible_for_questions') is not False:
            problem(0, 'player_release_gate_changed', player_id)

    staged_edges = {}
    for item in edge_rows:
        ids = item['hltv_player_ids']
        key = tuple(sorted(ids, key=int))
        if len(ids) != 2 or ids[0] == ids[1] or ids != list(key):
            problem(0, 'malformed_candidate_edge', ids)
            continue
        if key in staged_edges:
            problem(0, 'duplicate_candidate_edge', ids)
        staged_edges[key] = item
    for key in sorted(set(expected_edges) | set(staged_edges), key=lambda pair: tuple(map(int, pair))):
        item = staged_edges.get(key)
        expected = expected_edges.get(key)
        if item is None or expected is None:
            problem(0, 'candidate_edge_set_mismatch', '|'.join(key),
                    expected=expected is not None, staged=item is not None)
            continue
        if Counter(map(canonical_record, item['evidence'])) != Counter(map(canonical_record, expected)):
            problem(0, 'candidate_edge_evidence_mismatch', '|'.join(key),
                    expected_evidence_count=len(expected), staged_evidence_count=len(item['evidence']))
        if item.get('review_state') != 'unreviewed' or item.get('eligible_for_questions') is not False:
            problem(0, 'candidate_edge_release_gate_changed', '|'.join(key))

    identity_review = []
    for player_id, data in expected_players.items():
        if len(data['nicknames']) > 1:
            identity_review.append({'priority': 1, 'reason': 'one_numeric_id_multiple_display_names',
                                    'player_ids': [player_id], 'nicknames': sorted(data['nicknames']),
                                    'map_ids': sorted(data['map_ids']),
                                    'player_urls': sorted(data['urls'])})
    for nickname, ids in nickname_ids.items():
        if len(ids) > 1:
            identity_review.append({'priority': 1, 'reason': 'exact_nickname_multiple_numeric_ids',
                                    'player_ids': sorted(ids, key=int), 'nicknames': [nickname],
                                    'player_urls': sorted({url for pid in ids
                                                           for url in expected_players[pid]['urls']})})
    for folded, ids in folded_nickname_ids.items():
        if len(ids) > 1 and all(len(nickname_ids[name]) == 1 for name in nickname_ids
                                 if name.casefold() == folded):
            identity_review.append({'priority': 1, 'reason': 'casefold_only_nickname_collision',
                                    'player_ids': sorted(ids, key=int),
                                    'nicknames': sorted({name for name in nickname_ids
                                                         if name.casefold() == folded}),
                                    'player_urls': sorted({url for pid in ids
                                                           for url in expected_players[pid]['urls']})})
    identity_review.sort(key=lambda row: (row['priority'], row['reason'], row['nicknames']))

    roster_review = []
    for (event_url, team_name), observed in rosters_by_event_team.items():
        if len({tuple(row['player_ids']) for row in observed}) > 1:
            roster_review.append({'priority': 1, 'reason': 'observed_roster_change_within_event',
                                  'event_url': event_url, 'team_name_as_displayed': team_name,
                                  'observed_rosters': sorted(observed, key=lambda row: row['mapstatsid'])})
    roster_review.sort(key=lambda row: (row['event_url'], row['team_name_as_displayed']))

    event_review = []
    for event_url, ids in event_maps.items():
        source_event = source_events.get(event_url, {})
        event_review.append({'priority': 2, 'reason': 'event_scope_and_display_name_pending_review',
                             'event_url': event_url, 'tier': source_event.get('page_tier'),
                             'index_tier': source_event.get('index_tier'),
                             'snapshot_review_state': source_event.get('review_state'),
                             'plan_event_name': plan_by_id[ids[0]]['event_name'],
                             'hltv_event_names_as_displayed': sorted(displayed_events[event_url]),
                             'selected_map_count': len(ids), 'sample_map_ids': sorted(ids)[:3]})
    event_review.sort(key=lambda row: (-row['selected_map_count'], row['event_url']))

    source_evidence_index = [
        {'hltv_player_id': player_id, 'nicknames_as_displayed': sorted(data['nicknames']),
         'player_urls': sorted(data['urls']), 'map_count': len(data['map_ids']),
         'sample_map_evidence_urls': [plan_by_id[map_id]['hltv_map_url']
                                      for map_id in sorted(data['map_ids'])[:3]]}
        for player_id, data in sorted(expected_players.items(), key=lambda row: int(row[0]))]

    report_counts = {'captured_valid_maps': len(evidence_rows),
                     'distinct_player_ids': len(player_rows),
                     'candidate_teammate_pairs': len(edge_rows),
                     'pair_map_evidence_records': sum(len(row.get('evidence', [])) for row in edge_rows),
                     'observed_event_team_roster_variations': len(roster_review)}
    for field, expected in report_counts.items():
        if stage_report.get(field) != expected:
            problem(0, 'staging_report_count_mismatch', field,
                    observed=stage_report.get(field), expected=expected)

    issues.sort(key=lambda row: (row['priority'], row['code'], row['subject']))
    codes = Counter(row['code'] for row in issues)
    priority_review = ([{'priority': item['priority'], 'kind': 'integrity', **item}
                        for item in issues] +
                       [{'priority': item['priority'], 'kind': 'identity', **item}
                        for item in identity_review] +
                       [{'priority': item['priority'], 'kind': 'roster', **item}
                        for item in roster_review] +
                       [{'priority': item['priority'], 'kind': 'event', **item}
                        for item in event_review])
    priority_review.sort(key=lambda row: (row['priority'], row['kind'],
                                           row.get('subject', row.get('event_url',
                                                                   str(row.get('player_ids', ''))))))
    next_review_order = []
    if any(item['priority'] == 0 for item in issues):
        next_review_order.append(
            'Resolve priority-0 source/capture/edge integrity issues before importing candidates.')
    if capture_without_provenance:
        next_review_order.append(
            'Verify captures missing source metadata against original batch logs or recapture into a new version.')
    if identity_review:
        next_review_order.append(
            'Review numeric IDs with exact and casefold-only nickname collisions without merging by name.')
    if roster_review:
        next_review_order.append(
            'Check event-team roster changes and substitutions using linked map evidence.')
    if event_review:
        next_review_order.append(
            'Review A/S event scope and HLTV event display names before approving questions.')
    report = {'schema_version': 1, 'plan_sha256': digest(plan_raw),
              'snapshot_events_sha256': digest((snapshot_dir / 'events.jsonl').read_bytes()),
              'snapshot_map_queue_sha256': digest((snapshot_dir / 'map-id-queue.jsonl').read_bytes()),
              'planned_maps': len(plan), 'valid_captures': valid_capture_count,
              'staged_maps': len(evidence_rows), 'staged_players': len(player_rows),
              'staged_pairs': len(edge_rows), 'recomputed_pairs': len(expected_edges),
              'recomputed_pair_map_evidence': sum(map(len, expected_edges.values())),
              'integrity_issue_count': len(issues), 'integrity_issue_counts': dict(sorted(codes.items())),
              'captures_missing_provenance': capture_without_provenance,
              'identity_review_items': len(identity_review),
              'exact_nickname_collisions': sum(row['reason'] == 'exact_nickname_multiple_numeric_ids'
                                               for row in identity_review),
              'casefold_only_nickname_collisions': sum(row['reason'] == 'casefold_only_nickname_collision'
                                                       for row in identity_review),
              'numeric_ids_with_multiple_nicknames': sum(row['reason'] == 'one_numeric_id_multiple_display_names'
                                                         for row in identity_review),
              'observed_roster_changes': len(roster_review),
              'events_pending_scope_review': sum(row['snapshot_review_state'] != 'scope_approved'
                                                 for row in event_review),
              'event_review_items': len(event_review),
              'priority_review_items': len(priority_review),
              'review_state': 'unreviewed', 'question_eligibility': False,
              'date_time_policy': 'source_display_only_timezone_unverified',
              'next_review_order': next_review_order}
    output_dir.mkdir(parents=True, exist_ok=True)
    write_jsonl(output_dir / 'integrity-issues.jsonl', issues)
    write_jsonl(output_dir / 'identity-review.jsonl', identity_review)
    write_jsonl(output_dir / 'roster-review.jsonl', roster_review)
    write_jsonl(output_dir / 'event-review.jsonl', event_review)
    write_jsonl(output_dir / 'player-source-index.jsonl', source_evidence_index)
    write_jsonl(output_dir / 'priority-review.jsonl', priority_review)
    (output_dir / 'report.json').write_text(json.dumps(report, ensure_ascii=False, sort_keys=True,
                                                        indent=2) + '\n', encoding='utf-8')
    return report


def compare_versions(baseline_stage_dir, current_stage_dir, baseline_audit_dir,
                     current_audit_dir, output_path):
    """Record the exact derived-data delta between two audited capture versions."""
    baseline = json.loads((baseline_audit_dir / 'report.json').read_text())
    current = json.loads((current_audit_dir / 'report.json').read_text())
    old_maps = {row['mapstatsid']: row for row in read_jsonl(baseline_stage_dir / 'evidence.jsonl')}
    new_maps = {row['mapstatsid']: row for row in read_jsonl(current_stage_dir / 'evidence.jsonl')}
    changed_maps = []
    for map_id in sorted(set(old_maps) | set(new_maps)):
        before, after = old_maps.get(map_id), new_maps.get(map_id)
        if before == after:
            continue
        fields = sorted(key for key in set(before or {}) | set(after or {})
                        if (before or {}).get(key) != (after or {}).get(key))
        changed_maps.append({'mapstatsid': map_id, 'changed_fields': fields,
                             'roster_unchanged': before is not None and after is not None and
                             before.get('teams') == after.get('teams'),
                             'old_display_time': (before or {}).get('date_time_as_displayed'),
                             'new_display_time': (after or {}).get('date_time_as_displayed'),
                             'source_url': (after or before).get('source_url')})
    old_edges = {tuple(row['hltv_player_ids']): row for row in
                 read_jsonl(baseline_stage_dir / 'candidate-edges.jsonl')}
    new_edges = {tuple(row['hltv_player_ids']): row for row in
                 read_jsonl(current_stage_dir / 'candidate-edges.jsonl')}
    changed_edges = [key for key in set(old_edges) | set(new_edges)
                     if old_edges.get(key) != new_edges.get(key)]
    count_fields = ('planned_maps', 'valid_captures', 'staged_maps', 'staged_players',
                    'staged_pairs', 'recomputed_pairs', 'recomputed_pair_map_evidence',
                    'exact_nickname_collisions', 'casefold_only_nickname_collisions',
                    'observed_roster_changes', 'events_pending_scope_review')
    count_changes = {field: {'baseline': baseline.get(field), 'current': current.get(field)}
                     for field in count_fields if baseline.get(field) != current.get(field)}
    result = {'schema_version': 1, 'baseline_plan_sha256': baseline['plan_sha256'],
              'current_plan_sha256': current['plan_sha256'],
              'count_changes': count_changes,
              'integrity_issue_count': {'baseline': baseline['integrity_issue_count'],
                                        'current': current['integrity_issue_count']},
              'captures_missing_provenance': {
                  'baseline': baseline['captures_missing_provenance'],
                  'current': current['captures_missing_provenance']},
              'changed_maps': changed_maps, 'changed_candidate_edge_count': len(changed_edges),
              'changed_candidate_edge_player_ids': [list(key) for key in sorted(
                  changed_edges, key=lambda pair: tuple(map(int, pair)))],
              'player_rows_unchanged': (baseline_stage_dir / 'players.jsonl').read_bytes() ==
                                       (current_stage_dir / 'players.jsonl').read_bytes(),
              'manual_review_items': [
                  {'priority': 1, 'reason': 'source_display_time_changed_between_captures',
                   'mapstatsid': row['mapstatsid'], 'source_url': row['source_url'],
                   'old_display_time': row['old_display_time'],
                   'new_display_time': row['new_display_time']}
                  for row in changed_maps if row['old_display_time'] != row['new_display_time']],
              'date_time_policy': 'source_display_only_timezone_unverified',
              'question_eligibility': False}
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2) + '\n',
                           encoding='utf-8')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path, default=PLAN)
    parser.add_argument('--snapshot', type=Path, default=SNAPSHOT)
    parser.add_argument('--captures', type=Path, default=CAPTURES)
    parser.add_argument('--stage', type=Path, default=STAGE)
    parser.add_argument('--output', type=Path, default=OUTPUT)
    parser.add_argument('--baseline-stage', type=Path)
    parser.add_argument('--baseline-audit', type=Path)
    parser.add_argument('--comparison-output', type=Path)
    args = parser.parse_args()
    report = audit(args.plan, args.snapshot, args.captures, args.stage, args.output)
    compare_args = (args.baseline_stage, args.baseline_audit, args.comparison_output)
    if any(compare_args):
        if not all(compare_args):
            parser.error('--baseline-stage, --baseline-audit, and --comparison-output are required together')
        report['comparison'] = compare_versions(args.baseline_stage, args.stage,
                                                args.baseline_audit, args.output,
                                                args.comparison_output)
    print(json.dumps(report, ensure_ascii=False, indent=2))
