#!/usr/bin/env python3
"""Rank legacy A/S map captures by *hypothetical* new teammate pairs.

No nickname-derived identity is admitted to the playable graph. The only
identity anchors are maps in the two local-play projection allowlists and the
frozen, individually verified old maps. Names are NFC-normalized but retain
case; one nickname with multiple numeric IDs is unresolved.
"""

import argparse
from collections import defaultdict, Counter
from itertools import combinations
import hashlib
import heapq
import json
from pathlib import Path
import re
import sqlite3
import unicodedata

from cslink_legacy_batch import source_match_proof
from cslink_tier_enrich import event_cache


ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / '.local-data/cslink'
CATALOG = DATA / 'legacy-as-catalog-v3'
OLD_DB = DATA / 'versions/69d3bb14fb82e70ea452/staging.sqlite3'
NEW_LIBRARY = DATA / 'candidate-library-v1'
NEW_PLAY = DATA / 'as-tier-local-play-v1'
OLD_BATCH = DATA / 'historical-as-batch-v1/current'
OUTPUT = DATA / 'legacy-pair-priority-v1'
SCHEMA = 1
EVENT_CACHE = DATA / 'legacy-as-event-pages'
SUBPAGE_CACHE = DATA / 'legacy-as-result-subpages'
# Exact alternatives attested in early CS:GO event templates. In particular,
# these do not make Inferno interchangeable with Mirage or Train with Nuke.
MAP_NAMES = {
    'anc': {'ancient'}, 'anb': {'anubis'},
    'cbl': {'cobblestone', 'cobble'}, 'cch': {'cache'},
    'd2': {'dust2', 'dustii', 'dust2se', 'dust2ce', 'dustiise'},
    'inf': {'inferno', 'infernose', 'infernoce', 'infernoes'},
    'mrg': {'mirage', 'miragece', 'miragecsgo'},
    'nuke': {'nuke', 'nukese', 'nukeve'},
    'ovp': {'overpass'}, 'trn': {'train', 'trainse'},
    'vtg': {'vertigo'},
}


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode()


def jsonl(rows):
    return ''.join(json.dumps(row, ensure_ascii=False, sort_keys=True) + '\n'
                   for row in rows).encode()


def read_jsonl(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def file_record(raw):
    return {'bytes': len(raw), 'sha256': sha(raw)}


def checked_sidecar(directory, manifest, name):
    raw = (directory / name).read_bytes()
    if manifest.get('files', {}).get(name) != file_record(raw):
        raise ValueError(f'Checksum differs for {directory / name}')
    return raw


def norm(name):
    # Never casefold: NiKo and niko are distinct HLTV identities.
    return unicodedata.normalize('NFC', name)


def pair(a, b):
    first, second = sorted((int(a), int(b)))
    if first == second:
        raise ValueError('One team cannot contain the same numeric ID twice')
    return (first, second)


def team_pairs(ids):
    if len(ids) != 5 or len(set(ids)) != 5:
        raise ValueError('A five-player team needs five distinct numeric IDs')
    return {pair(a, b) for a, b in combinations(ids, 2)}


def load_catalog(directory, old_db_path):
    manifest_raw = (directory / 'manifest.json').read_bytes()
    manifest = json.loads(manifest_raw)
    if (manifest.get('schema_version') != 1 or
            manifest.get('rule_version') != 'legacy-exact-scope-v3-official-shortname' or
            manifest.get('cutoff_exclusive') != '2023-07-13' or
            manifest.get('inputs', {}).get('legacy_db_sha256') != sha(old_db_path.read_bytes())):
        raise ValueError('Historical catalog is not bound to the frozen old database')
    rows = [json.loads(line) for line in checked_sidecar(
        directory, manifest, 'exact-map-queue.jsonl').splitlines() if line.strip()]
    cover = [json.loads(line) for line in checked_sidecar(
        directory, manifest, 'capture-cover-plan.jsonl').splitlines() if line.strip()]
    if len({r['map_id'] for r in rows}) != len(rows):
        raise ValueError('Duplicate map in exact queue')
    return manifest_raw, rows, {r['selected_mapstatsid']: r for r in cover}


def load_projected_library(library_dir, projection_dir):
    library_dir, projection_dir = library_dir.resolve(), projection_dir.resolve()
    library_manifest_raw = (library_dir / 'manifest.json').read_bytes()
    library_manifest = json.loads(library_manifest_raw)
    db_raw = checked_sidecar(library_dir, library_manifest, 'library.sqlite3')
    projection_raw = (projection_dir / 'manifest.json').read_bytes()
    projection = json.loads(projection_raw)
    if (projection.get('schema_version') != 1 or
            projection.get('candidate_manifest_sha256') != sha(library_manifest_raw) or
            projection.get('candidate_db_sha256') != sha(db_raw) or
            projection.get('candidate_version') != library_manifest.get('version')):
        raise ValueError(f'Projection does not bind the library: {projection_dir}')
    selected = set(projection['included_map_ids'])
    if len(selected) != len(projection['included_map_ids']):
        raise ValueError('Duplicate projected map')
    db = sqlite3.connect(f'file:{library_dir / "library.sqlite3"}?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    maps = {r['map_id']: dict(r) for r in db.execute('SELECT map_id,event_url FROM maps')
            if r['map_id'] in selected}
    if len(maps) != len(selected):
        raise ValueError('Projected map missing from candidate library')
    by_map = defaultdict(lambda: defaultdict(list))
    names = defaultdict(set)
    for r in db.execute('SELECT map_id,team_name,nickname,player_id FROM appearances'):
        if r['map_id'] not in selected:
            continue
        player_id = r['player_id']
        if not re.fullmatch(r'[1-9][0-9]*', player_id):
            raise ValueError('Projected appearance has no numeric ID')
        by_map[r['map_id']][r['team_name']].append((norm(r['nickname']), player_id))
        names[norm(r['nickname'])].add(player_id)
    pairs = set()
    for map_id, groups in by_map.items():
        if len(groups) != 2 or sorted(map(len, groups.values())) != [5, 5]:
            raise ValueError(f'Projected map is not five versus five: {map_id}')
        all_ids = [pid for people in groups.values() for _, pid in people]
        if len(set(all_ids)) != 10:
            raise ValueError(f'Projected map repeats a player: {map_id}')
        for people in groups.values():
            pairs.update(team_pairs([pid for _, pid in people]))
    if len(by_map) != len(selected):
        raise ValueError('Projected appearance count differs from map allowlist')
    db.close()
    inputs = {'library_manifest_sha256': sha(library_manifest_raw),
              'library_db_sha256': sha(db_raw), 'projection_manifest_sha256': sha(projection_raw),
              'included_maps': len(selected)}
    return selected, maps, by_map, names, pairs, inputs


def load_reviewed(old_db):
    people = {}
    names = defaultdict(set)
    for r in old_db.execute('SELECT player_id,nickname,record_json FROM players'):
        person = json.loads(r['record_json'])
        pid = str(person.get('external_ids', {}).get('hltv', ''))
        if not re.fullmatch(r'[1-9][0-9]*', pid):
            raise ValueError('Reviewed person lacks HLTV numeric ID')
        people[r['player_id']] = pid
        names[norm(r['nickname'])].add(pid)
    reviewed = {r['map_id'] for r in old_db.execute(
        "SELECT map_id FROM maps WHERE review_status='verified'")}
    pairs = set()
    for r in old_db.execute('SELECT e.player_a,e.player_b FROM teammate_evidence e '
                            'JOIN maps m ON m.map_id=e.map_id '
                            "WHERE m.review_status='verified'"):
        pairs.add(pair(people[r['player_a']], people[r['player_b']]))
    return reviewed, names, pairs


def load_old_groups(old_db, map_ids):
    by_map = defaultdict(lambda: defaultdict(list))
    # The frozen staging DB has no map_id index on appearances. Scan once.
    for r in old_db.execute('SELECT map_id,group_no,slot,nickname_raw FROM appearances '
                            'ORDER BY map_id,group_no,slot'):
        if r['map_id'] in map_ids:
            by_map[r['map_id']][r['group_no']].append(norm(r['nickname_raw']))
    return by_map


def load_old_metadata(old_db, map_ids):
    metadata = {}
    for r in old_db.execute('SELECT map_id,source_url,record_sha256,record_json FROM maps'):
        if r['map_id'] not in map_ids:
            continue
        record = json.loads(r['record_json'])
        metadata[r['map_id']] = {'source_url': r['source_url'],
                                  'record_sha256': r['record_sha256'],
                                  **record.get('metadata', {})}
    return metadata


def audit_single_map_source(row, old, page_cache, event_cache_dir=EVENT_CACHE,
                            subpage_cache_dir=SUBPAGE_CACHE):
    """Recompute LP map/date/score/name proof, quarantining ambiguous links."""
    if old is None or row['hltv_map_url'] != old['source_url'] or \
            row['record_sha256'] != old['record_sha256']:
        return 'frozen_old_record_mismatch'
    source_url = row['source_page_url']
    if source_url not in page_cache:
        directory = event_cache_dir if source_url == row['event_url'] else subpage_cache_dir
        loaded = event_cache(directory, source_url)
        if loaded is None:
            return 'liquipedia_source_page_missing'
        wiki, meta = loaded
        page_cache[source_url] = (wiki, meta['sha256'])
    wiki, source_sha = page_cache[source_url]
    if source_sha != row['source_revision_sha256']:
        return 'liquipedia_source_revision_mismatch'
    try:
        proof = source_match_proof(wiki, row['map_id'], row['hltv_series_id'])
    except (ValueError, KeyError, TypeError):
        return 'liquipedia_map_proof_nonunique_or_incomplete'
    if proof['match_date'] != row['liquipedia_match_date']:
        return 'liquipedia_match_date_mismatch'
    old_scores = old.get('score')
    if (not isinstance(old_scores, list) or len(old_scores) != 2 or
            not all(type(x) is int for x in old_scores) or
            sorted(old_scores) != sorted(proof['map_scores'])):
        return 'liquipedia_score_disagrees_with_old_map'
    old_map = old.get('map_raw')
    lp_map = re.sub(r'[^a-z0-9]', '', proof['map_name'].casefold())
    if lp_map not in MAP_NAMES.get(old_map, set()):
        return 'liquipedia_map_name_disagrees_with_old_map'
    return None


def build_event_anchors(history_maps, history_groups):
    anchors = defaultdict(lambda: defaultdict(set))
    proof = defaultdict(set)
    for map_id, groups in history_groups.items():
        event_url = history_maps[map_id]['event_url']
        for people in groups.values():
            mapping = tuple(sorted(people))
            signature = tuple(sorted(name for name, _ in people))
            anchors[(event_url, signature)][mapping].add(map_id)
            proof[(event_url, signature)].add(map_id)
    return anchors, proof


def resolve_group(names, event_url, anchors, global_names):
    if len(names) != 5 or len(set(names)) != 5:
        return {'status': 'invalid_five_names', 'ids': [], 'unknown': [], 'ambiguous': {}}
    key = (event_url, tuple(sorted(names)))
    observed = anchors.get(key, {})
    if len(observed) > 1:
        return {'status': 'conflicting_same_event_anchors', 'ids': [],
                'unknown': [], 'ambiguous': {}}
    if observed:
        mapping = dict(next(iter(observed)))
        return {'status': 'same_event_exact_five', 'ids': [mapping[n] for n in names],
                'unknown': [], 'ambiguous': {},
                'anchor_map_ids': sorted(next(iter(observed.values())))}
    unknown = [n for n in names if not global_names.get(n)]
    ambiguous = {n: sorted(global_names[n], key=int) for n in names
                 if len(global_names.get(n, ())) > 1}
    ids = [next(iter(global_names[n])) if len(global_names.get(n, ())) == 1 else None
           for n in names]
    if len(set(pid for pid in ids if pid is not None)) != len([pid for pid in ids if pid is not None]):
        return {'status': 'duplicate_candidate_ids', 'ids': ids,
                'unknown': unknown, 'ambiguous': ambiguous}
    return {'status': 'global_exact_name_hypothesis' if all(ids) else 'unresolved_names',
            'ids': ids, 'unknown': unknown, 'ambiguous': ambiguous}


def classify_map(row, groups, anchors, global_names, baseline):
    result = {'map_id': row['map_id'], 'hltv_map_url': row['hltv_map_url'],
              'event_url': row['event_url'], 'date_raw': row['date_raw'], 'tier': row['tier'],
              'group_results': []}
    if set(groups) != {1, 2} or any(len(groups[n]) != 5 for n in (1, 2)):
        result['status'] = 'missing_ten_old_appearances'
        return result, set()
    if len(set(groups[1] + groups[2])) != 10:
        result['status'] = 'duplicate_old_nicknames_across_teams'
        return result, set()
    predicted = set()
    all_ids = []
    for group_no in (1, 2):
        resolved = resolve_group(groups[group_no], row['event_url'], anchors, global_names)
        result['group_results'].append({'group_no': group_no, 'nicknames': groups[group_no], **resolved})
        all_ids.extend(pid for pid in resolved['ids'] if pid)
        if resolved['status'] in ('same_event_exact_five', 'global_exact_name_hypothesis'):
            predicted.update(team_pairs(resolved['ids']))
        else:
            # Partial pair estimates help triage unknown nicknames, but never
            # qualify the map for the full-ten greedy capture plan.
            known = [pid for pid in resolved['ids'] if pid]
            predicted.update(pair(a, b) for a, b in combinations(known, 2))
    if len(all_ids) != len(set(all_ids)):
        result['status'] = 'duplicate_candidate_ids_across_teams'
        return result, set()
    result['known_pair_count'] = len(predicted)
    result['existing_known_pair_count'] = len(predicted & baseline)
    new_pairs = predicted - baseline
    result['potential_new_pair_count'] = len(new_pairs)
    result['unknown_nicknames'] = sorted({n for group in result['group_results']
                                           for n in group['unknown']})
    result['ambiguous_nicknames'] = {n: ids for group in result['group_results']
                                    for n, ids in group['ambiguous'].items()}
    result['same_event_anchor_groups'] = sum(
        group['status'] == 'same_event_exact_five' for group in result['group_results'])
    result['status'] = ('full_ten_name_hypothesis' if all(group['status'] in
                       ('same_event_exact_five', 'global_exact_name_hypothesis')
                       for group in result['group_results']) else 'partial_identity')
    return result, new_pairs


def greedy_rank(map_pairs):
    """Lazy max-heap gives deterministic marginal coverage without O(maps²)."""
    heap = [(-len(pairs), map_id) for map_id, pairs in map_pairs.items() if pairs]
    heapq.heapify(heap)
    covered = set()
    ranked = []
    while heap:
        negative, map_id = heapq.heappop(heap)
        remaining = map_pairs[map_id] - covered
        if not remaining:
            continue
        if len(remaining) != -negative:
            heapq.heappush(heap, (-len(remaining), map_id))
            continue
        ranked.append((map_id, len(remaining), len(map_pairs[map_id])))
        covered.update(remaining)
    return ranked, covered


def plan_row(row, groups, priority):
    # The collector reads selected_mapstatsid, source URL, event URL, series ID
    # and LP source revision. Keep the richer cover shape for later audits.
    return {'selected_mapstatsid': row['map_id'], 'hltv_map_url': row['hltv_map_url'],
            'hltv_series_id': row['hltv_series_id'],
            'hltv_series_url': f"https://www.hltv.org/matches/{row['hltv_series_id']}/-",
            'event_url': row['event_url'], 'event_name': row['event_name'],
            'event_start_date': row['event_start_date'], 'tier': row['tier'],
            'source_page_url': row['source_page_url'],
            'source_revision_sha256': row['source_revision_sha256'],
            'legacy_record_sha256': row['record_sha256'],
            'liquipedia_match_date': row['liquipedia_match_date'],
            'event_name_match_status': row['event_name_match_status'],
            'event_name_match_rule': row['event_name_match_rule'],
            'official_alias_evidence': row['official_alias_evidence'],
            'raw_nickname_groups_unassigned': [sorted(groups[n]) for n in (1, 2)],
            'roster_status': 'unverified', 'eligible_for_questions': False,
            'selection_reason': 'greedy_unverified_identity_pair_novelty',
            'priority_rank': priority['rank'],
            'hypothetical_marginal_new_pairs': priority['marginal_new_pairs']}


def build(catalog_dir=CATALOG, old_db_path=OLD_DB, new_library_dir=NEW_LIBRARY,
          new_play_dir=NEW_PLAY, old_batch_dir=OLD_BATCH, output_root=OUTPUT,
          top_n=50):
    if top_n < 1:
        raise ValueError('top_n must be positive')
    catalog_dir, old_db_path = Path(catalog_dir), Path(old_db_path)
    old_batch_dir = Path(old_batch_dir).resolve()  # Freeze the moving current symlink.
    catalog_manifest_raw, queue, cover = load_catalog(catalog_dir, old_db_path)
    new_ids, _, _, new_names, new_pairs, new_input = load_projected_library(
        Path(new_library_dir), Path(new_play_dir))
    history_ids, history_maps, history_groups, history_names, history_pairs, old_input = \
        load_projected_library(old_batch_dir / 'library', old_batch_dir / 'play')
    batch_report_raw = checked_sidecar(old_batch_dir,
                                       json.loads((old_batch_dir / 'manifest.json').read_bytes()),
                                       'batch-report.json')
    batch_report = json.loads(batch_report_raw)
    blocked = {r['map_id']: r['reason'] for r in batch_report['rejected_captures']}
    blocked.update({r['map_id']: r['reason'] for r in batch_report['failed_capture_attempts']
                    if r['status'] in ('validation_failed', 'capture_unusable')})
    old_db = sqlite3.connect(f'file:{old_db_path}?mode=ro', uri=True)
    old_db.row_factory = sqlite3.Row
    reviewed_ids, reviewed_names, reviewed_pairs = load_reviewed(old_db)
    baseline = new_pairs | history_pairs | reviewed_pairs
    global_names = defaultdict(set)
    for source in (new_names, history_names, reviewed_names):
        for name, ids in source.items():
            global_names[name].update(ids)
    anchors, anchor_proof = build_event_anchors(history_maps, history_groups)
    exact = {r['map_id']: r for r in queue}
    old_groups = load_old_groups(old_db, set(exact))
    old_metadata = load_old_metadata(old_db, set(exact))
    old_db.close()
    status = Counter()
    lp_rejections = []
    page_cache = {}
    classified, candidate_pairs, conflicts, deferred = {}, {}, [], []
    double_anchored_deferred = []
    for map_id, row in sorted(exact.items()):
        if row['structure_status'] != 'structurally_complete':
            status['quarantined_structure'] += 1
            continue
        if map_id in history_ids:
            status['already_loaded_historical'] += 1
            continue
        if map_id in reviewed_ids:
            status['already_verified'] += 1
            continue
        if map_id in blocked:
            status['known_failed_capture_or_score'] += 1
            conflicts.append({'map_id': map_id, 'reason': 'known_failed_capture_or_score',
                              'detail': blocked[map_id], 'hltv_map_url': row['hltv_map_url']})
            continue
        lp_reason = audit_single_map_source(row, old_metadata.get(map_id), page_cache)
        if lp_reason:
            status[lp_reason] += 1
            lp_rejections.append({'map_id': map_id, 'reason': lp_reason,
                                  'hltv_map_url': row['hltv_map_url'],
                                  'source_page_url': row['source_page_url']})
            continue
        result, pairs = classify_map(row, old_groups.get(map_id, {}), anchors,
                                     global_names, baseline)
        status[result['status']] += 1
        classified[map_id] = result
        if result['status'].startswith(('missing_', 'duplicate_')):
            conflicts.append(result)
        if result['status'] == 'full_ten_name_hypothesis' and pairs:
            candidate_pairs[map_id] = pairs
        elif result['status'] == 'full_ten_name_hypothesis' and not pairs:
            # Safe as a pair-coverage estimate, not a proof that the old map
            # itself has been verified.
            deferred.append(result)
            if result['same_event_anchor_groups'] == 2:
                double_anchored_deferred.append(result)
    ranked, greedy_pairs = greedy_rank(candidate_pairs)
    priorities = []
    ranked_ids = set()
    for rank, (map_id, gain, initial) in enumerate(ranked, 1):
        ranked_ids.add(map_id)
        result = classified[map_id]
        priorities.append({'rank': rank, **result,
                           'initial_new_pairs': initial, 'marginal_new_pairs': gain,
                           'priority_reason': 'positive_greedy_pair_gain'})
    # Maps with partial identities are retained for a separate discovery pass.
    partial = sorted((r for r in classified.values() if r['status'] == 'partial_identity'),
                     key=lambda r: (-r['potential_new_pair_count'],
                                    -len(r['unknown_nicknames']) - len(r['ambiguous_nicknames']),
                                    -r['same_event_anchor_groups'], r['map_id']))
    start_rank = len(priorities)
    priorities.extend({'rank': start_rank + i, **r,
                       'initial_new_pairs': r['potential_new_pair_count'],
                       'marginal_new_pairs': None,
                       'priority_reason': 'partial_identity_needs_discovery'}
                      for i, r in enumerate(partial, 1))
    greedy_deferred = sorted((classified[map_id] for map_id in candidate_pairs
                              if map_id not in ranked_ids),
                             key=lambda r: (-r['potential_new_pair_count'], r['map_id']))
    start_rank = len(priorities)
    priorities.extend({'rank': start_rank + i, **r,
                       'initial_new_pairs': r['potential_new_pair_count'],
                       'marginal_new_pairs': 0,
                       'priority_reason': 'predicted_pairs_covered_by_earlier_plan'}
                      for i, r in enumerate(greedy_deferred, 1))
    if (len(ranked) + len(greedy_deferred) != len(candidate_pairs) or
            [r['rank'] for r in priorities] != list(range(1, len(priorities) + 1))):
        raise ValueError('Capture-priority rows are incomplete or misranked')
    top = priorities[:min(top_n, len(ranked))]
    top_plan = [plan_row(exact[r['map_id']], old_groups[r['map_id']], r) for r in top]
    source_inputs = {'catalog_manifest_sha256': sha(catalog_manifest_raw),
                     'old_db_sha256': sha(old_db_path.read_bytes()),
                     'old_batch_version_dir': str(old_batch_dir),
                     'old_batch_manifest_sha256': sha((old_batch_dir / 'manifest.json').read_bytes()),
                     'old_batch_report_sha256': sha(batch_report_raw),
                     'new': new_input, 'historical': old_input}
    report = {'schema_version': SCHEMA, 'identity_state': 'hypothesis_for_capture_priority_only',
              'eligible_for_questions': False, 'catalog_exact_maps': len(queue),
              'baseline_included_new_maps': len(new_ids),
              'baseline_included_historical_maps': len(history_ids),
              'baseline_reviewed_old_maps': len(reviewed_ids),
              'baseline_distinct_pairs': len(baseline),
              'global_exact_nicknames': len(global_names),
              'global_ambiguous_nicknames': sum(len(ids) > 1 for ids in global_names.values()),
              'same_event_five_signature_keys': len(anchors),
              'same_event_conflicting_keys': sum(len(v) > 1 for v in anchors.values()),
              'classification': dict(sorted(status.items())),
              'full_ten_with_initial_new_pairs': len(candidate_pairs),
              'full_ten_with_no_new_pair_hypothesis': len(deferred),
              'double_same_event_anchored_no_new_pair': len(double_anchored_deferred),
              'greedy_distinct_hypothetical_new_pairs': len(greedy_pairs),
              'greedy_positive_gain_maps': len(ranked),
              'greedy_deferred_maps': len(greedy_deferred),
              'top_plan_count': len(top_plan),
              'top_plan_hypothetical_marginal_pairs': sum(r['marginal_new_pairs'] for r in top),
              'method': 'NFC case-sensitive; one nickname to multiple observed IDs is unresolved; '
                        'same-event exact five-name roster has priority; all old-map assignments remain unverified'}
    files = {'priority.jsonl': jsonl(priorities),
             'partial-identity.jsonl': jsonl(partial),
             'deferred-after-greedy.jsonl': jsonl(greedy_deferred),
             'deferred-no-new-pair-hypothesis.jsonl': jsonl(deferred),
             'deferred-double-anchored.jsonl': jsonl(double_anchored_deferred),
             'conflicts.jsonl': jsonl(conflicts),
             'liquipedia-rejections.jsonl': jsonl(lp_rejections),
             f'top-{top_n}-collector-plan.jsonl': jsonl(top_plan),
             'report.json': encoded(report)}
    manifest = {'schema_version': SCHEMA, 'inputs': source_inputs,
                'builder_sha256': sha(Path(__file__).read_bytes()),
                'files': {name: file_record(raw) for name, raw in files.items()}}
    version = sha(encoded(manifest))[:20]
    output_dir = Path(output_root) / 'versions' / version
    output_dir.mkdir(parents=True, exist_ok=True)
    for name, raw in files.items():
        path = output_dir / name
        if path.exists() and path.read_bytes() != raw:
            raise ValueError(f'Immutable output collision: {path}')
        path.write_bytes(raw)
    (output_dir / 'manifest.json').write_bytes(encoded(manifest))
    return output_dir, report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--catalog', type=Path, default=CATALOG)
    parser.add_argument('--old-db', type=Path, default=OLD_DB)
    parser.add_argument('--new-library', type=Path, default=NEW_LIBRARY)
    parser.add_argument('--new-play', type=Path, default=NEW_PLAY)
    parser.add_argument('--old-batch', type=Path, default=OLD_BATCH)
    parser.add_argument('--output', type=Path, default=OUTPUT)
    parser.add_argument('--top', type=int, default=50)
    args = parser.parse_args()
    directory, report = build(args.catalog, args.old_db, args.new_library,
                              args.new_play, args.old_batch, args.output, args.top)
    print(json.dumps({'output_dir': str(directory), **report}, ensure_ascii=False, indent=2))
