#!/usr/bin/env python3
"""Build a local, review-only SQLite library from the corrected HLTV map captures.

No network requests are made. This is separate from the reviewed graph and game data.
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

from cslink_roster_pilot import validate_capture


ROOT = Path(__file__).resolve().parents[1]
PLAN = ROOT / 'data/cslink/as-tier-event-cover-2026-10-04-corrected/selected-series.jsonl'
CAPTURES = ROOT / '.local-data/cslink/hltv-capture-2026-10-04-provenance-complete'
OUTPUT = ROOT / '.local-data/cslink/candidate-library-v1'
LEDGER = ROOT / 'data/cslink/map-id-corrections-2026-10-04.jsonl'
SCHEMA_VERSION = 1


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def encoded_json(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode()


def file_record(raw):
    return {'bytes': len(raw), 'sha256': digest(raw)}


def checked_hltv_id(url, path_pattern, expected):
    parsed = urlsplit(url or '')
    match = re.fullmatch(path_pattern, parsed.path)
    if (parsed.scheme != 'https' or parsed.netloc != 'www.hltv.org' or not match or
            parsed.query or parsed.fragment or int(match.group(1)) != expected):
        raise ValueError(f'HLTV URL does not bind the expected ID {expected}: {url}')


def read_plan(plan_path, ledger_path):
    plan_raw = plan_path.read_bytes()
    manifest_path = plan_path.parent / 'manifest.json'
    manifest_raw = manifest_path.read_bytes()
    source_manifest = json.loads(manifest_raw)
    if source_manifest.get('schema_version') != 1:
        raise ValueError('Unsupported selection plan manifest version')
    expected = source_manifest['files']['selected-series.jsonl']
    if expected != file_record(plan_raw):
        raise ValueError('Selection plan differs from its manifest')
    for name, expected_file in source_manifest['files'].items():
        raw = (plan_path.parent / name).read_bytes()
        if file_record(raw) != expected_file:
            raise ValueError(f'Selection plan sidecar differs from its manifest: {name}')
    ledger_sha = source_manifest.get('inputs', {}).get('correction_ledger_sha256')
    if ledger_sha:
        if not ledger_path or digest(ledger_path.read_bytes()) != ledger_sha:
            raise ValueError('Correction ledger differs from corrected plan manifest')
    correction_rows = [json.loads(line) for line in
                       (plan_path.parent / 'correction-applied.jsonl').read_bytes().splitlines()
                       if line.strip()] if (plan_path.parent / 'correction-applied.jsonl').is_file() else []
    rows = [json.loads(line) for line in plan_raw.splitlines() if line.strip()]
    map_ids = [row['selected_mapstatsid'] for row in rows]
    if len(set(map_ids)) != len(rows):
        raise ValueError('Duplicate map ID in corrected selection plan')
    # A substitute can appear between maps of the same series. Map IDs, rather
    # than series IDs, are the unique unit of lineup evidence.
    for row in rows:
        map_id = row['selected_mapstatsid']
        series_id = row['hltv_series_id']
        if type(map_id) is not int or map_id <= 0 or type(series_id) is not int or series_id <= 0:
            raise ValueError('Map and series IDs must be positive integers')
        checked_hltv_id(row['hltv_map_url'], r'/stats/matches/mapstatsid/(\d+)/[^/]+', map_id)
        checked_hltv_id(row['hltv_series_url'], r'/matches/(\d+)/[^/]+', series_id)
        event_url = urlsplit(row.get('event_url', ''))
        if (event_url.scheme != 'https' or event_url.netloc != 'liquipedia.net' or
                not event_url.path.startswith('/counterstrike/') or event_url.query or event_url.fragment):
            raise ValueError(f'Invalid event reference URL for map {map_id}')
        if (not isinstance(row.get('event_name'), str) or not row['event_name'].strip() or
                row.get('tier') not in ('A-Tier', 'S-Tier') or
                not re.fullmatch(r'[0-9a-f]{64}', row.get('source_revision_sha256', '')) or
                row.get('eligible_for_questions') is not False):
            raise ValueError(f'Invalid event/revision/release gate for map {map_id}')
    plan_by_id = {row['selected_mapstatsid']: row for row in rows}
    for correction in correction_rows:
        map_id = correction['verified_mapstatsid']
        row = plan_by_id.get(map_id)
        row_raw = (json.dumps(row, ensure_ascii=False, sort_keys=True) + '\n').encode() if row else b''
        if (not row or row.get('map_id_correction_id') != correction['correction_id'] or
                correction['effective_row_sha256'] != digest(row_raw) or
                correction['canonical_map_url'] != row['hltv_map_url'] or
                correction['correction_ledger_sha256'] != ledger_sha):
            raise ValueError(f'Correction lineage disagrees with effective plan for map {map_id}')
    return rows, file_record(plan_raw), file_record(manifest_raw), ledger_sha


def read_captures(plan, captures_dir):
    verified_maps = []
    capture_hashes = []
    provenance_gaps = []
    for row in plan:
        map_id = row['selected_mapstatsid']
        capture_path = captures_dir / f'{map_id}.json'
        if not capture_path.is_file():
            raise ValueError(f'Missing selected map capture: {map_id}')
        raw = capture_path.read_bytes()
        capture = json.loads(raw)
        if capture.get('source_url') != row['hltv_map_url']:
            raise ValueError(f'Capture URL differs from corrected plan for map {map_id}')
        for capture_field, plan_field in (('event_url', 'event_url'),
                                          ('hltv_series_id_from_liquipedia', 'hltv_series_id'),
                                          ('source_revision_sha256', 'source_revision_sha256')):
            observed = capture.get(capture_field)
            if observed is not None and observed != row[plan_field]:
                raise ValueError(f'Capture {capture_field} conflicts with plan for map {map_id}')
        if capture.get('eligible_for_questions') not in (None, False):
            raise ValueError(f'Capture release gate is unsafe for map {map_id}')
        missing_fields = [field for field in
                          ('event_url', 'hltv_series_id_from_liquipedia', 'source_revision_sha256')
                          if capture.get(field) is None]
        if missing_fields:
            provenance_gaps.append({'map_id': map_id, 'missing_capture_fields': missing_fields})
        checked = validate_capture(capture, map_id)
        if not all(isinstance(checked[field], str) and checked[field].strip()
                   for field in ('event_as_displayed', 'date_time_as_displayed', 'map_as_displayed')):
            raise ValueError(f'Missing displayed event/date/map for map {map_id}')
        capture_sha = digest(raw)
        verified_maps.append((row, checked, capture_sha, 'metadata_missing' if missing_fields else 'matched'))
        capture_hashes.append(f'{map_id}\t{capture_sha}\n')
    capture_set_sha = digest(''.join(sorted(capture_hashes, key=lambda line: int(line.split('\t')[0]))).encode())
    return verified_maps, capture_set_sha, provenance_gaps


SCHEMA = """
PRAGMA foreign_keys = ON;
PRAGMA user_version = 1;
CREATE TABLE players (
    player_id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    nicknames_json TEXT NOT NULL,
    player_urls_json TEXT NOT NULL,
    map_count INTEGER NOT NULL CHECK (map_count > 0),
    review_state TEXT NOT NULL CHECK (review_state = 'unreviewed'),
    eligible_for_questions INTEGER NOT NULL CHECK (eligible_for_questions = 0)
);
CREATE TABLE maps (
    map_id INTEGER PRIMARY KEY,
    series_id INTEGER NOT NULL,
    series_url TEXT NOT NULL,
    event_name TEXT NOT NULL,
    event_as_displayed TEXT NOT NULL,
    event_url TEXT NOT NULL,
    event_start_date TEXT,
    tier TEXT NOT NULL,
    map_name TEXT NOT NULL,
    date_time_as_displayed TEXT NOT NULL,
    source_url TEXT NOT NULL,
    source_page_url TEXT NOT NULL,
    source_revision_sha256 TEXT NOT NULL,
    capture_sha256 TEXT NOT NULL,
    capture_provenance_status TEXT NOT NULL CHECK (capture_provenance_status IN ('matched', 'metadata_missing')),
    map_id_correction_id TEXT,
    review_state TEXT NOT NULL CHECK (review_state = 'unreviewed'),
    eligible_for_questions INTEGER NOT NULL CHECK (eligible_for_questions = 0)
);
CREATE TABLE appearances (
    map_id INTEGER NOT NULL REFERENCES maps(map_id),
    player_id TEXT NOT NULL REFERENCES players(player_id),
    team_name TEXT NOT NULL,
    nickname TEXT NOT NULL,
    player_url TEXT NOT NULL,
    team_score INTEGER NOT NULL,
    opponent_name TEXT NOT NULL,
    opponent_score INTEGER NOT NULL,
    PRIMARY KEY (map_id, player_id)
) WITHOUT ROWID;
CREATE TABLE edges (
    player_a TEXT NOT NULL REFERENCES players(player_id),
    player_b TEXT NOT NULL REFERENCES players(player_id),
    evidence_count INTEGER NOT NULL CHECK (evidence_count > 0),
    review_state TEXT NOT NULL CHECK (review_state = 'unreviewed'),
    eligible_for_questions INTEGER NOT NULL CHECK (eligible_for_questions = 0),
    PRIMARY KEY (player_a, player_b),
    CHECK (CAST(player_a AS INTEGER) < CAST(player_b AS INTEGER))
) WITHOUT ROWID;
CREATE TABLE edge_evidence (
    player_a TEXT NOT NULL,
    player_b TEXT NOT NULL,
    map_id INTEGER NOT NULL REFERENCES maps(map_id),
    team_name TEXT NOT NULL,
    PRIMARY KEY (player_a, player_b, map_id),
    FOREIGN KEY (player_a, player_b) REFERENCES edges(player_a, player_b)
) WITHOUT ROWID;
CREATE INDEX idx_appearances_player ON appearances(player_id, map_id);
CREATE INDEX idx_edge_evidence_map ON edge_evidence(map_id);
CREATE INDEX idx_players_display_name ON players(display_name COLLATE NOCASE);
"""


def write_sqlite(path, verified_maps):
    aliases = defaultdict(Counter)
    player_urls = defaultdict(set)
    player_maps = defaultdict(set)
    appearances = []
    maps = []
    edge_maps = defaultdict(list)
    for row, checked, capture_sha, provenance_status in verified_maps:
        map_id = checked['mapstatsid']
        maps.append((map_id, row['hltv_series_id'], row['hltv_series_url'], row['event_name'],
                     checked['event_as_displayed'], row['event_url'], row.get('event_start_date'),
                     row['tier'], checked['map_as_displayed'], checked['date_time_as_displayed'],
                     checked['source_url'], row.get('source_page_url', row['event_url']),
                     row['source_revision_sha256'], capture_sha, provenance_status,
                     row.get('map_id_correction_id'), 'unreviewed', 0))
        first, second = checked['teams']
        for team, opponent in ((first, second), (second, first)):
            players = team['players']
            ids = sorted((person['source_player_id'] for person in players), key=int)
            for person in players:
                player_id = person['source_player_id']
                aliases[player_id][person['nickname_as_displayed']] += 1
                player_urls[player_id].add(person['source_player_url'])
                player_maps[player_id].add(map_id)
                appearances.append((map_id, player_id, team['name_as_displayed'],
                                    person['nickname_as_displayed'], person['source_player_url'],
                                    team['score'], opponent['name_as_displayed'], opponent['score']))
            for player_a, player_b in combinations(ids, 2):
                edge_maps[(player_a, player_b)].append((player_a, player_b, map_id,
                                                        team['name_as_displayed']))
    players = []
    for player_id in sorted(aliases, key=int):
        names = aliases[player_id]
        display_name = sorted(names, key=lambda name: (-names[name], name))[0]
        players.append((player_id, display_name, json.dumps(sorted(names), ensure_ascii=False),
                        json.dumps(sorted(player_urls[player_id]), ensure_ascii=False),
                        len(player_maps[player_id]), 'unreviewed', 0))
    edges = [(a, b, len(records), 'unreviewed', 0) for (a, b), records in
             sorted(edge_maps.items(), key=lambda item: (int(item[0][0]), int(item[0][1])))]
    evidence = [record for records in edge_maps.values() for record in records]
    evidence.sort(key=lambda row: (int(row[0]), int(row[1]), row[2]))
    connection = sqlite3.connect(path)
    try:
        connection.executescript(SCHEMA)
        with connection:
            connection.executemany('INSERT INTO players VALUES (?,?,?,?,?,?,?)', players)
            connection.executemany('INSERT INTO maps VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
                                   sorted(maps, key=lambda row: row[0]))
            connection.executemany('INSERT INTO appearances VALUES (?,?,?,?,?,?,?,?)',
                                   sorted(appearances, key=lambda row: (row[0], int(row[1]))))
            connection.executemany('INSERT INTO edges VALUES (?,?,?,?,?)', edges)
            connection.executemany('INSERT INTO edge_evidence VALUES (?,?,?,?)', evidence)
        if connection.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise ValueError('SQLite integrity check failed')
        if connection.execute('PRAGMA foreign_key_check').fetchone():
            raise ValueError('SQLite foreign key check failed')
    finally:
        connection.close()
    return {'distinct_player_ids': len(players), 'candidate_teammate_pairs': len(edges),
            'pair_map_evidence_records': len(evidence), 'appearances': len(appearances)}


def build(plan_path=PLAN, captures_dir=CAPTURES, output_dir=OUTPUT, ledger_path=LEDGER):
    plan_path, captures_dir, output_dir = map(Path, (plan_path, captures_dir, output_dir))
    ledger_path = Path(ledger_path) if ledger_path else None
    plan, plan_info, plan_manifest_info, ledger_sha = read_plan(plan_path, ledger_path)
    verified_maps, capture_set_sha, provenance_gaps = read_captures(plan, captures_dir)
    output_dir.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.candidate-library-build-', dir=output_dir.parent) as temp:
        temp_dir = Path(temp)
        db_path = temp_dir / 'library.sqlite3'
        counts = write_sqlite(db_path, verified_maps)
        db_raw = db_path.read_bytes()
        version = digest(db_raw)[:20]
        report = {'schema_version': SCHEMA_VERSION, 'version': version,
                  'library_status': 'candidate_unreviewed', 'review_state': 'unreviewed',
                  'eligible_for_questions': False, 'planned_maps': len(plan),
                  'captured_valid_maps': len(verified_maps),
                  'plan_sha256': plan_info['sha256'],
                  'capture_set_sha256': capture_set_sha,
                  'correction_ledger_sha256': ledger_sha,
                  'maps_with_incomplete_capture_provenance': len(provenance_gaps),
                  'capture_provenance_gaps': provenance_gaps,
                  **counts}
        report_raw = encoded_json(report)
        manifest = {'schema_version': SCHEMA_VERSION, 'version': version,
                    'library_status': 'candidate_unreviewed',
                    'eligible_for_questions': False,
                    'inputs': {'plan_sha256': plan_info['sha256'],
                               'plan_manifest_sha256': plan_manifest_info['sha256'],
                               'correction_ledger_sha256': ledger_sha,
                               'capture_set_sha256': capture_set_sha,
                               'capture_count': len(verified_maps)},
                    'files': {'library.sqlite3': file_record(db_raw),
                              'report.json': file_record(report_raw)}}
        (temp_dir / 'report.json').write_bytes(report_raw)
        (temp_dir / 'manifest.json').write_bytes(encoded_json(manifest))
        output_dir.mkdir(parents=True, exist_ok=True)
        for name in ('library.sqlite3', 'report.json', 'manifest.json'):
            os.replace(temp_dir / name, output_dir / name)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path, default=PLAN)
    parser.add_argument('--captures', type=Path, default=CAPTURES)
    parser.add_argument('--output', type=Path, default=OUTPUT)
    parser.add_argument('--ledger', type=Path, default=LEDGER)
    args = parser.parse_args()
    print(json.dumps(build(args.plan, args.captures, args.output, args.ledger), ensure_ascii=False,
                     indent=2))
