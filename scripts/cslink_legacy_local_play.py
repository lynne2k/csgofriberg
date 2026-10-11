#!/usr/bin/env python3
"""Freeze local-only play scope for numeric-ID historical HLTV map candidates.

This projection does not change candidate review state. It binds exactly the
captured maps in the frozen pre-July-2023 plan to one local-only manifest.
"""

import argparse
import hashlib
import json
from pathlib import Path
import sqlite3

from cslink_candidate_library import read_plan
from cslink_local_play_projection import (
    automatic_exclusion_reason, file_record, js_json_bytes,
    ordered_json_bytes, validate_candidate_db,
)


ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / '.local-data/cslink/historical-as-v1'
SELECTION = ROOT / 'data/cslink/legacy-katowice-2022-pilot.json'


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode()


def build(base=BASE, selection_path=SELECTION):
    base = Path(base)
    selection_raw = Path(selection_path).read_bytes()
    selection = json.loads(selection_raw)
    plan, plan_info, _, _ = read_plan(base / 'plan/selected-series.jsonl',
                                     base / 'plan/correction-ledger.jsonl')
    plan_by_id = {row['selected_mapstatsid']: row for row in plan}
    candidate_dir = base / 'library'
    candidate_manifest_raw = (candidate_dir / 'manifest.json').read_bytes()
    candidate_manifest = json.loads(candidate_manifest_raw)
    db_raw = (candidate_dir / 'library.sqlite3').read_bytes()
    report_raw = (candidate_dir / 'report.json').read_bytes()
    candidate_report = json.loads(report_raw)
    if (candidate_manifest.get('schema_version') != 1 or
            candidate_manifest.get('library_status') != 'candidate_unreviewed' or
            candidate_manifest.get('eligible_for_questions') is not False or
            candidate_manifest.get('files', {}).get('library.sqlite3') != file_record(db_raw) or
            candidate_manifest.get('files', {}).get('report.json') != file_record(report_raw) or
            candidate_report.get('version') != candidate_manifest.get('version') or
            candidate_report.get('plan_sha256') != plan_info['sha256'] or
            candidate_report.get('maps_with_incomplete_capture_provenance') != 0 or
            candidate_report.get('capture_provenance_gaps') != [] or
            candidate_report.get('captured_valid_maps') != len(plan)):
        raise ValueError('Historical candidate manifest/report/provenance mismatch')
    with sqlite3.connect((candidate_dir / 'library.sqlite3').resolve().as_uri() + '?mode=ro',
                         uri=True) as db:
        db.row_factory = sqlite3.Row
        maps, edge_evidence, all_player_count = validate_candidate_db(db, plan_by_id, len(plan))
    expected_ids = {row['map_id'] for row in selection['maps']}
    if (set(maps) != expected_ids or
            {row['event_url'] for row in plan} != {selection['event_url']} or
            any(row['tier'] != selection['tier'] for row in plan)):
        raise ValueError('Historical candidate differs from selected event scope')
    excluded = []
    included_map_ids = []
    for map_id, row in sorted(maps.items()):
        if row['event_as_displayed'] != selection['hltv_event_name']:
            raise ValueError(f'HLTV event differs from selected event on map {map_id}')
        reason = automatic_exclusion_reason(row['event_as_displayed'])
        if reason:
            excluded.append({'map_id': map_id, 'reason': reason,
                             'event_as_displayed': row['event_as_displayed'],
                             'planned_event_url': row['event_url'],
                             'source_url': row['source_url']})
        else:
            included_map_ids.append(map_id)
    if not included_map_ids:
        raise ValueError('No eligible historical maps remain for local play')
    included_evidence = {(a, b, map_id) for a, b, map_id, _ in edge_evidence
                         if map_id in included_map_ids}
    included_pairs = {(a, b) for a, b, _ in included_evidence}
    included_players = {player_id for pair in included_pairs for player_id in pair}
    event_urls = sorted({row['event_url'] for row in plan if row['selected_mapstatsid'] in included_map_ids})
    approval = {'kind': 'user_requested_legacy_import', 'play_scope': 'local',
                'individual_map_review': 'not_performed',
                'evidence_state': 'observed_unreviewed'}
    version_basis = {'schema_version': 1,
                     'candidate_version': candidate_manifest['version'],
                     'candidate_db_sha256': sha(db_raw),
                     'candidate_manifest_sha256': sha(candidate_manifest_raw),
                     'included_map_ids': included_map_ids,
                     'approved_event_urls': event_urls,
                     'approval': approval}
    version = sha(js_json_bytes(version_basis))[:20]
    report = {'schema_version': 1, 'version': version,
              'status': 'user_requested_legacy_import_local_play_only',
              'candidate_version': candidate_manifest['version'],
              'approved_event_count': len(event_urls),
              'playable_event_count': len(event_urls),
              'sampled_map_count': len(maps),
              'included_map_count': len(included_map_ids),
              'excluded_map_count': len(excluded), 'excluded_maps': excluded,
              'included_player_count': len(included_players),
              'included_pair_count': len(included_pairs),
              'included_pair_map_evidence_count': len(included_evidence),
              'candidate_player_count': all_player_count,
              'map_review_state': 'observed_unreviewed',
              'individual_map_review': 'not_performed',
              'eligible_for_local_play': True,
              'eligible_for_public_release': False,
              'coverage': 'selected_actual_roster_maps_only',
              'date_time_policy': 'source_display_only_timezone_unverified',
              'approval_source_sha256': sha(selection_raw)}
    play_dir = base / 'play'
    play_dir.mkdir(parents=True, exist_ok=True)
    play_report_raw = encoded(report)
    manifest = {**version_basis, 'version': version,
                'approved_event_count': len(event_urls),
                'included_map_count': len(included_map_ids),
                'excluded_maps': excluded,
                'approval_id': 'historical-katowice-2022-pilot',
                'approval_source_sha256': sha(selection_raw),
                'source': {'candidate_report_sha256': sha(report_raw),
                           'candidate_plan_sha256': plan_info['sha256'],
                           'candidate_capture_set_sha256': candidate_manifest['inputs']['capture_set_sha256']},
                'files': {'report.json': file_record(play_report_raw)}}
    (play_dir / 'report.json').write_bytes(play_report_raw)
    (play_dir / 'manifest.json').write_bytes(ordered_json_bytes(manifest))
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', type=Path, default=BASE)
    parser.add_argument('--selection', type=Path, default=SELECTION)
    args = parser.parse_args()
    print(json.dumps(build(args.base, args.selection), ensure_ascii=False, indent=2))
