#!/usr/bin/env python3
"""Reproducible, offline-first CS Link staging pipeline (Python standard library).

Nickname search keys never identify people. Original statistic blocks are never
assigned to named teams without an explicit, fingerprint-bound map review.
"""
import argparse
from collections import Counter, defaultdict
import csv
from datetime import datetime
import hashlib
from itertools import combinations
import json
from pathlib import Path
import re
import shutil
import sqlite3
import tempfile
import unicodedata
import urllib.parse
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / 'data/cslink'
HISTORY = 'scraped_data/historic_games_list.csv'
DETAILS = 'scraped_data/game_data_rh.csv'
LEGACY = 'csgo_pro_games_data.csv'
EXCEPTIONS = 'scraped_data/exception_data.csv'
REQUIRED = (HISTORY, DETAILS, LEGACY, EXCEPTIONS)
NAMES = [f'team{g}_p{s}_name' for g in (1, 2) for s in range(1, 6)]
HARD_FLAGS = {'metadata_conflict', 'details_conflict', 'missing_metadata',
              'missing_details', 'missing_nickname', 'duplicate_nickname_within_group',
              'invalid_date', 'invalid_score'}


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def digest(value):
    return hashlib.sha256(encoded(value).encode()).hexdigest()


def file_hash(path):
    with Path(path).open('rb') as f:
        return hashlib.file_digest(f, 'sha256').hexdigest()


def write_json(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + '\n')


def search_key(name):
    """Only a search index, deliberately NOT an identity key."""
    return unicodedata.normalize('NFC', name.strip()).casefold()


def source_map(link):
    url = urllib.parse.urlsplit(link)
    if url.netloc and (url.scheme != 'https' or url.netloc != 'www.hltv.org'):
        raise ValueError(f'Unexpected match host: {link}')
    match = re.fullmatch(r'/stats/matches/mapstatsid/([1-9][0-9]*)/[^/\s]+/?', url.path)
    if not match or url.query or url.fragment:
        raise ValueError(f'Invalid map source link: {link}')
    return int(match.group(1)), 'https://www.hltv.org' + url.path


def number(value):
    text = (value or '').strip()
    if re.fullmatch(r'\(?\d+(?:\.0+)?\)?', text):
        return int(float(text.strip('()')))
    return None


def verify_inputs(source_dir, lock):
    for name in REQUIRED:
        expected = lock['files'][name]
        path = source_dir / name
        if not path.is_file() or path.stat().st_size != expected['bytes'] or file_hash(path) != expected['sha256']:
            raise ValueError(f'Source checksum mismatch or missing file: {path}')


def fetch(source_dir, lock):
    """Only pinned public GitHub files; never crawls match websites."""
    for name, info in sorted(lock['files'].items()):
        dest = source_dir / name
        if dest.is_file() and dest.stat().st_size == info['bytes'] and file_hash(dest) == info['sha256']:
            continue
        if dest.exists():
            raise ValueError(f'Refusing to overwrite changed source: {dest}')
        url = urllib.parse.urlsplit(info['url'])
        if url.scheme != 'https' or url.netloc != 'raw.githubusercontent.com' or f"/{lock['revision']}/" not in url.path:
            raise ValueError('Download URL must point to the pinned GitHub revision')
        dest.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=dest.parent, delete=False) as temp:
            temp_path = Path(temp.name)
        try:
            request = urllib.request.Request(info['url'], headers={'User-Agent': 'CS-Link-local-data-import/1.0'})
            with urllib.request.urlopen(request, timeout=45) as response, temp_path.open('wb') as out:
                shutil.copyfileobj(response, out)
            if temp_path.stat().st_size != info['bytes'] or file_hash(temp_path) != info['sha256']:
                raise ValueError(f'Download checksum mismatch: {name}')
            temp_path.replace(dest)
        finally:
            temp_path.unlink(missing_ok=True)
        print(f'Downloaded and verified {name}', flush=True)


def read_rows(path):
    with path.open(newline='', encoding='utf-8') as handle:
        reader = csv.DictReader(handle)
        for line, row in enumerate(reader, 2):
            if None in row or any(v is None for v in row.values()):
                raise ValueError(f'Malformed CSV row: {path}:{line}')
            yield line, row


def group_source(source_dir, name, required_fields):
    groups = defaultdict(dict)
    count = 0
    for line, row in read_rows(source_dir / name):
        if not set(required_fields).issubset(row):
            raise ValueError(f'Missing required columns: {name}')
        map_id, url = source_map(row['game_link'])
        # These two fields describe collection/export rather than match content.
        semantic = {k: v for k, v in row.items() if k not in {'Unnamed: 0', 'collected_timestamp'}}
        signature = digest(semantic)
        variants = groups[map_id]
        if signature not in variants:
            variants[signature] = {'row': row, 'source_url': url, 'refs': []}
        variants[signature]['refs'].append({'file': name, 'csv_record': line,
                                          'collected_timestamp': row.get('collected_timestamp')})
        count += 1
    return groups, count


def score_diagnostic(meta, detail):
    if meta is None or detail is None:
        return {'status': 'unavailable'}
    score = [number(meta.get(f'team{g}_rounds')) for g in (1, 2)]
    # The source accidentally uses team1_half2_t for team2's second half.
    # Five real rows also populate team2_half2_t; disagreement is kept unresolved.
    left = number(detail.get('team1_half2_t'))
    alternate = number(detail.get('team2_half2_t'))
    if left is not None and alternate is not None and left != alternate:
        return {'status': 'second_half_schema_conflict', 'source_values': [left, alternate]}
    halves = [number(detail.get('team1_half1_t')), number(detail.get('team1_half2_ct')),
              number(detail.get('team2_half1_ct')), left if left is not None else alternate]
    if None in score or None in halves:
        return {'status': 'unavailable'}
    totals = [sum(halves[:2]), sum(halves[2:])]
    if sum(score) != sum(totals):
        status = 'not_comparable'  # May be overtime, missing periods or source error.
    elif totals == score:
        status = 'same_order'
    elif totals == score[::-1]:
        status = 'reversed_order_candidate'
    else:
        status = 'inconsistent'
    return {'status': status, 'metadata_score': score, 'stat_block_half_totals': totals,
            'team_assignment_verified': False}


def make_record(map_id, histories, details):
    hs, ds = list(histories.values()), list(details.values())
    h = hs[0]['row'] if len(hs) == 1 else None
    d = ds[0]['row'] if len(ds) == 1 else None
    flags = []
    for variants, label in ((hs, 'metadata'), (ds, 'details')):
        if not variants:
            flags.append('missing_' + label)
        elif len(variants) > 1:
            flags.append(label + '_conflict')
    metadata = None
    if h:
        date = h['date_unix_iso']
        try:
            datetime.strptime(date, '%Y-%m-%d %H:%M:%S')
        except ValueError:
            flags.append('invalid_date')
        scores = [number(h[f'team{g}_rounds']) for g in (1, 2)]
        if None in scores:
            flags.append('invalid_score')
        metadata = {'date_raw': date, 'timezone': 'unspecified_in_source',
                    'event_raw': h['event_name'], 'map_raw': h['map_name_short'],
                    'teams_raw': [h['team1'], h['team2']],
                    'teams_display': [h['team1'].strip(), h['team2'].strip()],
                    'score_raw': [h['team1_rounds'], h['team2_rounds']], 'score': scores}
    groups = []
    if d:
        for group in (1, 2):
            names = [d[f'team{group}_p{s}_name'] for s in range(1, 6)]
            if any(not n.strip() for n in names):
                flags.append('missing_nickname')
            if len({n.strip() for n in names}) != 5:
                flags.append('duplicate_nickname_within_group')
            groups.append({'group_no': group, 'named_team_index': None, 'names_raw': names})
        if {search_key(n) for n in groups[0]['names_raw']} & {search_key(n) for n in groups[1]['names_raw']}:
            flags.append('cross_group_nickname_collision')
    diagnostic = score_diagnostic(h, d)
    if diagnostic['status'] in {'reversed_order_candidate', 'second_half_schema_conflict', 'inconsistent'}:
        flags.append(diagnostic['status'])
    source_variants = {'metadata': hs, 'details': ds}
    refs = {k: [ref for variant in v for ref in variant['refs']] for k, v in source_variants.items()}
    conflicts = {k: [{'row': x['row'], 'refs': x['refs']} for x in v]
                 for k, v in source_variants.items() if len(v) > 1}
    payload = {'map_id': map_id, 'source_url': (hs or ds)[0]['source_url'], 'metadata': metadata,
               'stat_groups': groups, 'score_diagnostic': diagnostic,
               'source_refs': refs, 'source_variant_hashes': {'metadata': sorted(histories), 'details': sorted(details)},
               'conflicting_variants': conflicts, 'flags': sorted(set(flags))}
    payload['record_sha256'] = digest(payload)
    payload['structure_status'] = 'quarantined' if set(flags) & HARD_FLAGS else 'structurally_complete'
    payload['review_status'] = 'unreviewed'
    payload['eligible_for_questions'] = False
    return payload


def validate_players(registry):
    people, external = {}, set()
    for person in registry['players']:
        pid = person['player_id']
        if not pid or pid in people or not person.get('evidence_urls'):
            raise ValueError('Duplicate/empty player ID or missing identity evidence')
        for source, value in person['external_ids'].items():
            key = (source, str(value))
            if key in external:
                raise ValueError(f'External identity assigned to two people: {key}')
            external.add(key)
        people[pid] = person
    for first, second in registry.get('distinct_player_pairs', []):
        if first == second or first not in people or second not in people:
            raise ValueError('Distinct-player constraint violated')
    return people


def apply_review(record, review, people):
    if not review:
        return None
    if review.get('record_sha256') != record['record_sha256']:
        raise ValueError(f"Stale review for map {record['map_id']}")
    if not review.get('reason') or not review.get('evidence_urls'):
        raise ValueError('Review must include reason and evidence URLs')
    if review['decision'] in {'exclude', 'defer'}:
        record['review_status'] = {'exclude': 'excluded', 'defer': 'deferred'}[review['decision']]
        record['review'] = review
        return None
    # Corrections are local to this fingerprint and never rewrite source nicknames
    # or create a global alias. Missing metadata/details still cannot be approved.
    corrected = [list(g['names_raw']) for g in record['stat_groups']]
    touched = set()
    for fix in review.get('nickname_corrections', []):
        group, slot = fix.get('group_no'), fix.get('slot')
        if type(group) is not int or type(slot) is not int or group not in (1, 2) or slot not in range(1, 6) or len(corrected) != 2:
            raise ValueError('Invalid nickname correction slot')
        key = (group, slot)
        if key in touched or fix.get('original') != corrected[group-1][slot-1]:
            raise ValueError('Stale or repeated nickname correction')
        name = fix.get('corrected')
        if not isinstance(name, str) or not name.strip() or name == fix['original'] or fix.get('evidence_url') != record['source_url']:
            raise ValueError('Nickname correction requires changed text and this map evidence')
        corrected[group-1][slot-1] = name
        touched.add(key)
    remaining_hard = set(record['flags']) & HARD_FLAGS
    if touched and len(corrected) == 2 and all(all(n.strip() for n in g) and len(set(g)) == 5 for g in corrected):
        remaining_hard -= {'missing_nickname', 'duplicate_nickname_within_group'}
    if review['decision'] != 'verify' or remaining_hard:
        raise ValueError('Cannot verify a structurally quarantined map')
    if review.get('actual_map_played') is not True or review.get('competition_type') != 'official':
        raise ValueError('Actual official map appearance must be verified')
    assignment, ids = review.get('group_team_indices'), review.get('player_ids')
    if assignment not in [[0, 1], [1, 0]]:
        raise ValueError('Both statistic groups must be assigned to different named teams')
    if not isinstance(ids, list) or len(ids) != 2 or any(not isinstance(g, list) or len(g) != 5 for g in ids):
        raise ValueError('Review must identify all ten appearance slots')
    flat = [pid for group in ids for pid in group]
    if any(pid not in people for pid in flat) or len(set(flat)) != 10:
        raise ValueError('Unknown or repeated player identity in one map')
    observed = review.get('observed_groups')
    if touched and not observed:
        raise ValueError('Nickname correction requires observed identity evidence')
    if observed is not None:
        if record['source_url'] not in review['evidence_urls']:
            raise ValueError('Observed roster requires this map source URL')
        if len(observed) != 2:
            raise ValueError('Both observed groups are required')
        for i, group in enumerate(observed):
            if group.get('metadata_team_name') != record['metadata']['teams_display'][assignment[i]] or not group.get('observed_team_name'):
                raise ValueError('Observed team does not match explicit team assignment')
            slots = group.get('players', [])
            if len(slots) != 5:
                raise ValueError('Observed group must contain five players')
            for j, slot in enumerate(slots):
                person = people[ids[i][j]]
                external_id = str(person['external_ids'].get('hltv'))
                url = urllib.parse.urlsplit(slot.get('profile_url', ''))
                if slot.get('nickname') != corrected[i][j] or str(slot.get('hltv_id')) != external_id:
                    raise ValueError('Observed nickname or external identity differs from appearance slot')
                if url.scheme != 'https' or url.netloc != 'www.hltv.org' or not re.fullmatch(r'/stats/players/' + re.escape(external_id) + r'/[^/\s]+', url.path) or url.query or url.fragment:
                    raise ValueError('Observed profile URL must match the external identity')
    record['review_status'] = 'verified'
    record['review'] = review
    if touched:
        record['structure_status'] = 'corrected_with_evidence'
    record['score_diagnostic']['team_assignment_verified'] = True
    for i, group in enumerate(record['stat_groups']):
        group['named_team_index'] = assignment[i]
        group['player_ids'] = ids[i]
        if touched:
            group['names_reviewed'] = corrected[i]
    return ids


def metadata_key(row, legacy=False):
    return (row['datetime'] if legacy else row['date_unix_iso'], row['team1'].strip(),
            row['team2'].strip(), row['map_name_short'], row['event_name'])


def reconcile_legacy(source_dir, histories, details):
    by_key = defaultdict(set)
    for map_id, variants in histories.items():
        for variant in variants.values():
            by_key[metadata_key(variant['row'])].add(map_id)
    counts, cases = Counter(), []
    for line, row in read_rows(source_dir / LEGACY):
        counts['rows'] += 1
        candidates = by_key.get(metadata_key(row, True), set())
        names = tuple(row[k] for k in NAMES)
        matches = [map_id for map_id in sorted(candidates) if any(
            tuple(v['row'][k] for k in NAMES) == names for v in details.get(map_id, {}).values())]
        if len(candidates) != 1:
            cases.append({'legacy_csv_record': line, 'original_candidates': sorted(candidates),
                          'roster_matched_candidates': matches,
                          'status': 'resolved_by_exact_roster' if len(matches) == 1 else 'unresolved'})
        counts['unique_match' if len(matches) == 1 else 'unresolved'] += 1
    return {'counts': dict(counts), 'previously_ambiguous_cases': cases,
            'note': 'Diagnostic only. Canonical records are built from the original map IDs, not inferred legacy row IDs.'}


def create_database(path, people):
    db = sqlite3.connect(path)
    db.execute('PRAGMA foreign_keys=ON')
    db.executescript('''
        CREATE TABLE players(player_id TEXT PRIMARY KEY, nickname TEXT COLLATE BINARY NOT NULL, record_json TEXT NOT NULL);
        CREATE TABLE maps(map_id INTEGER PRIMARY KEY, source_url TEXT NOT NULL, date_raw TEXT,
            structure_status TEXT NOT NULL, review_status TEXT NOT NULL, record_sha256 TEXT NOT NULL, record_json TEXT NOT NULL);
        CREATE TABLE appearances(appearance_id TEXT PRIMARY KEY, map_id INTEGER NOT NULL REFERENCES maps(map_id),
            group_no INTEGER NOT NULL, slot INTEGER NOT NULL, nickname_raw TEXT COLLATE BINARY NOT NULL,
            search_key TEXT NOT NULL, player_id TEXT REFERENCES players(player_id));
        CREATE INDEX appearances_search ON appearances(search_key);
        CREATE INDEX appearances_player ON appearances(player_id);
        CREATE TABLE teammate_evidence(player_a TEXT REFERENCES players(player_id), player_b TEXT REFERENCES players(player_id),
            map_id INTEGER REFERENCES maps(map_id), group_no INTEGER NOT NULL, source_url TEXT NOT NULL,
            PRIMARY KEY(player_a, player_b, map_id), CHECK(player_a < player_b));
    ''')
    db.executemany('INSERT INTO players VALUES(?,?,?)', [(pid, p['nickname'], encoded(p)) for pid, p in sorted(people.items())])
    return db


def populate(source_dir, output, lock, registry, review_data):
    people = validate_players(registry)
    reviews = {}
    for review in review_data['maps']:
        map_id = review['map_id']
        if map_id in reviews:
            raise ValueError('Duplicate map review')
        if max(review_data.get('schema_version', 1), review.get('evidence_schema_version', 1)) >= 2 and review['decision'] == 'verify' and not review.get('observed_groups'):
            raise ValueError('Review schema 2 requires observed identity evidence')
        reviews[map_id] = review
    histories, history_rows = group_source(source_dir, HISTORY, ['game_link', 'date_unix_iso', 'team1', 'team2', 'map_name_short', 'event_name', 'team1_rounds', 'team2_rounds'])
    details, detail_rows = group_source(source_dir, DETAILS, ['game_link', *NAMES])
    all_ids = sorted(histories.keys() | details.keys())
    if set(reviews) - set(all_ids):
        raise ValueError('Review references a nonexistent map')
    exceptions = {source_map(row['game_link'])[0] for _, row in read_rows(source_dir / EXCEPTIONS)}
    counts, flags, years, events, identities = Counter(), Counter(), defaultdict(Counter), Counter(), {}
    sample_by_year, sample_by_flag, special_samples = defaultdict(list), {}, []
    db = create_database(output / 'staging.sqlite3', people)
    edges = defaultdict(list)
    try:
        with (output / 'matches.jsonl').open('w') as maps_out, (output / 'review_queue.jsonl').open('w') as queue_out:
            for map_id in all_ids:
                record = make_record(map_id, histories.get(map_id, {}), details.get(map_id, {}))
                ids = apply_review(record, reviews.get(map_id), people)
                # Publishing requires separate rights clearance, even for verified records.
                record['eligible_for_questions'] = ids is not None and lock['rights_status'] == 'cleared'
                meta = record['metadata'] or {}
                date = meta.get('date_raw')
                year = date[:4] if date else 'unknown'
                counts[record['structure_status']] += 1
                counts[record['review_status']] += 1
                counts['eligible_for_questions'] += record['eligible_for_questions']
                if 'missing_details' in record['flags']:
                    counts['missing_details_in_exception_log' if map_id in exceptions else 'missing_details_not_in_exception_log'] += 1
                flags.update(record['flags'])
                years[year]['maps'] += 1
                years[year][record['structure_status']] += 1
                events[meta.get('event_raw', 'unknown')] += 1
                db.execute('INSERT INTO maps VALUES(?,?,?,?,?,?,?)', (map_id, record['source_url'], date,
                    record['structure_status'], record['review_status'], record['record_sha256'], encoded(record)))
                observations = []
                for group in record['stat_groups']:
                    g = group['group_no']
                    for slot, name in enumerate(group['names_raw'], 1):
                        aid = f'hltv:{map_id}:{g}:{slot}'
                        pid = ids[g-1][slot-1] if ids else None
                        observations.append((aid, map_id, g, slot, name, search_key(name), pid))
                        counts['appearances'] += 1
                        counts['resolved_appearances'] += pid is not None
                        item = identities.setdefault(name, {'nickname_raw': name, 'search_key': search_key(name),
                            'appearance_count': 0, 'example_appearance_ids': [], 'identity_status': 'nickname_bucket_not_a_person'})
                        item['appearance_count'] += 1
                        if len(item['example_appearance_ids']) < 3:
                            item['example_appearance_ids'].append(aid)
                    if ids:
                        for a, b in combinations(sorted(ids[g-1]), 2):
                            ev = {'map_id': map_id, 'group_no': g, 'date_raw': date,
                                  'team': meta['teams_display'][group['named_team_index']], 'source_url': record['source_url']}
                            db.execute('INSERT INTO teammate_evidence VALUES(?,?,?,?,?)', (a, b, map_id, g, record['source_url']))
                            edges[(a, b)].append(ev)
                db.executemany('INSERT INTO appearances VALUES(?,?,?,?,?,?,?)', observations)
                maps_out.write(encoded(record) + '\n')
                if record['flags'] or record['review_status'] in {'excluded', 'deferred'}:
                    queue_out.write(encoded({'map_id': map_id, 'source_url': record['source_url'],
                        'record_sha256': record['record_sha256'], 'flags': record['flags'],
                        'structure_status': record['structure_status'], 'review_status': record['review_status']}) + '\n')
                # Deterministic review packet: two maps per year plus diagnostic cases.
                if record['stat_groups'] and len(sample_by_year[year]) < 2:
                    sample_by_year[year].append(record)
                for flag in record['flags']:
                    sample_by_flag.setdefault(flag, record)
                if record['stat_groups'] and {'NiKo', 'niko'}.issubset({n for g in record['stat_groups'] for n in g['names_raw']}) and len(special_samples) < 2:
                    special_samples.append(record)
        db.commit()
        if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok' or db.execute('PRAGMA foreign_key_check').fetchall():
            raise ValueError('Staging database integrity check failed')
    finally:
        db.close()
    candidates_by_key = defaultdict(list)
    for pid, p in sorted(people.items()):
        candidates_by_key[search_key(p['nickname'])].append(pid)
    with (output / 'identity_candidates.jsonl').open('w') as out:
        for name, entry in sorted(identities.items()):
            entry['candidate_player_ids_not_assignments'] = candidates_by_key[entry['search_key']]
            out.write(encoded(entry) + '\n')
    with (output / 'teammate_edges.jsonl').open('w') as out:
        for (a, b), evidence in sorted(edges.items()):
            out.write(encoded({'player_a': a, 'player_b': b, 'evidence': evidence,
                              'eligible_for_questions': lock['rights_status'] == 'cleared'}) + '\n')
    samples = {}
    for record in special_samples + list(sample_by_flag.values()) + [r for v in sample_by_year.values() for r in v]:
        samples.setdefault(record['map_id'], record)
    packet = list(samples.values())[:30]
    write_json(output / 'review_samples.json', {'status': 'review_packet',
        'review_status_counts': dict(Counter(r['review_status'] for r in packet)), 'maps': packet})
    reconciliation = reconcile_legacy(source_dir, histories, details)
    write_json(output / 'legacy_reconciliation.json', reconciliation)
    write_json(output / 'players.json', registry)
    report = {'schema_version': 1, 'scope': 'Offline structural normalization. No inferred nickname identities or team assignments are accepted automatically.',
        'source_revision': lock['revision'], 'rights_status': lock['rights_status'],
        'input_history_rows': history_rows, 'input_detail_rows': detail_rows,
        'unique_history_maps': len(histories), 'unique_detail_maps': len(details), 'maps': len(all_ids),
        'history_duplicate_rows': history_rows - len(histories), 'detail_duplicate_rows': detail_rows - len(details),
        'counts': dict(counts), 'flag_counts': dict(flags), 'year_coverage': {k: dict(v) for k, v in sorted(years.items())},
        'event_map_counts': dict(sorted(events.items())), 'registered_people': len(people),
        'distinct_raw_nicknames_not_people': len(identities), 'verified_teammate_edges': len(edges),
        'review_sample_count': len(packet), 'legacy_reconciliation': reconciliation,
        'release_ready': False,
        'release_gates': {'source_rights_cleared': lock['rights_status'] == 'cleared',
                          'question_coverage_accepted': False,
                          'multiplayer_integration_accepted': False},
        'limitations': ['Source dates have no confirmed timezone.', 'Structural completeness is not verified actual participation.',
                       'Nickname candidates are not identity assignments.', 'An absent edge does not establish that players were never teammates.',
                       'Source use authorization is tracked separately from data quality.']}
    write_json(output / 'report.json', report)
    return report


def verify_output(path):
    manifest = json.loads((path / 'manifest.json').read_text())
    for name, expected in manifest['artifacts'].items():
        artifact = path / name
        if not artifact.is_file() or file_hash(artifact) != expected:
            raise ValueError(f'Output checksum mismatch: {artifact}')
    return manifest


def build(source_dir, versions_dir, lock, registry, reviews):
    verify_inputs(source_dir, lock)
    inputs = {'source': lock, 'registry': registry, 'reviews': reviews, 'pipeline_sha256': file_hash(__file__)}
    version = digest(inputs)[:20]
    versions_dir.mkdir(parents=True, exist_ok=True)
    dest = versions_dir / version
    with tempfile.TemporaryDirectory(prefix='.building-', dir=versions_dir) as temp:
        tmp = Path(temp)
        report = populate(source_dir, tmp, lock, registry, reviews)
        artifacts = {p.name: file_hash(p) for p in sorted(tmp.iterdir())}
        manifest = {'version': version, 'inputs': inputs, 'artifacts': artifacts}
        write_json(tmp / 'manifest.json', manifest)
        if dest.exists():
            old = verify_output(dest)
            if old != manifest:
                raise ValueError('Same inputs produced different output; existing version left untouched')
        else:
            # TemporaryDirectory cleanup tolerates the renamed directory.
            tmp.rename(dest)
    return dest, report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['fetch', 'build', 'verify'])
    parser.add_argument('--source-dir', type=Path, default=ROOT / '.local-data/dataset-audit-20260930')
    parser.add_argument('--versions-dir', type=Path, default=ROOT / '.local-data/cslink/versions')
    parser.add_argument('--lock', type=Path, default=CONFIG / 'source.lock.json')
    parser.add_argument('--players', type=Path, default=CONFIG / 'players.json')
    parser.add_argument('--reviews', type=Path, default=CONFIG / 'reviews.json')
    parser.add_argument('--version-path', type=Path)
    args = parser.parse_args()
    lock = json.loads(args.lock.read_text())
    if args.action == 'fetch':
        fetch(args.source_dir, lock)
    elif args.action == 'verify':
        if not args.version_path:
            parser.error('verify requires --version-path')
        print(encoded(verify_output(args.version_path)))
    else:
        path, report = build(args.source_dir, args.versions_dir, lock,
                             json.loads(args.players.read_text()), json.loads(args.reviews.read_text()))
        print(json.dumps({'version_path': str(path), 'maps': report['maps'], 'counts': report['counts'],
                          'flags': report['flag_counts'], 'verified_teammate_edges': report['verified_teammate_edges']}, indent=2))


if __name__ == '__main__':
    main()
