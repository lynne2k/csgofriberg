#!/usr/bin/env python3
"""Bridge selected old CSV map rows to fresh numeric-ID HLTV map captures.

The historical CSV is a discovery source, not an identity authority. This
script never maps its player nicknames to identities. Only a valid fresh HLTV
map capture can provide numeric IDs and a playable same-map roster.
"""

import argparse
from datetime import date
import hashlib
import json
from pathlib import Path
import sqlite3

from cslink_candidate_library import build as build_candidate_library, read_plan
from cslink_roster_pilot import validate_capture


ROOT = Path(__file__).resolve().parents[1]
SELECTION = ROOT / 'data/cslink/legacy-katowice-2022-pilot.json'
LOCAL_REVIEW = ROOT / 'data/cslink/local-review.json'
SOURCE_LOCK = ROOT / 'data/cslink/source.lock.json'
SOURCE_DIR = ROOT / '.local-data/dataset-audit-20260930'
CATALOG = ROOT / '.local-data/cslink/legacy-as-catalog-v1'
OUTPUT = ROOT / '.local-data/cslink/historical-as-v1'
OLD_CSV = 'scraped_data/historic_games_list.csv'


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode()


def file_record(raw):
    return {'bytes': len(raw), 'sha256': sha(raw)}


def read_old_staging(local_review_path=LOCAL_REVIEW):
    version = json.loads(local_review_path.read_text())['version']
    version_dir = ROOT / '.local-data/cslink/versions' / version
    manifest = json.loads((version_dir / 'manifest.json').read_text())
    db_path = version_dir / 'staging.sqlite3'
    if sha(db_path.read_bytes()) != manifest['artifacts']['staging.sqlite3']:
        raise ValueError('Old staging SQLite hash differs from frozen manifest')
    return db_path, version


def make_plan(selection_path=SELECTION, source_dir=SOURCE_DIR, output_dir=OUTPUT,
              local_review_path=LOCAL_REVIEW, source_lock_path=SOURCE_LOCK,
              catalog_dir=CATALOG):
    selection_raw = Path(selection_path).read_bytes()
    selection = json.loads(selection_raw)
    if selection.get('schema_version') != 1 or selection.get('tier') not in ('A-Tier', 'S-Tier'):
        raise ValueError('Unsupported selection or non-A/S tier')
    if date.fromisoformat(selection['event_start_date']) >= date(2023, 7, 1):
        raise ValueError('This bridge only handles events before July 2023')
    source_lock = json.loads(Path(source_lock_path).read_text())
    csv_raw = (Path(source_dir) / OLD_CSV).read_bytes()
    source_info = source_lock['files'][OLD_CSV]
    if file_record(csv_raw) != {key: source_info[key] for key in ('bytes', 'sha256')}:
        raise ValueError('Frozen old CSV does not match source.lock.json')
    db_path, old_version = read_old_staging(local_review_path)
    catalog_dir = Path(catalog_dir)
    catalog_manifest = json.loads((catalog_dir / 'manifest.json').read_text())
    queue_raw = (catalog_dir / 'exact-map-queue.jsonl').read_bytes()
    if catalog_manifest.get('files', {}).get('exact-map-queue.jsonl') != file_record(queue_raw):
        raise ValueError('Exact-map queue differs from catalog manifest')
    exact_rows = {row['map_id']: row for row in
                  (json.loads(line) for line in queue_raw.splitlines() if line.strip())}
    map_ids = [entry['map_id'] for entry in selection['maps']]
    if len(map_ids) != len(set(map_ids)) or not map_ids:
        raise ValueError('Empty or duplicate selected map IDs')
    plan = []
    with sqlite3.connect(db_path) as db:
        for entry in selection['maps']:
            old = db.execute('SELECT source_url, record_json FROM maps WHERE map_id=?',
                             (entry['map_id'],)).fetchone()
            if not old:
                raise ValueError(f"Old staging lacks map {entry['map_id']}")
            url, record_raw = old
            record = json.loads(record_raw)
            catalog = exact_rows.get(entry['map_id'])
            if (record['source_url'] != url or
                    record['metadata']['event_raw'] != selection['hltv_event_name'] or
                    selection['team_name'] not in record['metadata']['teams_display'] or
                    record['review_status'] != 'unreviewed' or
                    record['structure_status'] != 'structurally_complete'):
                raise ValueError(f"Old map {entry['map_id']} has incompatible scope/structure")
            if (not catalog or catalog.get('scope_review_state') != 'candidate_exact_map_link' or
                    catalog.get('match_evidence') != 'Match/Map.stats' or
                    catalog.get('tier') != selection['tier'] or
                    catalog.get('event_name') != selection['event_name'] or
                    catalog.get('event_raw') != selection['hltv_event_name'] or
                    catalog.get('event_url') != selection['event_url'] or
                    catalog.get('source_page_url') != selection['event_url'] or
                    catalog.get('hltv_map_url') != url or
                    catalog.get('hltv_series_id') != entry['series_id'] or
                    catalog.get('record_sha256') != record['record_sha256']):
                raise ValueError(f"Exact-map event catalog disagrees for map {entry['map_id']}")
            if (catalog_manifest.get('inputs', {}).get('cached_event_pages', {}).get(
                    selection['event_url']) != catalog['source_revision_sha256']):
                raise ValueError(f"Cached event page SHA differs for map {entry['map_id']}")
            plan.append({'selected_mapstatsid': entry['map_id'],
                         'hltv_map_url': url,
                         'hltv_series_id': entry['series_id'],
                         'hltv_series_url': entry['series_url'],
                         'event_name': selection['event_name'],
                         'event_url': selection['event_url'],
                         'event_start_date': selection['event_start_date'],
                         'tier': selection['tier'],
                         'source_page_url': catalog['source_page_url'],
                         'source_revision_sha256': catalog['source_revision_sha256'],
                         'eligible_for_questions': False})
    plan.sort(key=lambda row: row['selected_mapstatsid'])
    plan_raw = ''.join(json.dumps(row, ensure_ascii=False, sort_keys=True) + '\n'
                       for row in plan).encode()
    plan_dir = Path(output_dir) / 'plan'
    plan_dir.mkdir(parents=True, exist_ok=True)
    report = {'schema_version': 1, 'event_name': selection['event_name'],
              'maps': len(plan), 'old_staging_version': old_version,
              'old_csv_sha256': source_info['sha256'],
              'exact_map_queue_sha256': sha(queue_raw),
              'selection_sha256': sha(selection_raw),
              'identity_source': 'fresh_hltv_map_capture_required',
              'review_state': 'unreviewed', 'eligible_for_questions': False}
    report_raw = encoded(report)
    correction_ledger_raw = b''
    manifest = {'schema_version': 1,
                'inputs': {'old_staging_version': old_version,
                           'old_csv_sha256': source_info['sha256'],
                           'exact_map_queue_sha256': sha(queue_raw),
                           'correction_ledger_sha256': sha(correction_ledger_raw),
                           'selection_sha256': sha(selection_raw)},
                'files': {'selected-series.jsonl': file_record(plan_raw),
                          'correction-ledger.jsonl': file_record(correction_ledger_raw),
                          'report.json': file_record(report_raw)}}
    (plan_dir / 'selected-series.jsonl').write_bytes(plan_raw)
    (plan_dir / 'correction-ledger.jsonl').write_bytes(correction_ledger_raw)
    (plan_dir / 'report.json').write_bytes(report_raw)
    (plan_dir / 'manifest.json').write_bytes(encoded(manifest))
    return report


def verify_captures(selection_path=SELECTION, output_dir=OUTPUT):
    selection = json.loads(Path(selection_path).read_text())
    plan_path = Path(output_dir) / 'plan/selected-series.jsonl'
    plan, _, _, _ = read_plan(plan_path, Path(output_dir) / 'plan/correction-ledger.jsonl')
    plans = {row['selected_mapstatsid']: row for row in plan}
    results = []
    for entry in selection['maps']:
        map_id = entry['map_id']
        raw = (Path(output_dir) / 'captures' / f'{map_id}.json').read_bytes()
        capture = json.loads(raw)
        verified = validate_capture(capture, map_id)
        plan = plans[map_id]
        if (capture['source_url'] != plan['hltv_map_url'] or
                capture.get('event_url') != plan['event_url'] or
                capture.get('hltv_series_id_from_liquipedia') != plan['hltv_series_id'] or
                capture.get('source_revision_sha256') != plan['source_revision_sha256'] or
                verified['event_as_displayed'] != selection['hltv_event_name']):
            raise ValueError(f'Capture provenance/event conflict for map {map_id}')
        team = next((team for team in verified['teams']
                     if team['name_as_displayed'] == selection['team_name']), None)
        if team is None:
            raise ValueError(f"Expected team missing in map {map_id}")
        actual_ids = {player['source_player_id'] for player in team['players']}
        expected_ids = set(entry['expected_team_player_ids'])
        if actual_ids != expected_ids:
            raise ValueError(f'Numeric roster differs for map {map_id}: {sorted(actual_ids, key=int)}')
        results.append({'map_id': map_id, 'case': entry['case'],
                        'source_url': capture['source_url'], 'capture_sha256': sha(raw),
                        'team': team, 'review_state': 'unreviewed',
                        'eligible_for_questions': False})
    return results


def build_library(selection_path=SELECTION, output_dir=OUTPUT):
    results = verify_captures(selection_path, output_dir)
    output_dir = Path(output_dir)
    report = build_candidate_library(output_dir / 'plan/selected-series.jsonl',
                                     output_dir / 'captures', output_dir / 'library',
                                     ledger_path=output_dir / 'plan/correction-ledger.jsonl')
    evidence = {'schema_version': 1, 'event': json.loads(Path(selection_path).read_text())['event_name'],
                'maps': results, 'candidate_library_version': report['version'],
                'review_state': 'unreviewed', 'eligible_for_questions': False}
    (output_dir / 'pilot-rosters.json').write_bytes(encoded(evidence))
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=('plan', 'verify', 'build'))
    parser.add_argument('--selection', type=Path, default=SELECTION)
    parser.add_argument('--source-dir', type=Path, default=SOURCE_DIR)
    parser.add_argument('--output', type=Path, default=OUTPUT)
    args = parser.parse_args()
    if args.action == 'plan':
        result = make_plan(args.selection, args.source_dir, args.output)
    elif args.action == 'verify':
        result = verify_captures(args.selection, args.output)
    else:
        result = build_library(args.selection, args.output)
    print(json.dumps(result, ensure_ascii=False, indent=2))
