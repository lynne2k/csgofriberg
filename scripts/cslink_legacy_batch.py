#!/usr/bin/env python3
"""Incrementally materialize pre-2023-07-13 A/S maps with exact source evidence.

The old nickname rows are used only to locate a map. Actual teammates always
come from a fresh, ten-player HLTV capture with numeric player IDs. Outputs
are immutable versions; `current` changes only after every check succeeds.
"""

import argparse
from collections import Counter
from datetime import date, datetime, timedelta
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import tempfile

from cslink_candidate_library import build as build_library, read_plan
from cslink_legacy_as_catalog import (
    ALIAS_LEDGER, RULE_VERSION, exact_link_check, extract_map_refs,
)
import cslink_legacy_as_catalog_v3 as scope_v3
from cslink_local_play_projection import (
    automatic_exclusion_reason, js_json_bytes, ordered_json_bytes,
    validate_candidate_db,
)
from cslink_roster_pilot import validate_capture
from cslink_tier_enrich import event_cache, field, template_blocks
from cslink_tier_enrich import digits_field, without_showmatch_section


ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / '.local-data/cslink/legacy-as-catalog-v3-fa3577c0e653c6ed8378'
OLD_DB = ROOT / '.local-data/cslink/versions/69d3bb14fb82e70ea452/staging.sqlite3'
EVENT_CACHE = ROOT / '.local-data/cslink/legacy-as-event-pages'
SUBPAGE_CACHE = ROOT / '.local-data/cslink/legacy-as-result-subpages'
CAPTURE_DIRS = (ROOT / '.local-data/cslink/legacy-hltv-capture-pilot',
                ROOT / '.local-data/cslink/historical-as-v1/captures')
OUTPUT = ROOT / '.local-data/cslink/historical-as-batch-v1'
PILOT_IDS = {134047, 134118, 134388}

# Historical Liquipedia labels and HLTV display names observed on the same
# exact Map.stats/mapstatsid record. Do not infer aliases by stripping suffixes:
# early CS:GO used distinct _se/_ce map versions, and only these attested label
# pairs pass the name check. The map ID, event, date, and score are checked too.
LP_HLTV_MAP_NAME_PAIRS = frozenset({
    ('Dust II', 'Dust2'),
    ('Dust II', 'Dust2_se'),
    ('Inferno', 'Inferno_se'),
    ('Mirage', 'Mirage_ce'),
    ('Mirage CSGO', 'Mirage_ce'),
    ('Nuke', 'Nuke_se'),
    ('Nuke VE', 'Nuke_se'),
    ('Train', 'Train_se'),
})


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def file_record(raw):
    return {'bytes': len(raw), 'sha256': sha(raw)}


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode()


def jsonl(rows):
    return ''.join(json.dumps(row, ensure_ascii=False, sort_keys=True) + '\n'
                   for row in rows).encode()


def checked_rows(raw):
    return [json.loads(line) for line in raw.splitlines() if line.strip()]


def event_window(day, start, end):
    # Old CSV and HLTV display time zones are not attested. A two-day margin
    # tolerates date shifts without admitting a later season of the same series.
    return start - timedelta(days=2) <= day <= end + timedelta(days=2)


def map_names_agree(lp_name, hltv_name):
    normalized = lambda name: re.sub(r'[^a-z0-9]', '', name.casefold())
    return (normalized(lp_name) == normalized(hltv_name) or
            (lp_name, hltv_name) in LP_HLTV_MAP_NAME_PAIRS)


def inline_field(block, key):
    found = re.search(r'\|\s*' + re.escape(key) + r'\s*=\s*([^|}\r\n]+)', block, re.I)
    return found.group(1).strip() if found else None


def source_match_proof(wiki, map_id, series_id):
    matches = []
    for match_block in template_blocks(without_showmatch_section(wiki), 'Match'):
        if digits_field(match_block, 'hltv') != series_id:
            continue
        for map_block in template_blocks(match_block, 'Map'):
            if digits_field(map_block, 'stats') == map_id:
                matches.append((match_block, map_block))
    if len(matches) != 1:
        raise ValueError(f'Expected one exact LP Match/Map for map {map_id}, found {len(matches)}')
    match_block, map_block = matches[0]
    raw_date = field(match_block, 'date')
    parsed_date = re.match(r'([A-Z][a-z]+ \d{1,2}, \d{4})\s*-\s*\d{1,2}:\d{2}',
                           raw_date or '')
    try:
        match_day = datetime.strptime(parsed_date.group(1), '%B %d, %Y').date()
    except (AttributeError, ValueError) as error:
        raise ValueError(f'LP Match date cannot be parsed for map: {map_id}') from error
    map_name = inline_field(map_block, 'map')
    if not map_name:
        raise ValueError(f'LP Match has no map name: {map_id}')
    labels = []
    for number in (1, 2):
        found = re.search(r'\|\s*opponent' + str(number) +
                          r'\s*=\s*\{\{TeamOpponent\|([^|}\r\n]+)', match_block, re.I)
        label = found.group(1).strip() if found else None
        if not label or label.casefold() in {'tbd', 'bye', 'unknown'}:
            raise ValueError(f'LP Match has unresolved team label: {map_id}')
        labels.append(label)
    if labels[0].casefold() == labels[1].casefold():
        raise ValueError(f'LP Match lists the same team twice: {map_id}')
    overtime = {int(number) for number in re.findall(r'\|\s*o([1-9]\d*)t[12](?:t|ct)\s*=',
                                                      map_block, re.I)}
    scores = []
    for team in (1, 2):
        keys = [f't{team}t', f't{team}ct']
        for period in sorted(overtime):
            keys.extend((f'o{period}t{team}t', f'o{period}t{team}ct'))
        values = [inline_field(map_block, key) for key in keys]
        if any(value is None or not value.isdigit() for value in values):
            raise ValueError(f'LP Match score is incomplete for map: {map_id}')
        scores.append(sum(int(value) for value in values))
    return {'match_date': match_day.isoformat(), 'team_labels': labels,
            'map_name': map_name, 'map_scores': scores}


def read_catalog(directory, old_db=OLD_DB, baseline_dir=scope_v3.V2_BASELINE):
    directory, old_db = Path(directory), Path(old_db)
    manifest_raw = (directory / 'manifest.json').read_bytes()
    manifest = json.loads(manifest_raw)
    rule_version = manifest.get('rule_version')
    if rule_version == RULE_VERSION:
        builder_path = ROOT / 'scripts/cslink_legacy_as_catalog.py'
    elif rule_version == scope_v3.RULE_VERSION:
        builder_path = ROOT / 'scripts/cslink_legacy_as_catalog_v3.py'
    else:
        raise ValueError('Unsupported historical catalog rule version')
    if (manifest.get('schema_version') != 1 or
            manifest.get('cutoff_exclusive') != '2023-07-13' or
            manifest.get('inputs', {}).get('catalog_builder_sha256') != sha(
                builder_path.read_bytes()) or
            manifest.get('inputs', {}).get('alias_ledger_sha256') != sha(
                ALIAS_LEDGER.read_bytes())):
        raise ValueError('Unsupported historical catalog/cutoff')
    files = {}
    for name, expected in manifest.get('files', {}).items():
        if '/' in name or name.startswith('.'):
            raise ValueError(f'Unsafe catalog file name: {name}')
        raw = (directory / name).read_bytes()
        if file_record(raw) != expected:
            raise ValueError(f'Historical catalog sidecar checksum mismatch: {name}')
        files[name] = raw
    for required in ('events.jsonl', 'exact-map-queue.jsonl', 'quarantined-exact-links.jsonl',
                     'capture-cover-plan.jsonl', 'report.json'):
        if required not in files:
            raise ValueError(f'Missing historical catalog sidecar: {required}')
    if sha(old_db.read_bytes()) != manifest.get('inputs', {}).get('legacy_db_sha256'):
        raise ValueError('Historical staging SQLite differs from catalog input')
    events = checked_rows(files['events.jsonl'])
    exact = checked_rows(files['exact-map-queue.jsonl'])
    quarantined = checked_rows(files['quarantined-exact-links.jsonl'])
    cover = checked_rows(files['capture-cover-plan.jsonl'])
    if len({r['event_url'] for r in events}) != len(events) or \
            len({r['map_id'] for r in exact}) != len(exact) or \
            len({r['selected_mapstatsid'] for r in cover}) != len(cover) or \
            {r['map_id'] for r in exact} & {r['map_id'] for r in quarantined}:
        raise ValueError('Duplicate event/map in historical catalog')
    if rule_version == scope_v3.RULE_VERSION:
        baseline_dir = Path(baseline_dir)
        baseline_manifest_raw = (baseline_dir / 'manifest.json').read_bytes()
        baseline_manifest = json.loads(baseline_manifest_raw)
        baseline_queue_raw = (baseline_dir / 'exact-map-queue.jsonl').read_bytes()
        baseline = manifest['inputs'].get('v2_baseline')
        if (not isinstance(baseline, dict) or
                baseline != {'version': baseline_manifest.get('version'),
                             'manifest_sha256': sha(baseline_manifest_raw),
                             'exact_map_queue_sha256': sha(baseline_queue_raw)} or
                baseline_manifest.get('rule_version') != RULE_VERSION or
                baseline_manifest.get('files', {}).get('exact-map-queue.jsonl') !=
                    file_record(baseline_queue_raw)):
            raise ValueError('Historical v3 catalog does not bind the frozen v2 baseline')
        baseline_rows = {row['map_id']: row for row in checked_rows(baseline_queue_raw)}
        exact_by_id = {row['map_id']: row for row in exact}
        if (len(baseline_rows) != len(checked_rows(baseline_queue_raw)) or
                any(map_id not in exact_by_id or
                    any(exact_by_id[map_id].get(key) != value for key, value in previous.items())
                    for map_id, previous in baseline_rows.items())):
            raise ValueError('Historical v3 catalog changed or lost a v2 exact map')
        for name in ('new-exact-map-queue.jsonl', 'new-capture-cover-plan.jsonl',
                     'new-map-admission-audit.jsonl', 'new-official-alias-groups.jsonl'):
            if name not in files:
                raise ValueError(f'Historical v3 catalog lacks source audit: {name}')
        new_rows = checked_rows(files['new-exact-map-queue.jsonl'])
        new_ids = set(exact_by_id) - set(baseline_rows)
        if (len(new_rows) != len(new_ids) or
                {row['map_id'] for row in new_rows} != new_ids or
                any(exact_by_id[row['map_id']] != row for row in new_rows)):
            raise ValueError('Historical v3 new-map queue differs from cumulative exact queue')
        audits = checked_rows(files['new-map-admission-audit.jsonl'])
        if len(audits) != len(new_ids) or {row['map_id'] for row in audits} != new_ids:
            raise ValueError('Historical v3 new-map audit coverage differs from accepted maps')
        for audit in audits:
            row = exact_by_id[audit['map_id']]
            fields = ('event_url', 'event_raw', 'event_name_match_rule',
                      'official_alias_evidence', 'liquipedia_match_date',
                      'event_start_date', 'event_end_date', 'source_page_url',
                      'source_revision_sha256', 'hltv_series_id', 'hltv_map_url')
            if (any(audit.get(key) != row.get(key) for key in fields) or
                    audit.get('old_map_date') != row['date_raw'][:10] or
                    audit.get('day_delta') != abs((date.fromisoformat(row['date_raw'][:10]) -
                        date.fromisoformat(row['liquipedia_match_date'])).days) or
                    not row['event_name_match_rule'].startswith('official_infobox_') or
                    not isinstance(row.get('official_alias_evidence'), dict)):
                raise ValueError(f'Historical v3 admission audit differs for map {row["map_id"]}')
        new_cover = checked_rows(files['new-capture-cover-plan.jsonl'])
        cover_ids = {row['selected_mapstatsid'] for row in cover}
        if (len({row['selected_mapstatsid'] for row in new_cover}) != len(new_cover) or
                any(row['selected_mapstatsid'] not in new_ids or
                    row['selected_mapstatsid'] not in cover_ids for row in new_cover)):
            raise ValueError('Historical v3 new capture plan includes an unapproved map')
        groups = checked_rows(files['new-official-alias-groups.jsonl'])
        grouped_ids = [map_id for row in groups for map_id in row['map_ids']]
        if (set(grouped_ids) != new_ids or len(grouped_ids) != len(new_ids) or
                any(row['map_count'] != len(row['map_ids']) or
                    any(exact_by_id[map_id]['event_url'] != row['event_url'] or
                        exact_by_id[map_id]['official_alias_evidence']['field'] !=
                            row['official_field'] or
                        exact_by_id[map_id]['official_alias_evidence']['raw'] !=
                            row['official_field_raw']
                        for map_id in row['map_ids']) for row in groups)):
            raise ValueError('Historical v3 official alias groups differ from accepted maps')
    return manifest, manifest_raw, {r['event_url']: r for r in events}, \
        {r['map_id']: r for r in exact}, {r['selected_mapstatsid']: r for r in cover}


def verified_source(row, event, cover, manifest, db, event_cache_dir, subpage_cache_dir,
                    page_cache):
    map_id = row['map_id']
    raw_day = row.get('date_raw', '')[:10]
    try:
        day = date.fromisoformat(raw_day)
        event_day = date.fromisoformat(row['event_start_date'])
    except (TypeError, ValueError) as error:
        raise ValueError(f'Historical map/event date is invalid: {map_id}') from error
    if (type(map_id) is not int or map_id <= 0 or
            row.get('scope_review_state') != 'candidate_exact_map_link' or
            row.get('match_evidence') != 'Match/Map.stats' or
            row.get('structure_status') != 'structurally_complete' or
            row.get('review_status') != 'unreviewed' or
            row.get('eligible_for_questions') is not False or
            row.get('tier') not in ('A-Tier', 'S-Tier') or
            not re.fullmatch(r'[0-9a-f]{64}', row.get('source_revision_sha256', '')) or
            not re.fullmatch(r'[0-9a-f]{64}', row.get('record_sha256', '')) or
            day >= date(2023, 7, 13) or event_day >= date(2023, 7, 13)):
        raise ValueError(f'Historical map lacks exact eligible scope: {map_id}')
    if (not event or event.get('scope_review_state') != 'index_and_page_tier_date_agree' or
            event.get('scope_flags') or row['tier'] != event.get('page_tier') or
            row['event_start_date'] != event.get('start_date') or
            row.get('event_end_date') != event.get('page_end_date') or
            row['event_name'] != event.get('event_name') or
            row['index_sha256'] != event.get('index_sha256') or
            row['index_url'] != event.get('index_url')):
        raise ValueError(f'Historical event scope conflicts with exact map: {map_id}')
    index_inputs = manifest['inputs']['index_pages']
    if not any(input_row['source_url'] == row['index_url'] and
               input_row['raw']['sha256'] == row['index_sha256']
               for input_row in index_inputs.values()):
        raise ValueError(f'Historical index checksum conflicts with map: {map_id}')
    previous = db.execute('SELECT source_url,date_raw,structure_status,review_status,record_sha256,record_json '
                          'FROM maps WHERE map_id=?', (map_id,)).fetchone()
    if not previous or previous[:5] != (row['hltv_map_url'], row['date_raw'],
                                         row['structure_status'], row['review_status'],
                                         row['record_sha256']):
        raise ValueError(f'Frozen old map differs from catalog: {map_id}')
    old_record = json.loads(previous[5])
    if (old_record.get('metadata', {}).get('event_raw') != row['event_raw'] or
            old_record.get('source_url') != row['hltv_map_url'] or
            old_record.get('record_sha256') != row['record_sha256']):
        raise ValueError(f'Frozen old event/record differs from catalog: {map_id}')
    if row['source_page_url'] != row['event_url'] and not row['source_page_url'].startswith(
            row['event_url'] + '/'):
        raise ValueError(f'Unrelated result subpage for map: {map_id}')
    parent_url = row['event_url']
    source_url = row['source_page_url']
    for url, directory, inputs_key in ((parent_url, event_cache_dir, 'cached_event_pages'),
                                       (source_url, event_cache_dir if source_url == parent_url
                                        else subpage_cache_dir,
                                        'cached_event_pages' if source_url == parent_url
                                        else 'cached_result_subpages')):
        if url in page_cache:
            continue
        loaded = event_cache(directory, url)
        if loaded is None:
            raise ValueError(f'Frozen event page is missing: {url}')
        wiki, meta = loaded
        if manifest['inputs'][inputs_key].get(url) != meta['sha256']:
            raise ValueError(f'Frozen event page SHA differs: {url}')
        wiki = re.sub(r'<!--.*?-->', '', wiki, flags=re.S)
        page_cache[url] = (wiki, meta)
    parent_wiki, parent_meta = page_cache[parent_url]
    infobox = next(template_blocks(parent_wiki, 'Infobox league'), None)
    try:
        event_end = date.fromisoformat(inline_field(infobox, 'edate')) if infobox else None
    except (TypeError, ValueError) as error:
        raise ValueError(f'Event end date missing/invalid for map: {map_id}') from error
    if (not infobox or inline_field(infobox, 'liquipediatier') != row['tier'] or
            inline_field(infobox, 'sdate') != row['event_start_date'] or
            parent_meta['sha256'] != event.get('page_sha256') or
            event_end is None or event_end < event_day):
        raise ValueError(f'Frozen parent event tier/date/revision differs: {map_id}')
    if manifest['rule_version'] == scope_v3.RULE_VERSION:
        official = []
        for key in ('tickername', 'shortname'):
            raw = inline_field(infobox, key)
            if raw and len(raw) <= 100 and not re.search(r'[<>{}\[\]]', raw):
                official.append({'field': key, 'raw': raw})
        if official != event.get('official_short_names'):
            raise ValueError(f'Frozen official short-name fields differ from LP page: {map_id}')
    if not event_window(day, event_day, event_end):
        raise ValueError(f'Old map date is outside the event interval: {map_id}')
    source_wiki, source_meta = page_cache[source_url]
    if source_meta['sha256'] != row['source_revision_sha256']:
        raise ValueError(f'Frozen source revision differs for map: {map_id}')
    refs = extract_map_refs(source_wiki, source_url, source_meta['sha256']).get(map_id, set())
    if (row['hltv_series_id'], source_url, source_meta['sha256']) not in refs or \
            any(ref[0] != row['hltv_series_id'] for ref in refs):
        raise ValueError(f'Exact Match/Map.stats reference differs for map: {map_id}')
    match_proof = source_match_proof(source_wiki, map_id, row['hltv_series_id'])
    if not event_window(date.fromisoformat(match_proof['match_date']), event_day, event_end) or \
            abs((date.fromisoformat(match_proof['match_date']) - day).days) > 1:
        raise ValueError(f'LP Match date disagrees with event/old map: {map_id}')
    if manifest['rule_version'] == scope_v3.RULE_VERSION:
        reasons, rule = scope_v3.exact_link_check(
            {'date_raw': row['date_raw'], 'event_raw': row['event_raw']}, event,
            match_date=match_proof['match_date'])
        expected_alias = scope_v3.official_alias_evidence(
            event, row['event_raw'], rule, match_proof['match_date'])
        if (row.get('liquipedia_match_date') != match_proof['match_date'] or
                row.get('official_alias_evidence') != expected_alias):
            raise ValueError(f'Official alias or Match date provenance differs: {map_id}')
    else:
        reasons, rule = exact_link_check({'date_raw': row['date_raw'],
                                          'event_raw': row['event_raw']}, event)
    if (reasons or not rule or row.get('event_name_match_status') != 'confirmed_by_code_rule' or
            row.get('event_name_match_rule') != rule):
        raise ValueError(f'Historical date/name rule differs from frozen catalog: '
                         f'{map_id}: {reasons}, {rule}')
    if cover:
        for key, old_key in (('hltv_map_url', 'hltv_map_url'),
                             ('hltv_series_id', 'hltv_series_id'),
                             ('event_url', 'event_url'), ('event_start_date', 'event_start_date'),
                             ('tier', 'tier'), ('source_page_url', 'source_page_url'),
                             ('source_revision_sha256', 'source_revision_sha256')):
            if cover[key] != row[old_key]:
                raise ValueError(f'Cover plan conflicts with exact map {map_id}: {key}')
        if cover['legacy_record_sha256'] != row['record_sha256']:
            raise ValueError(f'Cover plan old-row SHA conflicts with exact map: {map_id}')
        if manifest['rule_version'] == scope_v3.RULE_VERSION:
            for key in ('liquipedia_match_date', 'official_alias_evidence',
                        'event_name_match_status', 'event_name_match_rule'):
                if cover.get(key) != row.get(key):
                    raise ValueError(f'Cover plan official alias source conflicts: {map_id}: {key}')
    return {'event_start': event_day, 'event_end': event_end,
            'old_day': day, 'match': match_proof}


def validated_capture(row, raw, dates):
    map_id = row['map_id']
    capture = json.loads(raw)
    if (capture.get('source_url') != row['hltv_map_url'] or
            capture.get('event_url') != row['event_url'] or
            capture.get('hltv_series_id_from_liquipedia') != row['hltv_series_id'] or
            capture.get('source_revision_sha256') != row['source_revision_sha256'] or
            capture.get('roster_status') != 'unreviewed' or
            capture.get('eligible_for_questions') is not False or
            not isinstance(capture.get('authorization_status'), str) or
            not capture['authorization_status'].strip()):
        raise ValueError(f'Capture provenance conflicts with exact map: {map_id}')
    stamp = capture.get('captured_at_utc')
    try:
        if not isinstance(stamp, str) or datetime.fromisoformat(stamp.replace('Z', '+00:00')).utcoffset() != timedelta(0):
            raise ValueError()
    except (TypeError, ValueError) as error:
        raise ValueError(f'Capture time/provenance missing for map: {map_id}') from error
    checked = validate_capture(capture, map_id)
    if checked['event_as_displayed'] != row['event_raw']:
        raise ValueError(f'HLTV displayed event differs from frozen old map: {map_id}')
    try:
        captured_day = date.fromisoformat(checked['date_time_as_displayed'][:10])
    except (TypeError, ValueError) as error:
        raise ValueError(f'HLTV displayed map date is invalid: {map_id}') from error
    start_day, end_day, old_day = (dates[key] for key in ('event_start', 'event_end', 'old_day'))
    if not event_window(captured_day, start_day, end_day) or \
            abs((captured_day - old_day).days) > 2 or \
            abs((captured_day - date.fromisoformat(dates['match']['match_date'])).days) > 1:
        raise ValueError(f'HLTV map date disagrees with event/old map: {map_id}')
    if not map_names_agree(dates['match']['map_name'], checked['map_as_displayed']):
        raise ValueError(f'HLTV map name differs from LP Map for map: {map_id}')
    if sorted(team['score'] for team in checked['teams']) != sorted(dates['match']['map_scores']):
        raise ValueError(f'HLTV map score differs from LP Map for map: {map_id}')
    for team in checked['teams']:
        for player in team['players']:
            player_id = player['source_player_id']
            if not re.fullmatch(rf'https://www\.hltv\.org/stats/players/{player_id}/[^/?#\s]+',
                                player['source_player_url']):
                raise ValueError(f'Player URL has ambiguous numeric identity: {map_id}')
    return checked


def capture_signature(raw, map_id):
    capture = json.loads(raw)
    checked = validate_capture(capture, map_id)
    return (capture.get('source_url'), capture.get('event_url'),
            capture.get('hltv_series_id_from_liquipedia'),
            capture.get('source_revision_sha256'),
            checked['event_as_displayed'], checked['date_time_as_displayed'],
            checked['map_as_displayed'],
            tuple(sorted((team['name_as_displayed'], team['score'],
                          tuple(sorted((person['source_player_id']
                                        for person in team['players']), key=int)))
                         for team in checked['teams'])))


def capture_priority(path, map_id, source_order):
    # The hand-checked Katowice pilot remains the stable preferred copy when a
    # later bulk sweep re-fetches the same map with a new captured_at_utc.
    pilot = (map_id in PILOT_IDS and path.parent.name == 'captures' and
             path.parent.parent.name == 'historical-as-v1')
    return (0 if pilot else 1, source_order, str(path))


def find_captures(directories):
    grouped = {}
    found, matches, conflicts = {}, [], []
    for source_order, directory in enumerate(map(Path, directories)):
        if not directory.is_dir():
            continue
        for path in sorted(directory.glob('*.json')):
            if not path.stem.isdigit():
                continue
            map_id = int(path.stem)
            raw = path.read_bytes()
            grouped.setdefault(map_id, []).append((raw, path, source_order))
    inventory = {map_id: sorted(sha(raw) for raw, _, _ in entries)
                 for map_id, entries in grouped.items()}
    for map_id, entries in sorted(grouped.items()):
        if len(entries) == 1:
            raw, path, _ = entries[0]
            found[map_id] = (raw, path)
            continue
        try:
            signatures = {capture_signature(raw, map_id) for raw, _, _ in entries}
            if len(signatures) != 1:
                raise ValueError('Duplicate captures disagree on map/series/event/date/score/numeric lineup')
        except (ValueError, TypeError, KeyError, json.JSONDecodeError) as error:
            conflicts.append({'map_id': map_id, 'capture_sha256': inventory[map_id],
                              'reason': str(error)})
            continue
        raw, path, _ = min(entries,
                           key=lambda entry: capture_priority(entry[1], map_id, entry[2]))
        found[map_id] = (raw, path)
        matches.append({'map_id': map_id, 'preferred_sha256': sha(raw),
                        'all_capture_sha256': inventory[map_id]})
    return found, matches, conflicts, inventory


def failed_capture_attempts(directories, exact_ids, selected_ids, observed_ids):
    """Retain the latest collector failure for each still-unresolved exact map."""
    latest = {}
    for directory in map(Path, directories):
        log_path = directory / 'attempts.jsonl'
        if not log_path.is_file():
            continue
        for line in log_path.read_bytes().splitlines(keepends=True):
            # A collector may still be appending its final line.
            if not line.endswith(b'\n') or not line.strip():
                continue
            entry = json.loads(line)
            map_id = entry.get('mapstatsid')
            if type(map_id) is not int or map_id not in exact_ids or map_id in selected_ids:
                continue
            stamp = entry.get('at_utc')
            if not isinstance(stamp, str):
                raise ValueError('Capture attempt lacks timestamp')
            if map_id not in latest or stamp >= latest[map_id]['at_utc']:
                latest[map_id] = entry
    failures = []
    for map_id, entry in sorted(latest.items()):
        if entry.get('status') == 'captured':
            if map_id in observed_ids:
                status, reason = 'capture_unusable', 'Saved capture failed batch source or roster validation'
            else:
                status, reason = 'capture_file_missing', 'Collector reported success but validated JSON is absent'
        else:
            status = entry.get('status', 'unknown')
            reason = entry.get('error', 'Collector did not save a valid ten-player capture')
        failures.append({'map_id': map_id, 'status': status,
                         'reason': reason, 'last_attempt_at_utc': entry['at_utc']})
    return failures


def write_plan(directory, rows, catalog_manifest_sha, cover_plan_sha, old_db_sha):
    plan_raw = jsonl(rows)
    ledger_raw = b''
    report = {'schema_version': 1, 'selected_maps': len(rows),
              'catalog_manifest_sha256': catalog_manifest_sha,
              'cover_plan_sha256': cover_plan_sha, 'old_db_sha256': old_db_sha,
              'review_state': 'unreviewed', 'eligible_for_questions': False}
    report_raw = encoded(report)
    files = {'selected-series.jsonl': plan_raw, 'correction-ledger.jsonl': ledger_raw,
             'report.json': report_raw}
    manifest = {'schema_version': 1,
                'inputs': {'catalog_manifest_sha256': catalog_manifest_sha,
                           'capture_cover_plan_sha256': cover_plan_sha,
                           'old_db_sha256': old_db_sha,
                           'correction_ledger_sha256': sha(ledger_raw)},
                'files': {name: file_record(raw) for name, raw in files.items()}}
    directory.mkdir(parents=True)
    for name, raw in files.items():
        (directory / name).write_bytes(raw)
    (directory / 'manifest.json').write_bytes(encoded(manifest))
    read_plan(directory / 'selected-series.jsonl', directory / 'correction-ledger.jsonl')
    return plan_raw


def write_projection(directory, library_dir, plan_path):
    plan, plan_info, _, _ = read_plan(plan_path, plan_path.parent / 'correction-ledger.jsonl')
    plan_by_id = {row['selected_mapstatsid']: row for row in plan}
    candidate_manifest_raw = (library_dir / 'manifest.json').read_bytes()
    candidate_manifest = json.loads(candidate_manifest_raw)
    db_raw = (library_dir / 'library.sqlite3').read_bytes()
    candidate_report_raw = (library_dir / 'report.json').read_bytes()
    candidate_report = json.loads(candidate_report_raw)
    if (candidate_manifest.get('files', {}).get('library.sqlite3') != file_record(db_raw) or
            candidate_manifest.get('files', {}).get('report.json') != file_record(candidate_report_raw) or
            candidate_manifest.get('inputs', {}).get('plan_sha256') != plan_info['sha256'] or
            candidate_report.get('version') != candidate_manifest.get('version') or
            candidate_report.get('captured_valid_maps') != len(plan) or
            candidate_report.get('maps_with_incomplete_capture_provenance') != 0 or
            candidate_report.get('capture_provenance_gaps') != []):
        raise ValueError('Historical candidate library has incomplete provenance')
    db = sqlite3.connect((library_dir / 'library.sqlite3').resolve().as_uri() + '?mode=ro',
                         uri=True)
    try:
        db.row_factory = sqlite3.Row
        maps, all_evidence, all_players = validate_candidate_db(db, plan_by_id, len(plan))
    finally:
        db.close()
    excluded = []
    included = []
    for map_id, row in sorted(maps.items()):
        reason = automatic_exclusion_reason(row['event_as_displayed'])
        if reason:
            excluded.append({'map_id': map_id, 'reason': reason,
                             'event_as_displayed': row['event_as_displayed'],
                             'planned_event_url': row['event_url'],
                             'source_url': row['source_url']})
        else:
            included.append(map_id)
    if not included:
        raise ValueError('No historical maps remain after automatic scope exclusions')
    included_set = set(included)
    event_urls = sorted({maps[map_id]['event_url'] for map_id in included})
    evidence = {(a, b, map_id) for a, b, map_id, _ in all_evidence
                if map_id in included_set}
    pairs = {(a, b) for a, b, _ in evidence}
    players = {player for pair in pairs for player in pair}
    approval = {'kind': 'user_requested_legacy_import', 'play_scope': 'local',
                'individual_map_review': 'not_performed',
                'evidence_state': 'observed_unreviewed'}
    basis = {'schema_version': 1, 'candidate_version': candidate_manifest['version'],
             'candidate_db_sha256': sha(db_raw),
             'candidate_manifest_sha256': sha(candidate_manifest_raw),
             'included_map_ids': included, 'approved_event_urls': event_urls,
             'approval': approval}
    version = sha(js_json_bytes(basis))[:20]
    report = {'schema_version': 1, 'version': version,
              'status': 'user_requested_legacy_import_local_play_only',
              'candidate_version': candidate_manifest['version'],
              'approved_event_count': len(event_urls),
              'playable_event_count': len(event_urls),
              'sampled_map_count': len(maps), 'included_map_count': len(included),
              'excluded_map_count': len(excluded), 'excluded_maps': excluded,
              'included_player_count': len(players), 'included_pair_count': len(pairs),
              'included_pair_map_evidence_count': len(evidence),
              'candidate_player_count': all_players,
              'map_review_state': 'observed_unreviewed',
              'individual_map_review': 'not_performed',
              'eligible_for_local_play': True, 'eligible_for_public_release': False,
              'coverage': 'exact_map_link_and_actual_ten_player_capture_only',
              'date_time_policy': 'source_display_only_timezone_unverified',
              'approval_source_sha256': sha(plan_path.read_bytes())}
    report_raw = encoded(report)
    manifest = {**basis, 'version': version,
                'approved_event_count': len(event_urls),
                'included_map_count': len(included), 'excluded_maps': excluded,
                'approval_id': 'historical-as-batch-user-requested',
                'approval_source_sha256': sha(plan_path.read_bytes()),
                'source': {'candidate_report_sha256': sha(candidate_report_raw),
                           'candidate_plan_sha256': plan_info['sha256'],
                           'candidate_capture_set_sha256': candidate_manifest['inputs']['capture_set_sha256']},
                'files': {'report.json': file_record(report_raw)}}
    directory.mkdir(parents=True)
    (directory / 'report.json').write_bytes(report_raw)
    (directory / 'manifest.json').write_bytes(ordered_json_bytes(manifest))
    return report


def verified_batch_version(directory):
    batch_manifest_raw = (directory / 'manifest.json').read_bytes()
    batch_manifest = json.loads(batch_manifest_raw)
    for relative, expected in batch_manifest['files'].items():
        if file_record((directory / relative).read_bytes()) != expected:
            raise ValueError(f'Historical batch version has changed: {relative}')
    plan_path = directory / 'plan/selected-series.jsonl'
    plan, _, _, _ = read_plan(plan_path, directory / 'plan/correction-ledger.jsonl')
    captures_dir = directory / 'captures'
    if set(int(p.stem) for p in captures_dir.glob('*.json')) != \
            {row['selected_mapstatsid'] for row in plan}:
        raise ValueError('Historical batch capture set differs from its plan')
    for row in plan:
        raw = (captures_dir / f"{row['selected_mapstatsid']}.json").read_bytes()
        if file_record(raw) != batch_manifest['captures'][str(row['selected_mapstatsid'])]:
            raise ValueError('Historical batch capture changed after validation')
    projection = json.loads((directory / 'play/manifest.json').read_bytes())
    report_raw = (directory / 'play/report.json').read_bytes()
    if projection['files']['report.json'] != file_record(report_raw):
        raise ValueError('Historical projection report differs from its manifest')
    basis = {key: projection[key] for key in ('schema_version', 'candidate_version',
             'candidate_db_sha256', 'candidate_manifest_sha256', 'included_map_ids',
             'approved_event_urls', 'approval')}
    if (projection['version'] != sha(js_json_bytes(basis))[:20] or
            projection['candidate_db_sha256'] != sha((directory / 'library/library.sqlite3').read_bytes()) or
            projection['candidate_manifest_sha256'] != sha((directory / 'library/manifest.json').read_bytes())):
        raise ValueError('Historical projection version/input mismatch')
    return batch_manifest['version']


def promote(staging_base, output_dir=OUTPUT):
    """Atomically install a separately validated batch without reselecting captures."""
    source = (Path(staging_base) / 'current').resolve(strict=True)
    version = verified_batch_version(source)
    if source.name != version:
        raise ValueError('Staged current pointer does not name its verified version')
    output_dir = Path(output_dir)
    versions = output_dir / 'versions'
    versions.mkdir(parents=True, exist_ok=True)
    staged_plan, _, _, _ = read_plan(source / 'plan/selected-series.jsonl',
                                     source / 'plan/correction-ledger.jsonl')
    staged_ids = {row['selected_mapstatsid'] for row in staged_plan}
    with (output_dir / '.build.lock').open('a+b') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        pointer = output_dir / 'current'
        if pointer.exists() or pointer.is_symlink():
            if not pointer.is_symlink():
                raise ValueError('Historical current pointer is not a version symlink')
            previous = pointer.resolve(strict=True)
            if previous.parent != versions.resolve() or verified_batch_version(previous) != previous.name:
                raise ValueError('Historical current pointer targets an invalid version')
            prior_plan, _, _, _ = read_plan(previous / 'plan/selected-series.jsonl',
                                            previous / 'plan/correction-ledger.jsonl')
            missing = {row['selected_mapstatsid'] for row in prior_plan} - staged_ids
            if missing:
                raise ValueError(f'Staged promotion would remove prior historical maps: {sorted(missing)}')
        destination = versions / version
        if destination.exists():
            if (verified_batch_version(destination) != version or
                    (destination / 'manifest.json').read_bytes() != (source / 'manifest.json').read_bytes()):
                raise ValueError('Existing historical batch version conflicts with staged version')
        else:
            with tempfile.TemporaryDirectory(prefix='.legacy-promote-', dir=versions) as temporary:
                copied = Path(temporary) / version
                shutil.copytree(source, copied)
                verified_batch_version(copied)
                os.replace(copied, destination)
        temporary_link = output_dir / f'.current-{os.getpid()}'
        try:
            temporary_link.symlink_to(Path('versions') / version, target_is_directory=True)
            os.replace(temporary_link, pointer)
        finally:
            temporary_link.unlink(missing_ok=True)
    report = json.loads((destination / 'batch-report.json').read_bytes())
    report['current'] = str(destination.resolve())
    return report


def build(catalog_dir=CATALOG, old_db=OLD_DB, event_cache_dir=EVENT_CACHE,
          subpage_cache_dir=SUBPAGE_CACHE, capture_dirs=CAPTURE_DIRS,
          output_dir=OUTPUT, required_ids=PILOT_IDS):
    catalog_dir, old_db, event_cache_dir, subpage_cache_dir, output_dir = map(
        Path, (catalog_dir, old_db, event_cache_dir, subpage_cache_dir, output_dir))
    manifest, manifest_raw, events, exact, cover = read_catalog(catalog_dir, old_db)
    captures, duplicate_matches, duplicate_conflicts, capture_inventory = find_captures(capture_dirs)
    selected = []
    rejected = [row for row in duplicate_conflicts if row['map_id'] in exact]
    page_cache = {}
    old = sqlite3.connect(old_db.resolve().as_uri() + '?mode=ro', uri=True)
    try:
        for map_id in sorted(set(captures) & set(exact)):
            row = exact[map_id]
            try:
                dates = verified_source(row, events.get(row['event_url']), cover.get(map_id),
                                        manifest, old, event_cache_dir, subpage_cache_dir,
                                        page_cache)
                validated_capture(row, captures[map_id][0], dates)
                selected.append((row, cover.get(map_id), captures[map_id][0], dates['match']))
            except (ValueError, KeyError, TypeError, json.JSONDecodeError) as error:
                rejected.append({'map_id': map_id, 'capture_sha256': sha(captures[map_id][0]),
                                 'reason': str(error)})
    finally:
        old.close()
    selected_ids = {row['map_id'] for row, _, _, _ in selected}
    failed_attempts = failed_capture_attempts(capture_dirs, set(exact), selected_ids,
                                               set(capture_inventory))
    missing_pilots = set(required_ids) - selected_ids
    if missing_pilots:
        raise ValueError(f'Required historical maps missing/invalid: {sorted(missing_pilots)}; '
                         f'rejected={rejected}')
    if not selected:
        raise ValueError('No complete historical map captures are available')
    # Recheck the controlling manifest before publishing if another process
    # regenerated the catalog during selection.
    if (catalog_dir / 'manifest.json').read_bytes() != manifest_raw:
        raise ValueError('Historical catalog changed during selection')
    plan = []
    capture_records = {}
    for row, cover_row, raw, match in selected:
        map_id = row['map_id']
        series_url = cover_row['hltv_series_url'] if cover_row else \
            f"https://www.hltv.org/matches/{row['hltv_series_id']}/-"
        plan.append({'selected_mapstatsid': map_id,
                     'hltv_map_url': row['hltv_map_url'],
                     'hltv_series_id': row['hltv_series_id'],
                     'hltv_series_url': series_url,
                     'event_name': row['event_name'], 'event_url': row['event_url'],
                     'event_start_date': row['event_start_date'], 'tier': row['tier'],
                     'source_page_url': row['source_page_url'],
                     'source_revision_sha256': row['source_revision_sha256'],
                     'lp_match_date': match['match_date'],
                     'lp_match_team_labels': match['team_labels'],
                     'lp_map_name': match['map_name'],
                     'lp_map_scores': match['map_scores'],
                     'eligible_for_questions': False})
        capture_records[str(map_id)] = file_record(raw)
    input_basis = {'schema_version': 1, 'catalog_manifest_sha256': sha(manifest_raw),
                   'observed_capture_sha256': {str(key): value for key, value in
                                               sorted(capture_inventory.items())},
                   'selected_capture_sha256': {key: value['sha256'] for key, value in
                                               sorted(capture_records.items(), key=lambda item: int(item[0]))},
                   'failed_attempts_sha256': sha(jsonl(failed_attempts)),
                   'materializer_sha256': sha(Path(__file__).read_bytes()),
                   'candidate_builder_sha256': sha((ROOT / 'scripts/cslink_candidate_library.py').read_bytes()),
                   'projection_rules_sha256': sha((ROOT / 'scripts/cslink_local_play_projection.py').read_bytes())}
    batch_version = sha(js_json_bytes(input_basis))[:20]
    output_dir.mkdir(parents=True, exist_ok=True)
    versions = output_dir / 'versions'
    versions.mkdir(exist_ok=True)
    lock_path = output_dir / '.build.lock'
    with lock_path.open('a+b') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        pointer = output_dir / 'current'
        if pointer.exists() or pointer.is_symlink():
            if not pointer.is_symlink():
                raise ValueError('Historical current pointer is not a version symlink')
            previous = pointer.resolve(strict=True)
            if previous.parent != versions.resolve() or verified_batch_version(previous) != previous.name:
                raise ValueError('Historical current pointer targets an invalid version')
            previous_plan, _, _, _ = read_plan(previous / 'plan/selected-series.jsonl',
                                                previous / 'plan/correction-ledger.jsonl')
            prior_ids = {row['selected_mapstatsid'] for row in previous_plan}
            lost_ids = prior_ids - selected_ids
            if lost_ids:
                raise ValueError(f'Previously imported historical maps would disappear: '
                                 f'{sorted(lost_ids)}; rejected={rejected}')
        with tempfile.TemporaryDirectory(prefix='.legacy-batch-', dir=output_dir) as temporary:
            stage = Path(temporary)
            captures_dir = stage / 'captures'
            captures_dir.mkdir()
            for row, _, raw, _ in selected:
                (captures_dir / f"{row['map_id']}.json").write_bytes(raw)
            plan_raw = write_plan(stage / 'plan', plan, sha(manifest_raw),
                                  manifest['files']['capture-cover-plan.jsonl']['sha256'],
                                  manifest['inputs']['legacy_db_sha256'])
            candidate_report = build_library(stage / 'plan/selected-series.jsonl',
                                             captures_dir, stage / 'library',
                                             stage / 'plan/correction-ledger.jsonl')
            play_report = write_projection(stage / 'play', stage / 'library',
                                           stage / 'plan/selected-series.jsonl')
            remaining_cover = [row for map_id, row in sorted(cover.items()) if map_id not in selected_ids]
            remaining_exact = [row for map_id, row in sorted(exact.items()) if map_id not in selected_ids]
            (stage / 'remaining-cover-plan.jsonl').write_bytes(jsonl(remaining_cover))
            (stage / 'remaining-exact-map-queue.jsonl').write_bytes(jsonl(remaining_exact))
            rejected_by_id = {row['map_id']: row for row in rejected}
            attempt_by_id = {row['map_id']: row for row in failed_attempts}
            remaining_status = []
            for row in remaining_cover:
                map_id = row['selected_mapstatsid']
                if map_id in rejected_by_id:
                    state, reason = 'capture_rejected', rejected_by_id[map_id]['reason']
                elif map_id in attempt_by_id:
                    state, reason = attempt_by_id[map_id]['status'], attempt_by_id[map_id]['reason']
                else:
                    state, reason = 'not_attempted', 'No complete validated capture is available'
                remaining_status.append({'map_id': map_id, 'event_url': row['event_url'],
                                         'hltv_map_url': row['hltv_map_url'],
                                         'status': state, 'reason': reason})
            (stage / 'remaining-cover-status.jsonl').write_bytes(jsonl(remaining_status))
            report = {'schema_version': 1, 'version': batch_version,
                      'catalog_exact_maps': len(exact), 'catalog_cover_maps': len(cover),
                      'captured_files_with_exact_link': len(set(capture_inventory) & set(exact)),
                      'captured_files_without_exact_link': len(set(capture_inventory) - set(exact)),
                      'matching_duplicate_captures': duplicate_matches,
                      'included_capture_count': len(selected),
                      'playable_map_count': play_report['included_map_count'],
                      'automatically_excluded_map_count': play_report['excluded_map_count'],
                      'remaining_cover_maps': len(remaining_cover),
                      'remaining_exact_maps': len(remaining_exact),
                      'rejected_captures': rejected,
                      'failed_capture_attempts': failed_attempts,
                      'pilot_map_ids_preserved': sorted(set(required_ids) & selected_ids),
                      'by_year': dict(sorted(Counter(row['date_raw'][:4]
                         for row, _, _, _ in selected).items())),
                      'candidate_version': candidate_report['version'],
                      'projection_version': play_report['version'],
                      'review_state': 'unreviewed', 'eligible_for_public_release': False}
            (stage / 'batch-report.json').write_bytes(encoded(report))
            outputs = ('plan/manifest.json', 'plan/selected-series.jsonl',
                       'plan/correction-ledger.jsonl', 'library/manifest.json',
                       'library/library.sqlite3', 'library/report.json',
                       'play/manifest.json', 'play/report.json', 'batch-report.json',
                       'remaining-cover-plan.jsonl', 'remaining-exact-map-queue.jsonl',
                       'remaining-cover-status.jsonl')
            batch_manifest = {**input_basis, 'version': batch_version,
                              'captures': capture_records,
                              'files': {name: file_record((stage / name).read_bytes())
                                        for name in outputs}}
            (stage / 'manifest.json').write_bytes(encoded(batch_manifest))
            verified_batch_version(stage)
            destination = versions / batch_version
            if destination.exists():
                if verified_batch_version(destination) != batch_version:
                    raise ValueError('Existing historical batch version differs')
                if (destination / 'manifest.json').read_bytes() != (stage / 'manifest.json').read_bytes():
                    raise ValueError('Existing historical batch version conflicts with rebuilt output')
            else:
                os.replace(stage, destination)
            temporary_link = output_dir / f'.current-{os.getpid()}'
            try:
                temporary_link.symlink_to(Path('versions') / batch_version, target_is_directory=True)
                os.replace(temporary_link, pointer)
            finally:
                temporary_link.unlink(missing_ok=True)
    report['current'] = str((output_dir / 'current').resolve())
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--catalog', type=Path, default=CATALOG)
    parser.add_argument('--old-db', type=Path, default=OLD_DB)
    parser.add_argument('--event-cache', type=Path, default=EVENT_CACHE)
    parser.add_argument('--subpage-cache', type=Path, default=SUBPAGE_CACHE)
    parser.add_argument('--captures', type=Path, action='append', dest='capture_dirs')
    parser.add_argument('--output', type=Path, default=OUTPUT)
    parser.add_argument('--promote-from', type=Path,
                        help='Atomically adopt an already validated staging/current version')
    args = parser.parse_args()
    result = promote(args.promote_from, args.output) if args.promote_from else build(
        args.catalog, args.old_db, args.event_cache, args.subpage_cache,
        args.capture_dirs or CAPTURE_DIRS, args.output)
    print(json.dumps(result, ensure_ascii=False, indent=2))
