#!/usr/bin/env python3
"""Import existing legacy five-player groups and their HLTV evidence links.

This local game import accepts the old source roster without recapturing it.
Exact case-sensitive aliases may attach that roster to existing HLTV identities;
unknown/ambiguous names get an event-and-roster-scoped internal identity. No
nickname assignment is represented as an individually reviewed HLTV appearance.
"""

import argparse
from collections import Counter, defaultdict
from itertools import combinations
import json
from pathlib import Path
import re
import sqlite3

import cslink_legacy_pair_priority as priority

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / '.local-data/cslink/legacy-relations-v1'
RULE_VERSION = 'legacy-five-roster-exact-case-context-v3-per-group'
IDENTITY_RULES = {
    'version': RULE_VERSION,
    'normalization': 'NFC, case sensitive, no casefold or fuzzy matching',
    'priority': ['unique same-event exact five-name anchor',
                 'one observed HLTV ID for exact nickname',
                 'internal ID scoped to event URL, sorted five-name roster and nickname'],
    'aliases': 'same captured map, unique group with four exact common names and one changed name; union IDs and retain ambiguity',
    'relations': 'within each source five-player group only; no group-to-team-name assignment',
    'source_acceptance': ('existing A/S exact catalog and frozen HLTV map link; each five-player group is '
                          'accepted independently; score/map-name disagreements and failed recaptures are warnings'),
    'cross_team_duplicate': ('the same resolved identity on both sides: if exactly one side has its exact five-name '
                             'roster on another catalog map of the same event, the other side is dropped; otherwise '
                             'both are kept and that person gets roster-scoped IDs. A shared nickname resolving to '
                             'different IDs (or ambiguous context IDs) is not a conflict'),
}
MAP_LABELS = {'anc': 'Ancient', 'anb': 'Anubis', 'cbl': 'Cobblestone',
              'cch': 'Cache', 'd2': 'Dust2', 'inf': 'Inferno', 'mrg': 'Mirage',
              'nuke': 'Nuke', 'ovp': 'Overpass', 'trn': 'Train', 'vtg': 'Vertigo'}
# The five-player roster stays usable when only score or map labels disagree; these become warnings.
SOURCE_BLOCKERS = {'frozen_old_record_mismatch'}
# Identities confirmed by the project owner. In legacy (pre-2023-07) A/S rosters these nicknames
# always mean the given HLTV player; namesakes from newer data keep their own IDs elsewhere.
CONFIRMED_LEGACY_NICKNAMES = {'rain': '8183'}
IDENTITY_RULES['confirmedLegacyNicknames'] = CONFIRMED_LEGACY_NICKNAMES


def hltv_key(numeric_id):
    if not re.fullmatch(r'[1-9][0-9]*', str(numeric_id)):
        raise ValueError('HLTV identity must be a positive decimal ID')
    return f'hltv:{numeric_id}'


def relation_pairs(groups):
    return {tuple(sorted((a['playerId'], b['playerId'])))
            for group in groups for a, b in combinations(group, 2)}


def contextual_player(event_url, names, nickname, event_name=None):
    context = {'eventUrl': event_url, 'roster': sorted(names), 'nickname': nickname}
    context_text = json.dumps(context, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    return {'id': 'legacy:' + priority.sha(context_text.encode())[:20], 'hltvId': None,
            'nickname': nickname, 'profileUrl': None, 'identityKind': 'legacy_context',
            'identityContext': f"{event_name or event_url} · 与 {' / '.join([n for n in sorted(names) if n != nickname][:2])} 同组"}


def resolve_group(names, event_url, anchors, global_names, event_name=None):
    names = [priority.norm(n) for n in names]
    if len(names) != 5 or any(not n.strip() for n in names) or len(set(names)) != 5:
        raise ValueError('invalid_five_names')
    result = priority.resolve_group(names, event_url, anchors, global_names)
    if result['status'] in ('conflicting_same_event_anchors', 'duplicate_candidate_ids'):
        raise ValueError(result['status'])
    people, appearances = [], []
    for nickname, numeric_id in zip(names, result['ids']):
        if numeric_id is not None:
            person = {'id': hltv_key(numeric_id), 'hltvId': str(numeric_id),
                      'nickname': nickname,
                      'profileUrl': None,
                      'identityKind': 'hltv'}
            basis = ('same_event_exact_five' if result['status'] == 'same_event_exact_five'
                     else 'legacy_global_exact_nickname')
        else:
            person = contextual_player(event_url, names, nickname, event_name)
            basis = ('legacy_context_ambiguous_nickname' if global_names.get(nickname)
                     else 'legacy_context_unmapped_nickname')
        people.append(person)
        appearances.append({'playerId': person['id'], 'nickname': nickname, 'identityBasis': basis})
    return people, appearances


def group_shape_reason(names):
    if len(names) > 5:
        return 'group_more_than_five_players'
    if len(names) < 5 or any(not n.strip() for n in names):
        return 'group_missing_players'
    if len(set(names)) != 5:
        return 'group_duplicate_nickname'
    return None


def roster_key(event_url, names):
    return (event_url, tuple(sorted(names)))


def catalog_roster_index(rows, old_groups):
    """Map IDs supporting each event-scoped exact five-name roster in the old source."""
    index = defaultdict(set)
    for row in rows:
        for names in old_groups.get(row['map_id'], {}).values():
            if group_shape_reason(names) is None:
                index[roster_key(row['event_url'], names)].add(row['map_id'])
    return index


def import_map(row, metadata, groups, anchors, global_names, warnings=(), roster_index=None):
    """Resolve one source map; each five-player group is accepted or dropped on its own.

    The whole map is rejected only without its frozen HLTV link/metadata or when no group survives.
    """
    if (metadata is None or metadata.get('source_url') != row['hltv_map_url'] or
            metadata.get('record_sha256') != row['record_sha256']):
        raise ValueError('frozen_old_record_mismatch')
    source_url = metadata['source_url']
    if not re.fullmatch(r'https://www\.hltv\.org/stats/matches/mapstatsid/' + str(row['map_id']) + r'/[^?#\s]+', source_url):
        raise ValueError('invalid_hltv_map_url')
    if not groups:
        raise ValueError('no_old_roster_rows')
    if len(groups) > 2:
        raise ValueError('more_than_two_old_groups')
    opponents, score = metadata.get('teams_display'), metadata.get('score')
    if (not isinstance(opponents, list) or len(opponents) != 2 or
            any(not isinstance(x, str) or not x.strip() for x in opponents) or
            not isinstance(score, list) or len(score) != 2 or
            any(type(x) is not int or x < 0 for x in score) or
            not metadata.get('date_raw') or not metadata.get('map_raw')):
        raise ValueError('missing_match_metadata')
    dropped, kept = [], {}
    for group_no in sorted(groups):
        names = [priority.norm(n) for n in groups[group_no]]
        reason = group_shape_reason(names)
        if reason is None:
            try:
                kept[group_no] = (names, *resolve_group(
                    names, row['event_url'], anchors, global_names, row['event_name']))
            except ValueError as exc:
                reason = str(exc)
        if reason:
            dropped.append({'groupNo': group_no, 'reason': reason, 'nicknames': names})
    if not kept:
        raise ValueError('no_usable_five_player_group')
    if len(kept) == 2:
        first, second = sorted(kept)
        shared_names = set(kept[first][0]) & set(kept[second][0])
        shared_ids = {p['id'] for p in kept[first][1]} & {p['id'] for p in kept[second][1]}
        # Shared nickname with distinct resolved IDs (two different "steel") is valid; only the
        # same resolved person on both sides is a conflict worth dropping a side for.
        if shared_ids:
            index = roster_index or {}
            support = {g: sorted(index.get(roster_key(row['event_url'], kept[g][0]), set()) - {row['map_id']})
                       for g in (first, second)}
            if bool(support[first]) != bool(support[second]):
                loser = first if not support[first] else second
                dropped.append({'groupNo': loser, 'reason': 'cross_team_duplicate_uncorroborated_roster',
                                'nicknames': kept[loser][0],
                                'sharedNicknames': sorted(shared_names),
                                'sharedPlayerIds': sorted(shared_ids),
                                'otherGroupSupportMapIds': support[second if loser == first else first][:5]})
                del kept[loser]
    if len(kept) == 2:
        (names_a, people_a, apps_a), (names_b, people_b, apps_b) = (kept[g] for g in sorted(kept))
        sides = [(names_a, people_a, apps_a), (names_b, people_b, apps_b)]
        # Roster-scoped IDs already differ per side; only a shared resolved ID needs splitting.
        for pid in sorted({p['id'] for p in people_a} & {p['id'] for p in people_b}):
            # One person cannot play for both sides. Keep the HLTV ID only where an exact
            # same-event roster anchors it; otherwise split into roster-scoped identities.
            anchored = [any(a['playerId'] == pid and a['identityBasis'] == 'same_event_exact_five' for a in apps)
                        for _, _, apps in sides]
            for keep_id, (names, people, apps) in zip(
                    [anchored[0] and not anchored[1], anchored[1] and not anchored[0]], sides):
                if keep_id:
                    continue
                index = next(i for i, p in enumerate(people) if p['id'] == pid)
                people[index] = contextual_player(row['event_url'], names, apps[index]['nickname'], row['event_name'])
                apps[index] = {**apps[index], 'playerId': people[index]['id'],
                               'identityBasis': 'legacy_context_cross_team_identity_split'}
    people = [p for g in sorted(kept) for p in kept[g][1]]
    appearances = [kept[g][2] for g in sorted(kept)]
    game_map = {'mapId': row['map_id'], 'event': row['event_name'],
            'eventUrl': row['event_url'], 'tier': row['tier'],
            'map': MAP_LABELS.get(metadata['map_raw'], metadata['map_raw']),
            'dateRaw': metadata['date_raw'], 'sourceUrl': source_url,
            'sourceFingerprint': metadata['record_sha256'],
            'opponents': opponents, 'score': score, 'groups': appearances}
    if warnings:
        game_map['sourceWarnings'] = sorted(set(warnings))
    if dropped:
        game_map['droppedGroups'] = dropped
    return game_map, people


def learn_same_map_aliases(history_maps, history_groups, old_groups, old_metadata, anchors, global_names):
    """Use actual captures of the same map to bridge a single renamed handle.

    Four exact shared names identify the corresponding five-player stat block.
    Never infer across maps or by case folding, and never replace observed IDs.
    """
    evidence, rejections = [], []
    protected = {'NiKo': '3741', 'niko': '10264'}
    for map_id in sorted(history_groups):
        legacy_groups = old_groups.get(map_id, {})
        if (set(legacy_groups) != {1, 2} or
                any(len(legacy_groups[g]) != 5 for g in (1, 2)) or
                len(set(legacy_groups[1] + legacy_groups[2])) != 10):
            continue
        captured = list(history_groups[map_id].values())
        for names in legacy_groups.values():
            old_names = set(names)
            matches = [people for people in captured
                       if len(people) == 5 and len(old_names & {n for n, _ in people}) == 4]
            if len(matches) != 1:
                continue
            people = matches[0]
            actual = dict(people)
            if len(actual) != 5 or len(set(actual.values())) != 5:
                continue
            shared = old_names & set(actual)
            previous = next(iter(old_names - shared))
            current = next(iter(set(actual) - shared))
            pid = actual[current]
            record = {'mapId': map_id, 'sourceUrl': old_metadata[map_id]['source_url'],
                      'eventUrl': history_maps[map_id]['event_url'], 'legacyNickname': previous,
                      'capturedNickname': current, 'hltvId': pid, 'sharedNicknames': sorted(shared)}
            if previous in protected and pid != protected[previous]:
                rejections.append({**record, 'reason': 'protected_niko_identity_conflict'})
                continue
            global_names.setdefault(previous, set()).add(pid)
            mapping = tuple(sorted((name, pid if name == previous else actual[name]) for name in names))
            signature = (history_maps[map_id]['event_url'], tuple(sorted(names)))
            anchors[signature][mapping].add(map_id)
            evidence.append(record)
    return evidence, rejections


def canonical_hltv_profiles(library_dirs, allowed_ids):
    profiles = {}
    for directory in library_dirs:
        db = sqlite3.connect(f'file:{directory / "library.sqlite3"}?mode=ro', uri=True)
        db.row_factory = sqlite3.Row
        for r in db.execute('SELECT player_id,display_name,player_urls_json FROM players ORDER BY player_id'):
            if r['player_id'] in allowed_ids and r['player_id'] not in profiles:
                urls = json.loads(r['player_urls_json'])
                profiles[r['player_id']] = {'nickname': r['display_name'],
                                            'profileUrl': sorted(urls)[0] if urls else None}
        db.close()
    return profiles


def build(catalog_dir=priority.CATALOG, old_db_path=priority.OLD_DB,
          new_library_dir=priority.NEW_LIBRARY, new_play_dir=priority.NEW_PLAY,
          old_batch_dir=priority.OLD_BATCH, output_dir=OUTPUT):
    catalog_dir, old_db_path = Path(catalog_dir).resolve(), Path(old_db_path).resolve()
    old_batch_dir = Path(old_batch_dir).resolve()
    new_library_dir, new_play_dir = Path(new_library_dir).resolve(), Path(new_play_dir).resolve()
    catalog_raw, queue, _ = priority.load_catalog(catalog_dir, old_db_path)
    new_ids, _, _, new_names, new_pairs, new_input = priority.load_projected_library(
        new_library_dir, new_play_dir)
    history_ids, history_maps, history_groups, history_names, history_pairs, history_input = \
        priority.load_projected_library(old_batch_dir / 'library', old_batch_dir / 'play')
    batch_manifest_raw = (old_batch_dir / 'manifest.json').read_bytes()
    batch_report_raw = priority.checked_sidecar(
        old_batch_dir, json.loads(batch_manifest_raw), 'batch-report.json')
    batch_report = json.loads(batch_report_raw)
    blocked = {r['map_id']: r['reason'] for r in batch_report['rejected_captures']}
    blocked.update({r['map_id']: r['reason'] for r in batch_report['failed_capture_attempts']
                    if r['status'] in ('validation_failed', 'capture_unusable')
                    and r['map_id'] not in blocked})
    db = sqlite3.connect(f'file:{old_db_path}?mode=ro', uri=True)
    db.row_factory = sqlite3.Row
    reviewed_ids, reviewed_names, reviewed_pairs = priority.load_reviewed(db)
    reviewed_numeric_ids = {str(json.loads(r['record_json'])['external_ids']['hltv'])
        for r in db.execute(
            "SELECT DISTINCT p.record_json FROM players p JOIN appearances a ON a.player_id=p.player_id "
            "JOIN maps m ON m.map_id=a.map_id WHERE m.review_status='verified'")}
    map_ids = {r['map_id'] for r in queue}
    old_groups = priority.load_old_groups(db, map_ids)
    old_metadata = priority.load_old_metadata(db, map_ids)
    db.close()
    roster_index = catalog_roster_index(queue, old_groups)
    global_names = defaultdict(set)
    for source in (new_names, history_names, reviewed_names):
        for name, ids in source.items():
            global_names[name].update(ids)
    for name, numeric_id in CONFIRMED_LEGACY_NICKNAMES.items():
        global_names[name] = {numeric_id}
    anchors, _ = priority.build_event_anchors(history_maps, history_groups)
    alias_evidence, alias_rejections = learn_same_map_aliases(
        history_maps, history_groups, old_groups, old_metadata, anchors, global_names)
    known_ids = {pid for ids in global_names.values() for pid in ids}
    canonical = canonical_hltv_profiles([new_library_dir, old_batch_dir / 'library'], known_ids)
    status, strategy, source_warnings, page_cache = Counter(), Counter(), [], {}
    excluded, imported, players, aliases = [], [], {}, defaultdict(set)
    for row in sorted(queue, key=lambda r: r['map_id']):
        map_id = row['map_id']
        reason = None
        if map_id in history_ids:
            reason = 'already_loaded_historical'
        elif map_id in reviewed_ids:
            reason = 'already_reviewed_old'
        elif map_id in new_ids:
            reason = 'already_loaded_new'
        warnings = []
        if reason is None and map_id in blocked:
            # A failed HLTV recapture/score check does not invalidate the old five-name roster.
            warnings.append('known_failed_capture_or_score')
        if reason is None and row['structure_status'] != 'structurally_complete':
            warnings.append('quarantined_structure')
        if reason is None:
            source_reason = priority.audit_single_map_source(row, old_metadata.get(map_id), page_cache)
            if source_reason in SOURCE_BLOCKERS:
                reason = source_reason
            elif source_reason:
                warnings.append(source_reason)
                source_warnings.append({'mapId': map_id, 'reason': source_reason})
        if reason is None:
            try:
                game_map, people = import_map(row, old_metadata.get(map_id), old_groups.get(map_id, {}),
                                              anchors, global_names, warnings, roster_index)
            except ValueError as exc:
                reason = str(exc)
                if reason == 'no_old_roster_rows' and 'quarantined_structure' in warnings:
                    reason = 'quarantined_structure_no_old_roster_rows'
        if reason:
            status[reason] += 1
            excluded.append({'mapId': map_id, 'reason': reason, 'sourceUrl': row['hltv_map_url'],
                             **({'warnings': warnings} if warnings else {}),
                             **({'detail': blocked[map_id]} if map_id in blocked else {})})
            continue
        status['imported_partial_one_group' if len(game_map['groups']) == 1 else 'imported'] += 1
        if map_id in blocked:
            game_map['sourceWarningDetail'] = blocked[map_id]
        imported.append(game_map)
        for person in people:
            aliases[person['id']].add(person['nickname'])
            if person['hltvId'] in canonical:
                person.update(canonical[person['hltvId']])
            players.setdefault(person['id'], person)
        strategy.update(a['identityBasis'] for group in game_map['groups'] for a in group)
    ordered_players = [players[pid] for pid in sorted(players)]
    # All source contents, identity inputs and rules participate in the version.
    inputs = {
        'catalog': {'path': str(catalog_dir), 'manifestSha256': priority.sha(catalog_raw)},
        'legacyDatabase': {'path': str(old_db_path), 'sha256': priority.sha(old_db_path.read_bytes())},
        'newLibrary': {'path': str(new_library_dir), 'projectionPath': str(new_play_dir), **new_input},
        'historicalLibrary': {'path': str(old_batch_dir), **history_input,
                              'batchManifestSha256': priority.sha(batch_manifest_raw),
                              'batchReportSha256': priority.sha(batch_report_raw)},
    }
    graph = {'schemaVersion': 1, 'players': ordered_players, 'maps': imported}
    version = priority.sha(priority.encoded({'graph': graph, 'rules': IDENTITY_RULES, 'inputs': inputs}))[:20]
    graph['version'] = version
    imported_pairs = set().union(*(relation_pairs(m['groups']) for m in imported)) if imported else set()
    projected_pairs = {tuple(sorted((hltv_key(a), hltv_key(b)))) for a, b in new_pairs | history_pairs}
    baseline_pairs = projected_pairs | {tuple(sorted((hltv_key(a), hltv_key(b)))) for a, b in reviewed_pairs}
    projected_people = {hltv_key(pid) for names in (new_names, history_names)
                        for ids in names.values() for pid in ids}
    all_baseline_people = projected_people | {hltv_key(pid) for pid in reviewed_numeric_ids}
    contextual_appearances = Counter(
        a['nickname'] for m in imported for group in m['groups'] for a in group
        if a['playerId'].startswith('legacy:'))
    report = {
        'schemaVersion': 1, 'version': version, 'identityRules': IDENTITY_RULES,
        'catalogMaps': len(queue), 'importedMaps': len(imported),
        'importedPlayers': len(players), 'hltvPlayers': sum(p['identityKind'] == 'hltv' for p in ordered_players),
        'contextualPlayers': sum(p['identityKind'] == 'legacy_context' for p in ordered_players),
        'importedMapsWithContextualPlayers': sum(any(a['playerId'].startswith('legacy:')
                        for group in m['groups'] for a in group) for m in imported),
        'importedDistinctPairs': len(imported_pairs),
        'sourcePairEvidenceRows': sum(10 * len(m['groups']) for m in imported),
        'importedSingleGroupMaps': sum(len(m['groups']) == 1 for m in imported),
        'importedMapsWithSourceWarnings': sum(bool(m.get('sourceWarnings')) for m in imported),
        'droppedGroups': [{'mapId': m['mapId'], 'sourceUrl': m['sourceUrl'], **g}
                          for m in imported for g in m.get('droppedGroups', [])],
        'crossTeamIdentitySplits': [{'mapId': m['mapId'], 'nickname': a['nickname'], 'playerId': a['playerId']}
                                    for m in imported for group in m['groups'] for a in group
                                    if a['identityBasis'] == 'legacy_context_cross_team_identity_split'],
        'additionalDistinctPairsVsProjectedLibraries': len(imported_pairs - projected_pairs),
        'additionalDistinctPairsVsAllKnownLibraries': len(imported_pairs - baseline_pairs),
        'projectedBaseline': {'newMaps': len(new_ids), 'historicalMaps': len(history_ids),
                             'distinctPlayers': len(projected_people), 'distinctPairs': len(projected_pairs)},
        'reviewedOldMaps': len(reviewed_ids),
        'allPlayableBaseline': {'maps': len(new_ids | history_ids | reviewed_ids),
                               'players': len(all_baseline_people), 'distinctPairs': len(baseline_pairs)},
        'combinedPlayableAndImport': {'maps': len(new_ids | history_ids | reviewed_ids | {m['mapId'] for m in imported}),
            'players': len(all_baseline_people | set(players)), 'distinctPairs': len(baseline_pairs | imported_pairs)},
        'contextualPlayerAppearances': sum(contextual_appearances.values()),
        'contextualNicknameAppearanceCounts': dict(sorted(contextual_appearances.items(),
                                                          key=lambda item: (-item[1], item[0]))),
        'combinedProjectedAndImport': {'maps': len(new_ids | history_ids | {m['mapId'] for m in imported}),
            'players': len(projected_people | set(players)), 'distinctPairs': len(projected_pairs | imported_pairs)},
        'mapStatusCounts': dict(sorted(status.items())),
        'identityAppearanceStrategyCounts': dict(sorted(strategy.items())),
        'excludedMaps': excluded, 'sourceWarningsNotBlockingImport': source_warnings,
        'sameMapAliasCount': len({(r['legacyNickname'], r['hltvId']) for r in alias_evidence}),
        'sameMapAliasEvidence': alias_evidence, 'sameMapAliasRejections': alias_rejections,
        'knownAmbiguousNicknames': {name: sorted(ids, key=int) for name, ids in sorted(global_names.items())
                                  if len(ids) > 1},
        'importedIdentityAliases': {pid: sorted(names) for pid, names in sorted(aliases.items()) if len(names) > 1},
        'sources': inputs,
        'limitations': [
            'Legacy rosters and evidence URLs are reused from existing source records, not individually recaptured.',
            'A globally unique observed nickname is an import mapping, not proof that no unseen namesake exists.',
            'Context identities intentionally do not connect uncertain players across different event/roster contexts.',
            'Opponent labels and score order are match metadata; neither is assigned to a five-player group.',
            'Duplicate teammate evidence is retained per map; consumers deduplicate undirected relation pairs.',
        ],
    }
    if sum(status.values()) != len(queue):
        raise ValueError('Catalog map accounting mismatch')
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    for filename, value in [('report.json', report), ('graph.json', graph)]:
        temporary = output_dir / (filename + '.tmp')
        temporary.write_bytes(priority.encoded(value))
        temporary.replace(output_dir / filename)
    return output_dir, report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--catalog', type=Path, default=priority.CATALOG)
    parser.add_argument('--old-db', type=Path, default=priority.OLD_DB)
    parser.add_argument('--new-library', type=Path, default=priority.NEW_LIBRARY)
    parser.add_argument('--new-play', type=Path, default=priority.NEW_PLAY)
    parser.add_argument('--old-batch', type=Path, default=priority.OLD_BATCH)
    parser.add_argument('--output', type=Path, default=OUTPUT)
    args = parser.parse_args()
    directory, result = build(args.catalog, args.old_db, args.new_library, args.new_play,
                              args.old_batch, args.output)
    print(json.dumps({'output': str(directory), **{k: result[k] for k in (
        'version', 'catalogMaps', 'importedMaps', 'importedPlayers', 'hltvPlayers', 'contextualPlayers',
        'importedDistinctPairs', 'additionalDistinctPairsVsProjectedLibraries',
        'combinedProjectedAndImport', 'allPlayableBaseline', 'combinedPlayableAndImport',
        'contextualPlayerAppearances', 'sameMapAliasCount', 'mapStatusCounts', 'identityAppearanceStrategyCounts')}},
        ensure_ascii=False, indent=2))
