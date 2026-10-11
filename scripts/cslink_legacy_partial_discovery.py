#!/usr/bin/env python3
"""Make a small, source-audited discovery queue from frozen partial identities.

All nickname-to-player assignments remain hypotheses. This script only ranks
HLTV map captures; it never writes to a candidate library or playable graph.
"""

import argparse
from itertools import combinations
import json
from pathlib import Path
import sqlite3

import cslink_legacy_pair_priority as priority


DATA = priority.DATA
OUTPUT = DATA / 'legacy-partial-discovery-v1'
SCHEMA = 1
LANES = ('unknown', 'ambiguous', 'known_pair')


def load_frozen(priority_dir, catalog_dir, old_db_path, new_library_dir, new_play_dir):
    """Check every input that affects map admission or known-pair ranking."""
    priority_dir = Path(priority_dir)
    manifest_raw = (priority_dir / 'manifest.json').read_bytes()
    manifest = json.loads(manifest_raw)
    if manifest.get('schema_version') != 1:
        raise ValueError('Unsupported frozen priority schema')
    report = json.loads(priority.checked_sidecar(priority_dir, manifest, 'report.json'))
    raw = priority.checked_sidecar(priority_dir, manifest, 'partial-identity.jsonl')
    partial = [json.loads(line) for line in raw.splitlines() if line.strip()]
    if (report.get('identity_state') != 'hypothesis_for_capture_priority_only' or
            report.get('classification', {}).get('partial_identity') != len(partial) or
            len({row['map_id'] for row in partial}) != len(partial) or
            any(row['status'] != 'partial_identity' for row in partial)):
        raise ValueError('Frozen partial identities disagree with priority report')
    inputs = manifest['inputs']
    catalog_raw, queue, _ = priority.load_catalog(Path(catalog_dir), Path(old_db_path))
    if (priority.sha(catalog_raw) != inputs['catalog_manifest_sha256'] or
            priority.sha(Path(old_db_path).read_bytes()) != inputs['old_db_sha256']):
        raise ValueError('Priority catalog or historical database has changed')
    old_batch_dir = Path(inputs['old_batch_version_dir'])
    if (priority.sha((old_batch_dir / 'manifest.json').read_bytes()) !=
            inputs['old_batch_manifest_sha256'] or
            priority.sha(priority.checked_sidecar(
                old_batch_dir, json.loads((old_batch_dir / 'manifest.json').read_bytes()),
                'batch-report.json')) != inputs['old_batch_report_sha256']):
        raise ValueError('Historical batch no longer matches frozen priority')
    _, _, _, _, new_pairs, new_inputs = priority.load_projected_library(
        Path(new_library_dir), Path(new_play_dir))
    _, _, _, _, historical_pairs, historical_inputs = priority.load_projected_library(
        old_batch_dir / 'library', old_batch_dir / 'play')
    if new_inputs != inputs['new'] or historical_inputs != inputs['historical']:
        raise ValueError('Projected libraries no longer match frozen priority')
    with sqlite3.connect(f'file:{Path(old_db_path)}?mode=ro', uri=True) as old_db:
        old_db.row_factory = sqlite3.Row
        _, _, reviewed_pairs = priority.load_reviewed(old_db)
    baseline = new_pairs | historical_pairs | reviewed_pairs
    if len(baseline) != report['baseline_distinct_pairs']:
        raise ValueError('Rebuilt pair baseline disagrees with priority report')
    exact = {row['map_id']: row for row in queue}
    if any(row['map_id'] not in exact for row in partial):
        raise ValueError('Partial map missing from frozen exact catalog')
    return partial, exact, baseline, {
        'priority_manifest_sha256': priority.sha(manifest_raw),
        'catalog_manifest_sha256': priority.sha(catalog_raw),
        'old_db_sha256': inputs['old_db_sha256'],
        'old_batch_version_dir': str(old_batch_dir),
        'new_projection_manifest_sha256': inputs['new']['projection_manifest_sha256'],
        'historical_projection_manifest_sha256':
            inputs['historical']['projection_manifest_sha256'],
    }


def candidate(row, baseline):
    """Keep event-local identity targets separate from numeric pair hypotheses."""
    if len(row['group_results']) != 2 or {g['group_no'] for g in row['group_results']} != {1, 2}:
        raise ValueError(f'Partial map has no two old roster groups: {row["map_id"]}')
    unresolved = [group for group in row['group_results']
                  if group['status'] == 'unresolved_names']
    if not unresolved:
        raise ValueError(f'Partial map has no unresolved group: {row["map_id"]}')
    event = row['event_url']
    signatures = {(event, tuple(sorted(group['nicknames']))) for group in unresolved}
    unknown = {(event, name) for name in row['unknown_nicknames']}
    ambiguous = {(event, name) for name in row['ambiguous_nicknames']}
    ambiguous_names = set(row['ambiguous_nicknames'])
    all_known_pairs = set()
    for group in row['group_results']:
        names, ids = group['nicknames'], group['ids']
        if len(names) != 5 or len(ids) != 5 or len(set(names)) != 5:
            raise ValueError(f'Invalid five-player hypothesis: {row["map_id"]}')
        numeric = [player_id for player_id in ids if player_id is not None]
        if len(numeric) != len(set(numeric)):
            raise ValueError(f'Repeated hypothesized player ID: {row["map_id"]}')
        all_known_pairs.update(priority.pair(a, b) for a, b in combinations(numeric, 2))
    pair_hypotheses = all_known_pairs - baseline
    if len(pair_hypotheses) != row['potential_new_pair_count']:
        raise ValueError(f'Known-pair hypotheses disagree with priority: {row["map_id"]}')
    return {'row': row, 'signatures': signatures, 'unknown': unknown,
            'ambiguous': ambiguous, 'ambiguous_names': ambiguous_names,
            'pair_hypotheses': pair_hypotheses}


def rank_candidates(candidates, budgets):
    """Greedy lane quotas diversify unknown, ambiguous and known-pair work."""
    if set(budgets) != set(LANES) or any(type(value) is not int or value < 0
                                         for value in budgets.values()):
        raise ValueError('Use nonnegative integer budgets for all discovery lanes')
    remaining = {item['row']['map_id']: item for item in candidates}
    covered = {'signatures': set(), 'unknown': set(), 'ambiguous': set(),
               'ambiguous_names': set(),
               'pair_hypotheses': set()}
    selected = []
    for lane in LANES:
        for _ in range(budgets[lane]):
            best = None
            for map_id, item in remaining.items():
                gain = {key: item[key] - covered[key] for key in covered}
                if not gain['signatures']:
                    continue
                if lane == 'unknown':
                    score = (len(gain['unknown']), len(gain['signatures']),
                             len(gain['ambiguous']), len(gain['pair_hypotheses']), -map_id)
                elif lane == 'ambiguous':
                    score = (len(gain['ambiguous_names']), len(gain['ambiguous']),
                             len(gain['signatures']), len(gain['unknown']),
                             len(gain['pair_hypotheses']), -map_id)
                else:
                    score = (len(gain['pair_hypotheses']), len(gain['signatures']),
                             len(gain['unknown']), len(gain['ambiguous']), -map_id)
                if score[0] == 0:
                    continue
                if best is None or score > best[0]:
                    best = (score, item, gain)
            if best is None:
                break
            score, item, gain = best
            row = item['row']
            selected.append({'rank': len(selected) + 1, 'lane': lane,
                             'map_id': row['map_id'], 'score': list(score[:-1]),
                             'new_unresolved_rosters': len(gain['signatures']),
                             'new_unknown_event_names': len(gain['unknown']),
                             'new_ambiguous_event_names': len(gain['ambiguous']),
                             'new_global_ambiguous_names': len(gain['ambiguous_names']),
                             'marginal_known_pair_hypotheses': len(gain['pair_hypotheses']),
                             'initial_known_pair_hypotheses': len(item['pair_hypotheses'])})
            del remaining[row['map_id']]
            for key in covered:
                covered[key].update(item[key])
    return selected, covered


def collector_row(catalog_row, partial_row, selected):
    """Match the existing collector contract without suggesting verified IDs."""
    return {
        'selected_mapstatsid': catalog_row['map_id'],
        'hltv_map_url': catalog_row['hltv_map_url'],
        'hltv_series_id': catalog_row['hltv_series_id'],
        'hltv_series_url': f"https://www.hltv.org/matches/{catalog_row['hltv_series_id']}/-",
        'event_url': catalog_row['event_url'], 'event_name': catalog_row['event_name'],
        'event_start_date': catalog_row['event_start_date'], 'tier': catalog_row['tier'],
        'source_page_url': catalog_row['source_page_url'],
        'source_revision_sha256': catalog_row['source_revision_sha256'],
        'legacy_record_sha256': catalog_row['record_sha256'],
        'liquipedia_match_date': catalog_row['liquipedia_match_date'],
        'event_name_match_status': catalog_row['event_name_match_status'],
        'event_name_match_rule': catalog_row['event_name_match_rule'],
        'official_alias_evidence': catalog_row['official_alias_evidence'],
        'raw_nickname_groups_unassigned': [sorted(group['nicknames']) for group
                                           in sorted(partial_row['group_results'],
                                                         key=lambda group: group['group_no'])],
        'roster_status': 'unverified', 'eligible_for_questions': False,
        'selection_reason': 'partial_identity_discovery_source_audited',
        'discovery_lane': selected['lane'], 'discovery_rank': selected['rank'],
        'unresolved_identity_state': 'unknown_or_ambiguous',
    }


def build(priority_dir, catalog_dir=priority.CATALOG, old_db_path=priority.OLD_DB,
          new_library_dir=priority.NEW_LIBRARY, new_play_dir=priority.NEW_PLAY,
          output_root=OUTPUT, unknown=5, ambiguous=4, known_pair=3):
    partial, exact, baseline, inputs = load_frozen(
        priority_dir, catalog_dir, old_db_path, new_library_dir, new_play_dir)
    candidates = [candidate(row, baseline) for row in partial]
    budgets = {'unknown': unknown, 'ambiguous': ambiguous, 'known_pair': known_pair}
    selected, covered = rank_candidates(candidates, budgets)
    by_id = {row['map_id']: row for row in partial}
    selected_ids = {row['map_id'] for row in selected}
    with sqlite3.connect(f'file:{Path(old_db_path)}?mode=ro', uri=True) as old_db:
        old_db.row_factory = sqlite3.Row
        old_metadata = priority.load_old_metadata(old_db, selected_ids)
        old_groups = priority.load_old_groups(old_db, selected_ids)
    page_cache = {}
    plan = []
    for item in selected:
        map_id = item['map_id']
        row, partial_row = exact[map_id], by_id[map_id]
        actual_groups = old_groups.get(map_id, {})
        if (set(actual_groups) != {1, 2} or
                any(actual_groups[group['group_no']] != group['nicknames']
                    for group in partial_row['group_results'])):
            raise ValueError(f'Frozen old roster differs from partial report: {map_id}')
        reason = priority.audit_single_map_source(row, old_metadata.get(map_id), page_cache)
        if reason is not None:
            raise ValueError(f'Failed current local source audit for map {map_id}: {reason}')
        item['source_audit'] = 'passed_unique_map_date_score_name_and_old_record'
        item['source_page_url'] = row['source_page_url']
        item['source_revision_sha256'] = row['source_revision_sha256']
        item['legacy_record_sha256'] = row['record_sha256']
        plan.append(collector_row(row, partial_row, item))
    report = {
        'schema_version': SCHEMA, 'identity_state': 'unverified_capture_discovery_only',
        'eligible_for_questions': False, 'frozen_partial_maps': len(partial),
        'selection_budgets': budgets, 'selected_maps': len(selected),
        'selected_by_lane': {lane: sum(item['lane'] == lane for item in selected)
                             for lane in LANES},
        'new_unresolved_event_rosters': len(covered['signatures']),
        'new_unknown_event_names': len(covered['unknown']),
        'new_ambiguous_event_names': len(covered['ambiguous']),
        'new_global_ambiguous_names': len(covered['ambiguous_names']),
        'marginal_known_pair_hypotheses': len(covered['pair_hypotheses']),
        'source_audited_selected_maps': len(plan),
        'method': ('NFC case-sensitive; greedy lane order unknown, ambiguous, known_pair; '
                   'maximize new event-local unknown nicknames, then previously untouched '
                   'globally ambiguous nicknames, then marginal hypothetical known pairs; '
                   'within each lane prefer new event-local five-name rosters; '
                   'selected map sources rechecked against frozen old record and local Liquipedia '
                   'revision/date/score/map-name proof; no nickname IDs admitted to playable graph'),
    }
    files = {'collector-plan.jsonl': priority.jsonl(plan),
             'selection-audit.jsonl': priority.jsonl(selected),
             'report.json': priority.encoded(report)}
    manifest = {'schema_version': SCHEMA, 'inputs': inputs,
                'builder_sha256': priority.sha(Path(__file__).read_bytes()),
                'files': {name: priority.file_record(raw) for name, raw in files.items()}}
    version = priority.sha(priority.encoded(manifest))[:20]
    output_dir = Path(output_root) / 'versions' / version
    output_dir.mkdir(parents=True, exist_ok=True)
    for name, raw in files.items():
        path = output_dir / name
        if path.exists() and path.read_bytes() != raw:
            raise ValueError(f'Immutable output collision: {path}')
        path.write_bytes(raw)
    (output_dir / 'manifest.json').write_bytes(priority.encoded(manifest))
    return output_dir, report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--priority-dir', type=Path, required=True)
    parser.add_argument('--catalog', type=Path, default=priority.CATALOG)
    parser.add_argument('--old-db', type=Path, default=priority.OLD_DB)
    parser.add_argument('--new-library', type=Path, default=priority.NEW_LIBRARY)
    parser.add_argument('--new-play', type=Path, default=priority.NEW_PLAY)
    parser.add_argument('--output', type=Path, default=OUTPUT)
    parser.add_argument('--unknown', type=int, default=5)
    parser.add_argument('--ambiguous', type=int, default=4)
    parser.add_argument('--known-pair', type=int, default=3)
    args = parser.parse_args()
    directory, summary = build(args.priority_dir, args.catalog, args.old_db,
                               args.new_library, args.new_play, args.output,
                               args.unknown, args.ambiguous, args.known_pair)
    print(json.dumps({'output_dir': str(directory), **summary}, ensure_ascii=False, indent=2))
