#!/usr/bin/env python3
"""Freeze a user-approved, local-only A/S map allowlist over the candidate library.

The source SQLite remains untouched and unreviewed. The resulting manifest is a
versioned projection for local play, not a claim of individual map verification
or permission to publish the data.
"""

import argparse
from collections import Counter, defaultdict
import hashlib
from itertools import combinations
import json
import os
from pathlib import Path
import re
import sqlite3
import tempfile
from urllib.parse import urlsplit

from cslink_candidate_library import LEDGER, PLAN, ROOT, read_plan


CANDIDATE_DIR = ROOT / '.local-data/cslink/candidate-library-v1'
AUDIT_DIR = ROOT / '.local-data/cslink/candidate-audit/v3-provenance-complete'
APPROVAL = ROOT / 'data/cslink/as-tier-local-play-2026-10-04-approval.json'
OUTPUT = ROOT / '.local-data/cslink/as-tier-local-play-v1'


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode()


def ordered_json_bytes(value):
    # Approval property order is part of the cross-language version contract.
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()


def js_json_bytes(value):
    """Match JSON.stringify's compact field-order-preserving byte representation."""
    return json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()


def file_record(raw):
    return {'bytes': len(raw), 'sha256': sha256(raw)}


def read_json(path):
    raw = path.read_bytes()
    return json.loads(raw), raw


def checked_file(directory, manifest, name):
    raw = (directory / name).read_bytes()
    if manifest.get('files', {}).get(name) != file_record(raw):
        raise ValueError(f'Candidate {name} differs from its manifest')
    return raw


def hltv_url_binds_id(url, expression, expected_id):
    parts = urlsplit(url or '')
    match = re.fullmatch(expression, parts.path)
    return (parts.scheme == 'https' and parts.netloc == 'www.hltv.org' and
            match is not None and match.group(1) == str(expected_id) and
            not parts.query and not parts.fragment)


def automatic_exclusion_reason(displayed):
    label = displayed.casefold()
    if 'showmatch' in label or 'show match' in label or 'all-star' in label or 'all star' in label:
        return 'showmatch_outside_formal_event'
    if 'qualifier' in label or 'qualification' in label or re.search(r'\brmr\b', label):
        return 'independent_closed_qualifier_outside_selected_event'
    return None


def validate_candidate_db(db, plan_by_id, expected_map_count):
    if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
        raise ValueError('Candidate SQLite integrity check failed')
    if db.execute('PRAGMA foreign_key_check').fetchone():
        raise ValueError('Candidate SQLite foreign key check failed')

    maps = {row['map_id']: row for row in db.execute('SELECT * FROM maps')}
    if set(maps) != set(plan_by_id) or len(maps) != expected_map_count:
        raise ValueError('Candidate maps do not exactly match the approved plan')
    players = {row['player_id']: row for row in db.execute('SELECT * FROM players')}
    if any(not re.fullmatch(r'[1-9]\d*', player_id) for player_id in players):
        raise ValueError('Candidate player ID is not a stable HLTV number')

    appearance_by_map = defaultdict(list)
    for appearance in db.execute('SELECT * FROM appearances'):
        appearance_by_map[appearance['map_id']].append(appearance)
    expected_evidence = set()
    for map_id, map_row in maps.items():
        plan = plan_by_id[map_id]
        expected_map = {'series_id': plan['hltv_series_id'], 'series_url': plan['hltv_series_url'],
                        'event_url': plan['event_url'], 'tier': plan['tier'],
                        'source_url': plan['hltv_map_url'],
                        'source_revision_sha256': plan['source_revision_sha256']}
        if any(map_row[key] != value for key, value in expected_map.items()):
            raise ValueError(f'Candidate map conflicts with approved plan: {map_id}')
        if map_row['capture_provenance_status'] != 'matched' or not re.fullmatch(
                r'[0-9a-f]{64}', map_row['capture_sha256']):
            raise ValueError(f'Candidate map lacks complete capture provenance: {map_id}')
        if map_row['review_state'] != 'unreviewed' or map_row['eligible_for_questions'] != 0:
            raise ValueError(f'Candidate map review state changed unexpectedly: {map_id}')
        if (not hltv_url_binds_id(map_row['source_url'],
                                  r'/stats/matches/mapstatsid/(\d+)/[^/]+', map_id) or
                not hltv_url_binds_id(map_row['series_url'], r'/matches/(\d+)/[^/]+',
                                      map_row['series_id'])):
            raise ValueError(f'Candidate HLTV map/series URL does not bind ID: {map_id}')
        if not all(isinstance(map_row[key], str) and map_row[key].strip()
                   for key in ('event_as_displayed', 'map_name', 'date_time_as_displayed')):
            raise ValueError(f'Candidate map lacks displayed details: {map_id}')
        appearances = appearance_by_map[map_id]
        teams = defaultdict(list)
        for row in appearances:
            player_id = row['player_id']
            if player_id not in players or not hltv_url_binds_id(
                    row['player_url'], r'/stats/players/(\d+)/[^/]+', player_id):
                raise ValueError(f'Candidate appearance lacks bound player identity: {map_id}')
            if not row['nickname'] or not row['team_name'] or not row['opponent_name']:
                raise ValueError(f'Candidate appearance lacks displayed detail: {map_id}')
            if any(type(row[key]) is not int or row[key] < 0 for key in
                   ('team_score', 'opponent_score')):
                raise ValueError(f'Candidate appearance has invalid score: {map_id}')
            teams[row['team_name']].append(row)
        if len(appearances) != 10 or len({row['player_id'] for row in appearances}) != 10 or \
                len(teams) != 2 or sorted(map(len, teams.values())) != [5, 5]:
            raise ValueError(f'Candidate map lacks two distinct five-player teams: {map_id}')
        team_names = list(teams)
        for team_name, rows in teams.items():
            opponent = team_names[0] if team_name == team_names[1] else team_names[1]
            scores = {(row['team_score'], row['opponent_score']) for row in rows}
            if len(scores) != 1 or any(row['opponent_name'] != opponent for row in rows):
                raise ValueError(f'Candidate map has inconsistent team/score: {map_id}')
            opposite_scores = {(row['team_score'], row['opponent_score'])
                               for row in teams[opponent]}
            if opposite_scores != {tuple(reversed(next(iter(scores))))}:
                raise ValueError(f'Candidate map scores are not reciprocal: {map_id}')
            ids = sorted((row['player_id'] for row in rows), key=int)
            for a, b in combinations(ids, 2):
                expected_evidence.add((a, b, map_id, team_name))
    observed_evidence = {(row['player_a'], row['player_b'], row['map_id'], row['team_name'])
                         for row in db.execute('SELECT * FROM edge_evidence')}
    if expected_evidence != observed_evidence:
        raise ValueError('Candidate edge evidence differs from same-map five-player pairs')
    evidence_counts = Counter((a, b) for a, b, _, _ in expected_evidence)
    edges = {(row['player_a'], row['player_b']): row for row in db.execute('SELECT * FROM edges')}
    if set(edges) != set(evidence_counts) or any(
            edge['evidence_count'] != evidence_counts[key] or
            edge['review_state'] != 'unreviewed' or edge['eligible_for_questions'] != 0
            for key, edge in edges.items()):
        raise ValueError('Candidate edge counts or review state disagree with evidence')
    if any(row['review_state'] != 'unreviewed' or row['eligible_for_questions'] != 0
           for row in players.values()):
        raise ValueError('Candidate player review state changed unexpectedly')
    return maps, expected_evidence, len(players)


def build(candidate_dir=CANDIDATE_DIR, plan_path=PLAN, audit_dir=AUDIT_DIR,
          approval_path=APPROVAL, output_dir=OUTPUT, ledger_path=LEDGER):
    candidate_dir, plan_path, audit_dir, approval_path, output_dir = map(
        Path, (candidate_dir, plan_path, audit_dir, approval_path, output_dir))
    plan, plan_info, _, _ = read_plan(plan_path, Path(ledger_path) if ledger_path else None)
    plan_by_id = {row['selected_mapstatsid']: row for row in plan}
    approval, approval_raw = read_json(approval_path)
    candidate_manifest, candidate_manifest_raw = read_json(candidate_dir / 'manifest.json')
    db_raw = checked_file(candidate_dir, candidate_manifest, 'library.sqlite3')
    candidate_report = json.loads(checked_file(candidate_dir, candidate_manifest, 'report.json'))
    audit_report, audit_report_raw = read_json(audit_dir / 'report.json')
    audit_events_raw = (audit_dir / 'event-review.jsonl').read_bytes()
    audit_events = [json.loads(line) for line in audit_events_raw.splitlines() if line.strip()]

    if approval.get('schema_version') != 1 or approval.get('approval_kind') != \
            'user_batch_scope_approval' or approval.get('play_scope') != 'local':
        raise ValueError('Missing explicit local user batch approval')
    if (approval.get('candidate_version') != candidate_manifest.get('version') or
            approval.get('candidate_db_sha256') != sha256(db_raw) or
            approval.get('plan_sha256') != plan_info['sha256'] or
            approval.get('audit_report_sha256') != sha256(audit_report_raw) or
            approval.get('audit_event_review_sha256') != sha256(audit_events_raw) or
            candidate_manifest.get('files', {}).get('library.sqlite3', {}).get('sha256') != sha256(db_raw) or
            candidate_report.get('version') != candidate_manifest.get('version') or
            candidate_report.get('plan_sha256') != plan_info['sha256'] or
            candidate_manifest.get('inputs', {}).get('plan_sha256') != plan_info['sha256']):
        raise ValueError('Approved candidate version or source hash changed')
    if (candidate_report.get('library_status') != 'candidate_unreviewed' or
            candidate_report.get('review_state') != 'unreviewed' or
            candidate_report.get('eligible_for_questions') is not False or
            candidate_report.get('maps_with_incomplete_capture_provenance') != 0 or
            candidate_report.get('capture_provenance_gaps') != []):
        raise ValueError('Candidate provenance or review gate is not safe for batch projection')
    event_urls = sorted({row['event_url'] for row in plan})
    if (len(event_urls) != approval.get('expected_event_count') or
            len(plan) != approval.get('expected_sampled_map_count') or
            candidate_report.get('captured_valid_maps') != len(plan) or
            audit_report.get('integrity_issue_count') != 0 or
            audit_report.get('captures_missing_provenance') != [] or
            audit_report.get('planned_maps') != len(plan) or
            audit_report.get('plan_sha256') != plan_info['sha256'] or
            audit_report.get('event_review_items') != len(event_urls) or
            {row['event_url'] for row in audit_events} != set(event_urls) or
            len(audit_events) != len(event_urls)):
        raise ValueError('Approved event/map coverage conflicts with plan or audit')

    connection = sqlite3.connect((candidate_dir / 'library.sqlite3').resolve().as_uri() + '?mode=ro',
                                 uri=True)
    connection.row_factory = sqlite3.Row
    try:
        maps, all_evidence, all_player_count = validate_candidate_db(connection, plan_by_id, len(plan))
    finally:
        connection.close()

    exclusion_decisions = approval.get('excluded_maps')
    if not isinstance(exclusion_decisions, list):
        raise ValueError('Approval must explicitly list excluded maps')
    decision_by_id = {item['map_id']: item for item in exclusion_decisions}
    if len(decision_by_id) != len(exclusion_decisions) or not set(decision_by_id) <= set(maps):
        raise ValueError('Duplicate or unknown excluded map in approval')
    excluded = []
    for map_id, map_row in sorted(maps.items()):
        expected_reason = automatic_exclusion_reason(map_row['event_as_displayed'])
        decision = decision_by_id.get(map_id)
        if bool(expected_reason) != bool(decision):
            raise ValueError(f'Map scope anomaly lacks explicit disposition or exclusion is unjustified: {map_id}')
        if decision:
            if (decision.get('reason') != expected_reason or
                    decision.get('expected_event_as_displayed') != map_row['event_as_displayed']):
                raise ValueError(f'Excluded map disposition does not match observed HLTV event: {map_id}')
            excluded.append({'map_id': map_id, 'reason': decision['reason'],
                             'event_as_displayed': map_row['event_as_displayed'],
                             'planned_event_url': map_row['event_url'],
                             'source_url': map_row['source_url']})
    included_map_ids = sorted(set(maps) - set(decision_by_id))
    included_set = set(included_map_ids)
    included_event_urls = {maps[map_id]['event_url'] for map_id in included_set}
    approved_event_urls = event_urls
    included_evidence = {(a, b, map_id) for a, b, map_id, _ in all_evidence
                         if map_id in included_set}
    included_pairs = {(a, b) for a, b, _ in included_evidence}
    included_players = {player_id for pair in included_pairs for player_id in pair}
    approval_state = {'kind': 'user_batch_scope_approval', 'play_scope': 'local',
                      'individual_map_review': 'not_performed',
                      'evidence_state': 'observed_unreviewed'}
    candidate_db_sha256 = sha256(db_raw)
    candidate_manifest_sha256 = sha256(candidate_manifest_raw)
    version_basis = {'schema_version': 1, 'candidate_version': candidate_manifest['version'],
                     'candidate_db_sha256': candidate_db_sha256,
                     'candidate_manifest_sha256': candidate_manifest_sha256,
                     'included_map_ids': included_map_ids,
                     'approved_event_urls': approved_event_urls, 'approval': approval_state}
    version = sha256(js_json_bytes(version_basis))[:20]
    report = {'schema_version': 1, 'version': version,
              'status': 'user_batch_approved_local_play_only',
              'candidate_version': candidate_manifest['version'],
              'approved_event_count': len(approved_event_urls),
              'playable_event_count': len(included_event_urls),
              'sampled_map_count': len(maps), 'included_map_count': len(included_map_ids),
              'excluded_map_count': len(excluded),
              'excluded_maps': excluded,
              'included_player_count': len(included_players),
              'included_pair_count': len(included_pairs),
              'included_pair_map_evidence_count': len(included_evidence),
              'candidate_player_count': all_player_count,
              'map_review_state': 'observed_unreviewed',
              'individual_map_review': 'not_performed',
              'eligible_for_local_play': True,
              'eligible_for_public_release': False,
              'coverage': 'one_selected_map_per_series_only',
              'date_time_policy': 'source_display_only_timezone_unverified',
              'approval_source_sha256': sha256(approval_raw),
              'audit_report_sha256': sha256(audit_report_raw)}
    report_raw = json_bytes(report)
    manifest = {**version_basis, 'version': version,
                'approved_event_count': len(approved_event_urls),
                'included_map_count': len(included_map_ids),
                'excluded_maps': excluded,
                'approval_id': approval['approval_id'],
                'approval_source_sha256': sha256(approval_raw),
                'source': {'candidate_report_sha256': candidate_manifest['files']['report.json']['sha256'],
                           'candidate_plan_sha256': plan_info['sha256'],
                           'candidate_capture_set_sha256': candidate_manifest['inputs']['capture_set_sha256'],
                           'audit_report_sha256': sha256(audit_report_raw),
                           'audit_event_review_sha256': sha256(audit_events_raw)},
                'files': {'report.json': file_record(report_raw)}}
    output_dir.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.cslink-local-play-', dir=output_dir.parent) as tmp:
        tmp_dir = Path(tmp)
        (tmp_dir / 'report.json').write_bytes(report_raw)
        (tmp_dir / 'manifest.json').write_bytes(ordered_json_bytes(manifest))
        output_dir.mkdir(parents=True, exist_ok=True)
        for name in ('report.json', 'manifest.json'):
            os.replace(tmp_dir / name, output_dir / name)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate', type=Path, default=CANDIDATE_DIR)
    parser.add_argument('--plan', type=Path, default=PLAN)
    parser.add_argument('--audit', type=Path, default=AUDIT_DIR)
    parser.add_argument('--approval', type=Path, default=APPROVAL)
    parser.add_argument('--output', type=Path, default=OUTPUT)
    parser.add_argument('--ledger', type=Path, default=LEDGER)
    args = parser.parse_args()
    print(json.dumps(build(args.candidate, args.plan, args.audit, args.approval, args.output,
                           args.ledger), ensure_ascii=False, indent=2))
