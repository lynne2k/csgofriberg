#!/usr/bin/env python3
"""Audit pre-2023-07-13 legacy maps against cached Liquipedia A/S pages.

An index-title match is only a lead. Only an exact Map.stats link on a cached
event page whose tier/date agree with its index row enters exact-map-queue.
Neither output approves player identities, teammate edges, or publication.
"""

import argparse
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta
from functools import lru_cache
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import tempfile
import unicodedata
from urllib.parse import quote

from cslink_tier_catalog import TournamentRows, candidate
from cslink_tier_enrich import digits_field, event_cache, template_blocks, without_showmatch_section


ROOT = Path(__file__).resolve().parents[1]
INDEX_DIR = ROOT / '.local-data/cslink/as-tier-api'
EVENT_CACHE = ROOT / '.local-data/cslink/legacy-as-event-pages'
SUBPAGE_CACHE = ROOT / '.local-data/cslink/legacy-as-result-subpages'
OLD_DB = ROOT / '.local-data/cslink/versions/69d3bb14fb82e70ea452/staging.sqlite3'
OUTPUT = ROOT / '.local-data/cslink/legacy-as-catalog-v3'
V2_BASELINE = ROOT / '.local-data/cslink/legacy-as-catalog-v2-015ecc29658c3fb6a81c'
V2_BASELINE_VERSION = '015ecc29658c3fb6a81c'
ALIAS_LEDGER = ROOT / 'data/cslink/legacy-event-aliases-2026-10-08.json'
ALIAS_CAPTURES = ROOT / '.local-data/cslink/legacy-hltv-capture-pilot'
RULE_VERSION = 'legacy-exact-scope-v3-official-shortname'
ALIAS_LEDGER_RULE_VERSION = 'legacy-exact-scope-v2'
CUTOFF = date(2023, 7, 13)  # This day overlaps the newer source; audit separately.
INDEX_PAGES = {
    'S-Tier_Tournaments--2012-2023': 'S',
    'A-Tier_Tournaments--2016-2023': 'A',
}
BLOCKING_FLAGS = {'cancelled', 'independent_major_qualifier', 'date_unparsed',
                  'index_tier_conflict', 'index_date_conflict', 'page_tier_mismatch',
                  'page_start_date_mismatch', 'page_end_date_missing_or_invalid'}


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def file_record(raw):
    return {'bytes': len(raw), 'sha256': sha256(raw)}


def normalized_title(value):
    """Conservative title lookup; never an identity or scope approval key."""
    value = value.casefold().replace('intel extreme masters', 'iem')
    value = unicodedata.normalize('NFKD', value)
    value = ''.join(char for char in value if not unicodedata.combining(char))
    return ' '.join(re.findall(r'[a-z0-9]+', value))


STAGE_SUFFIXES = (' play in', ' challengers stage', ' legends stage',
                  ' champions stage', ' opening stage', ' elimination stage',
                  ' group stage', ' main event', ' playoffs')
SEPARATE_SCOPE_WORDS = re.compile(
    r'\b(?:qualifier|qualification|regionals?|relegation|showmatch|show match|all star)\b', re.I)
TICKER_SCOPE_EXCLUSIONS = re.compile(
    r'\b(?:qualifier|qualification|regionals?|relegation|showmatch|show match|all star|minor)\b',
    re.I)


@lru_cache(maxsize=1)
def explicit_aliases():
    ledger = json.loads(ALIAS_LEDGER.read_text())
    if ledger.get('schema_version') != 1 or ledger.get('rule_version') != ALIAS_LEDGER_RULE_VERSION:
        raise ValueError('Legacy alias ledger version mismatch')
    aliases = {}
    for row in ledger['aliases']:
        key = (row['event_url'], normalized_title(row['legacy_event_raw']))
        if key in aliases or not row['event_url'].startswith('https://liquipedia.net/counterstrike/'):
            raise ValueError('Duplicate or invalid legacy event alias')
        aliases[key] = row
    return aliases


@lru_cache(maxsize=32)
def explicit_alias_evidence_valid(event_url, normalized_raw, capture_dir):
    row = explicit_aliases().get((event_url, normalized_raw))
    if row is None:
        return False
    path = Path(capture_dir) / f"{row['evidence_map_id']}.json"
    if not path.is_file():
        return False
    raw = path.read_bytes()
    if sha256(raw) != row['capture_sha256']:
        return False
    capture = json.loads(raw)
    rows = capture.get('rows')
    return (capture.get('source_url') == row['hltv_map_url'] and
            capture.get('event_url') == row['event_url'] and
            isinstance(rows, list) and len(rows) == 10 and
            all(isinstance(item, dict) and item.get('details', {}).get('event') ==
                row['legacy_event_raw'] for item in rows))


def title_compatibility(raw_name, event_name, event_year, event_url=None,
                        official_short_names=()):
    """Require a defensible legacy-title correspondence, never just a map ID.

    Return a named rule for accepted aliases. Unknown abbreviations remain in
    the quarantine file for manual review rather than becoming playable data.
    """
    if not isinstance(raw_name, str) or not raw_name.strip():
        return None
    raw = normalized_title(raw_name)
    official = normalized_title(event_name)
    if not raw or not official:
        return None
    # Regionals or an independent qualifier must not borrow the parent event's
    # A/S tier merely because a result template contains its map ID.
    if SEPARATE_SCOPE_WORDS.search(raw) and not SEPARATE_SCOPE_WORDS.search(official):
        return None
    if raw == official:
        return 'normalized_title_exact'
    for suffix in STAGE_SUFFIXES:
        if raw.endswith(suffix) and raw[:-len(suffix)] == official:
            return 'main_event_stage_suffix'
    year = str(event_year)
    if raw == official + ' ' + year:
        return 'index_title_plus_event_year'
    for suffix in STAGE_SUFFIXES:
        if raw.endswith(suffix) and raw[:-len(suffix)] == official + ' ' + year:
            return 'index_title_plus_year_and_stage'
    # IEM's archived index often uses a Roman season while HLTV/old CSV use
    # the venue and calendar year. The venue/region words must still match.
    if official.startswith('iem '):
        official_tokens = official.split()
        if len(official_tokens) > 2 and re.fullmatch(r'[ivxlcdm]+', official_tokens[1]):
            official_tokens.pop(1)
            official_tokens = [token for token in official_tokens if token not in {'online', 'major'}]
            raw_tokens = raw.split()
            raw_tokens = [token for token in raw_tokens if token != year]
            for suffix in STAGE_SUFFIXES:
                suffix_tokens = suffix.strip().split()
                if raw_tokens[-len(suffix_tokens):] == suffix_tokens:
                    raw_tokens = raw_tokens[:-len(suffix_tokens)]
                    break
            if raw_tokens == official_tokens:
                return 'iem_season_venue_year_alias'
    alias = explicit_aliases().get((event_url, raw)) if event_url else None
    if alias and normalized_title(alias['event_name']) == official:
        return f"explicit_hltv_map_event_alias:{alias['evidence_map_id']}"
    if not TICKER_SCOPE_EXCLUSIONS.search(raw):
        for short in official_short_names:
            if normalized_title(short['raw']) == raw:
                return f"official_infobox_{short['field']}_exact"
    return None


def exact_link_check(record, event, alias_capture_dir=ALIAS_CAPTURES, match_date=None):
    """Validate one LP map reference against the old map's date and title."""
    reasons = []
    try:
        day = date.fromisoformat((record['date_raw'] or '')[:10])
        start = date.fromisoformat(event['page_start_date'])
        end = date.fromisoformat(event['page_end_date'])
        if end < start:
            reasons.append('event_end_before_start')
        elif not start - timedelta(days=2) <= day <= end + timedelta(days=2):
            reasons.append('outside_event_date_window')
    except (TypeError, ValueError):
        reasons.append('date_unparseable')
    rule = title_compatibility(record['event_raw'], event['event_name'],
                               event['page_start_date'][:4] if event['page_start_date'] else '',
                               event['event_url'], event.get('official_short_names', ()))
    if rule is None:
        reasons.append('legacy_event_title_unconfirmed')
    elif rule.startswith('explicit_hltv_map_event_alias:') and not explicit_alias_evidence_valid(
            event['event_url'], normalized_title(record['event_raw']), str(alias_capture_dir)):
        reasons.append('explicit_alias_evidence_unavailable')
    elif rule.startswith('official_infobox_'):
        try:
            map_day = date.fromisoformat((record['date_raw'] or '')[:10])
            lp_day = date.fromisoformat(match_date)
            if abs((map_day - lp_day).days) > 1:
                reasons.append('official_shortname_match_date_mismatch')
        except (TypeError, ValueError):
            reasons.append('official_shortname_match_date_unavailable')
    return reasons, rule


def official_alias_evidence(event, raw_name, rule, match_date):
    if not rule or not rule.startswith('official_infobox_'):
        return None
    field = rule.removeprefix('official_infobox_').removesuffix('_exact')
    for short in event['official_short_names']:
        if short['field'] == field and normalized_title(short['raw']) == normalized_title(raw_name):
            return {'field': field, 'raw': short['raw'], 'event_page_url': event['event_url'],
                    'event_page_sha256': event['page_sha256'],
                    'event_page_revision_timestamp': event['page_revision_timestamp'],
                    'liquipedia_match_date': match_date}
    raise ValueError('Accepted official short name lacks source-page evidence')


def load_indices(index_dir, cutoff=CUTOFF):
    events = {}
    inputs = {}
    for stem, tier in INDEX_PAGES.items():
        path = index_dir / f'{stem}.json'
        meta_path = index_dir / f'{stem}.meta.json'
        raw, meta_raw = path.read_bytes(), meta_path.read_bytes()
        meta = json.loads(meta_raw)
        if sha256(raw) != meta.get('sha256') or meta.get('page') != stem.replace('--', '/'):
            raise ValueError(f'Index cache checksum/page mismatch: {path}')
        parsed = json.loads(raw).get('parse', {}).get('text')
        if not isinstance(parsed, str):
            raise ValueError(f'Missing parsed index HTML: {path}')
        parser = TournamentRows()
        parser.feed(parsed)
        index_url = 'https://liquipedia.net/counterstrike/' + meta['page']
        inputs[stem] = {'raw': file_record(raw), 'meta': file_record(meta_raw),
                        'source_url': index_url}
        for row in parser.rows:
            item = candidate(row, tier, index_url)
            if not item:
                continue
            begun = item['start_date']
            if begun is not None and begun >= cutoff.isoformat():
                continue
            if begun is None and (row['year'] is None or row['year'] >= cutoff.year):
                # 2023 rows with no date might be after the boundary: never guess.
                continue
            item['scope_flags'] = [flag for flag in item['scope_flags'] if flag != 'outside_window']
            item.pop('hltv_event_id', None)
            item.pop('map_count', None)
            item['index_sha256'] = meta['sha256']
            prior = events.get(item['event_url'])
            if prior:
                if prior['index_tier'] != item['index_tier']:
                    prior['scope_flags'].append('index_tier_conflict')
                if prior['start_date'] != item['start_date']:
                    prior['scope_flags'].append('index_date_conflict')
                continue
            events[item['event_url']] = item
    return events, inputs


def event_page_details(event, cache_dir):
    loaded = event_cache(cache_dir, event['event_url'])
    event.update({'page_tier': None, 'page_start_date': None, 'page_end_date': None,
                  'page_revision_timestamp': None, 'page_sha256': None,
                  'official_short_names': [],
                  'exact_map_ids_on_page': 0, 'result_subpages_discovered': 0,
                  'result_subpages_cached': 0})
    if loaded is None:
        event['scope_review_state'] = 'index_candidate_page_missing'
        return {}
    wiki, meta = loaded  # event_cache verifies the raw cache checksum and URL.
    wiki = re.sub(r'<!--.*?-->', '', wiki, flags=re.S)
    infobox = next(template_blocks(wiki, 'Infobox league'), None)
    tier_match = re.search(r'\|\s*liquipediatier\s*=\s*([AS]-Tier)(?=\s*[|}\r\n])',
                           infobox, re.I) if infobox else None
    event['page_tier'] = tier_match.group(1) if tier_match else None
    # Some old infoboxes put |edate= on the same line as |sdate=; the generic
    # field reader would swallow both fields and create a false conflict.
    start_match = re.search(r'\|\s*sdate\s*=\s*(\d{4}-\d\d-\d\d)(?=\s*[|}\r\n])',
                            infobox, re.I) if infobox else None
    end_match = re.search(r'\|\s*edate\s*=\s*(\d{4}-\d\d-\d\d)(?=\s*[|}\r\n])',
                          infobox, re.I) if infobox else None
    event['page_start_date'] = start_match.group(1) if start_match else None
    event['page_end_date'] = end_match.group(1) if end_match else None
    for field in ('tickername', 'shortname'):
        match = re.search(r'\|\s*' + field + r'\s*=\s*([^|}\r\n]*)', infobox, re.I) if infobox else None
        if match:
            raw = match.group(1).strip()
            # Rich wiki markup can contain several aliases or expansions;
            # only a plain, single value is a usable official short name.
            if raw and len(raw) <= 100 and not re.search(r'[<>{}\[\]]', raw):
                event['official_short_names'].append({'field': field, 'raw': raw})
    event['page_revision_timestamp'] = meta.get('revision_timestamp')
    event['page_sha256'] = meta['sha256']
    if event['page_tier'] != event['index_tier'] + '-Tier':
        event['scope_flags'].append('page_tier_mismatch')
    if event['page_start_date'] != event['start_date']:
        event['scope_flags'].append('page_start_date_mismatch')
    if (event['page_end_date'] is None or
            (event['page_start_date'] and event['page_end_date'] < event['page_start_date'])):
        event['scope_flags'].append('page_end_date_missing_or_invalid')
    event['scope_flags'] = sorted(set(event['scope_flags']))
    if set(event['scope_flags']) & BLOCKING_FLAGS:
        event['scope_review_state'] = 'needs_scope_review'
        return {}
    event['scope_review_state'] = 'index_and_page_tier_date_agree'
    return wiki, meta


def result_subpages(event, wiki, meta):
    """Find bounded result transclusions under this exact event title."""
    titles = re.findall(r'\{\{#section\s*:\s*([^|}]+)\s*\|\s*Results\s*\}\}', wiki, re.I)
    relative = re.findall(r'\{\{ShowStandings\s*\|\s*page=\{\{PAGENAME\}\}/([^}|]+)', wiki, re.I)
    titles += [meta['page_title'] + '/' + suffix.strip() for suffix in relative]
    titles += re.findall(r'\{\{ShowStandings\s*\|\s*page=(?!\{\{PAGENAME\}\})([^}|]+)',
                         wiki, re.I)
    titles += re.findall(r'\{\{#lst\s*:\s*([^|}]+)', wiki, re.I)
    titles += re.findall(r'\[\[([^|\]]+)\|[^\]]*click here[^\]]*\]\]', wiki, re.I)
    urls, rejected = [], []
    prefix = meta['page_title'] + '/'
    for title in sorted(set(titles)):
        title = title.strip()
        suffix = title[len(prefix):] if title.casefold().startswith(prefix.casefold()) else ''
        if (not suffix or '/' in suffix or len(suffix) > 80 or
                re.search(r'qualif|show.?match|all.?star', suffix, re.I) or
                not re.search(r'stage|playoff|group|final|result', suffix, re.I)):
            rejected.append({'parent_event_url': event['event_url'], 'title': title,
                             'reason': 'out_of_scope_or_unrecognized_result_subpage'})
            continue
        urls.append('https://liquipedia.net/counterstrike/' +
                    quote(title.replace(' ', '_'), safe='/'))
    return sorted(set(urls)), rejected


def match_day(block):
    found = re.search(r'\|\s*date\s*=\s*([A-Za-z]+\s+\d{1,2},\s*\d{4}|\d{4}-\d\d-\d\d)',
                      block, re.I)
    if not found:
        return None
    value = found.group(1)
    for pattern in ('%B %d, %Y', '%Y-%m-%d'):
        try:
            return datetime.strptime(value, pattern).date().isoformat()
        except ValueError:
            pass
    return None


def extract_map_refs(wiki, source_url, source_sha):
    references = defaultdict(set)
    for block in template_blocks(without_showmatch_section(wiki), 'Match'):
        series_id = digits_field(block, 'hltv')
        if series_id is None:
            continue
        series_day = match_day(block)
        for map_block in template_blocks(block, 'Map'):
            map_id = digits_field(map_block, 'stats')
            if map_id is not None and 0 < map_id < 1_000_000 and map_id != series_id:
                references[map_id].add((series_id, source_url, source_sha, series_day))
    return references


def read_old_maps(db_path):
    uri = db_path.resolve().as_uri() + '?mode=ro'
    db = sqlite3.connect(uri, uri=True)
    try:
        db.execute('PRAGMA query_only=ON')
        if db.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise ValueError('Legacy staging SQLite integrity check failed')
        for map_id, source_url, date_raw, structure_status, review_status, fingerprint, record_raw in db.execute(
                'SELECT map_id,source_url,date_raw,structure_status,review_status,record_sha256,record_json FROM maps ORDER BY map_id'):
            metadata = json.loads(record_raw).get('metadata') or {}
            yield {'map_id': map_id, 'hltv_map_url': source_url,
                   'date_raw': date_raw, 'event_raw': metadata.get('event_raw'),
                   'structure_status': structure_status, 'review_status': review_status,
                   'record_sha256': fingerprint}
    finally:
        db.close()


def matched_event(record, title_index, cutoff=CUTOFF):
    """Return a single conservative index-title lead, or a reason for review."""
    raw_date = record['date_raw']
    if not raw_date or not re.fullmatch(r'\d{4}-\d\d-\d\d(?: .*)?', raw_date):
        return None, 'missing_or_invalid_map_date'
    try:
        day = date.fromisoformat(raw_date[:10])
    except ValueError:
        return None, 'missing_or_invalid_map_date'
    if day >= cutoff:
        return None, 'outside_legacy_window'
    title = record['event_raw']
    if not isinstance(title, str) or not title.strip():
        return None, 'missing_legacy_event_name'
    candidates = title_index.get(normalized_title(title), [])
    if not candidates:
        return None, 'index_title_not_matched'
    valid = []
    blocked = False
    for event in candidates:
        if set(event['scope_flags']) & BLOCKING_FLAGS:
            blocked = True
            continue
        start = date.fromisoformat(event['start_date'])
        # The old CSV timezone is unspecified; +/- 2 days tolerates a date shift.
        if start - timedelta(days=2) <= day <= start + timedelta(days=60):
            valid.append(event)
    if len(valid) == 1:
        return valid[0], None
    if len(valid) > 1:
        return None, 'ambiguous_index_title'
    return None, 'excluded_or_conflicted_index_event' if blocked else 'index_title_date_mismatch'


def jsonl_bytes(rows):
    return ''.join(json.dumps(row, ensure_ascii=False, sort_keys=True) + '\n' for row in rows).encode()


def verified_baseline(baseline_dir):
    if baseline_dir is None:
        return {}, None
    baseline_dir = Path(baseline_dir)
    manifest_raw = (baseline_dir / 'manifest.json').read_bytes()
    manifest = json.loads(manifest_raw)
    if manifest.get('version') != V2_BASELINE_VERSION or manifest.get('rule_version') != 'legacy-exact-scope-v2':
        raise ValueError('Expected immutable v2 baseline manifest')
    queue_raw = (baseline_dir / 'exact-map-queue.jsonl').read_bytes()
    if file_record(queue_raw) != manifest['files']['exact-map-queue.jsonl']:
        raise ValueError('v2 exact-map-queue differs from baseline manifest')
    rows = {row['map_id']: row for row in map(json.loads, queue_raw.splitlines())}
    if len(rows) != len(queue_raw.splitlines()):
        raise ValueError('Duplicate map ID in v2 baseline queue')
    return rows, {'version': manifest['version'], 'manifest_sha256': sha256(manifest_raw),
                  'exact_map_queue_sha256': sha256(queue_raw)}


def capture_cover_plan(old_db, exact_queue, interval_seconds=10):
    """Cover each raw team label and each unassigned five-name group per event.

    The legacy source does not reliably map statistic groups to named teams.
    Sampling every distinct group is conservative, but does not establish the
    team's player identities. HLTV capture must do that for every selected map.
    """
    by_event = defaultdict(list)
    series_maps = defaultdict(list)
    for row in exact_queue:
        series_maps[row['hltv_series_id']].append(row['map_id'])
    db = sqlite3.connect(old_db.resolve().as_uri() + '?mode=ro', uri=True)
    try:
        for row in exact_queue:
            found = db.execute('SELECT record_sha256,record_json FROM maps WHERE map_id=?',
                               (row['map_id'],)).fetchone()
            if not found or found[0] != row['record_sha256']:
                raise ValueError(f'Legacy record changed while building capture plan: {row["map_id"]}')
            record = json.loads(found[1])
            teams = sorted(set(name.strip() for name in
                               (record.get('metadata') or {}).get('teams_display', [])
                               if isinstance(name, str) and name.strip()))
            groups = []
            for group in record.get('stat_groups', []):
                names = group.get('names_raw', [])
                if (len(names) == 5 and all(isinstance(name, str) and name.strip()
                                            for name in names) and len(set(names)) == 5):
                    groups.append(sorted(names))
            units = {('team', name) for name in teams}
            units.update(('raw_group', sha256(json.dumps(names, ensure_ascii=False).encode()))
                         for names in groups)
            by_event[row['event_url']].append((row, teams, groups, units))
    finally:
        db.close()
    selected = []
    team_units = raw_group_units = 0
    for event_url, choices in sorted(by_event.items()):
        remaining = set().union(*(choice[3] for choice in choices))
        team_units += sum(kind == 'team' for kind, _ in remaining)
        raw_group_units += sum(kind == 'raw_group' for kind, _ in remaining)
        while remaining:
            best = max(choices, key=lambda choice: (
                len(choice[3] & remaining),
                len(choice[2]) == 2 and choice[0]['structure_status'] == 'structurally_complete',
                -choice[0]['map_id']))
            row, teams, groups, units = best
            if not units & remaining:
                raise ValueError(f'Unable to cover raw team/group units: {event_url}')
            selected.append({
                'selected_mapstatsid': row['map_id'],
                'hltv_map_url': row['hltv_map_url'],
                'hltv_series_id': row['hltv_series_id'],
                'hltv_series_url': f'https://www.hltv.org/matches/{row["hltv_series_id"]}/-',
                'hltv_link_status': 'old_map_url_and_liquipedia_series_id; series_slug_constructed',
                'event_url': row['event_url'], 'event_name': row['event_name'],
                'event_start_date': row['event_start_date'], 'tier': row['tier'],
                'source_page_url': row['source_page_url'],
                'source_revision_sha256': row['source_revision_sha256'],
                'liquipedia_match_date': row['liquipedia_match_date'],
                'official_alias_evidence': row['official_alias_evidence'],
                'legacy_record_sha256': row['record_sha256'],
                'event_name_match_status': row['event_name_match_status'],
                'event_name_match_rule': row['event_name_match_rule'],
                'candidate_mapstatsids_in_series': sorted(series_maps[row['hltv_series_id']]),
                'team_labels_raw_unassigned_to_groups': teams,
                'raw_nickname_groups_unassigned': groups,
                'selection_reason': 'cover_each_event_raw_team_and_unassigned_five_name_group',
                'roster_status': 'unverified', 'eligible_for_questions': False,
            })
            remaining -= units
    selected.sort(key=lambda row: (row['event_url'], row['selected_mapstatsid']))
    selected_map_ids = [row['selected_mapstatsid'] for row in selected]
    if len(selected_map_ids) != len(set(selected_map_ids)):
        raise ValueError('Capture plan selected one map twice')
    duplicated_series = Counter(row['hltv_series_id'] for row in selected)
    report = {'eligible_events_with_exact_maps': len(by_event),
              'candidate_exact_maps': len(exact_queue),
              'selected_maps': len(selected),
              'selected_distinct_series': len(duplicated_series),
              'series_with_multiple_selected_maps': sum(n > 1 for n in duplicated_series.values()),
              'covered_raw_team_labels_per_event': team_units,
              'covered_unassigned_five_name_groups_per_event': raw_group_units,
              'minimum_interval_seconds': interval_seconds,
              'minimum_request_start_span_minutes': round(max(0, len(selected)-1) * interval_seconds / 60, 1),
              'illustrative_15_seconds_per_map_minutes': round(len(selected) * 15 / 60, 1),
              'note': 'The 15-second figure is a planning scenario, not an observed throughput or promise. '
                      'Raw five-name groups are unassigned to teams; map captures must bind numeric HLTV IDs. '
                      'Multiple maps from one series may be selected if raw groups differ.'}
    return selected, report


def build(index_dir=INDEX_DIR, event_cache_dir=EVENT_CACHE, old_db=OLD_DB,
          output_dir=OUTPUT, cutoff=CUTOFF, subpage_cache_dir=SUBPAGE_CACHE,
          baseline_dir=V2_BASELINE):
    index_dir, event_cache_dir, old_db, output_dir, subpage_cache_dir = map(
        Path, (index_dir, event_cache_dir, old_db, output_dir, subpage_cache_dir))
    old_raw_sha = sha256(old_db.read_bytes())
    old_manifest_path = old_db.parent / 'manifest.json'
    if old_manifest_path.is_file():
        old_manifest = json.loads(old_manifest_path.read_text())
        expected = old_manifest.get('artifacts', {}).get(old_db.name)
        if expected != old_raw_sha:
            raise ValueError('Legacy staging SQLite differs from source manifest')
    events, index_inputs = load_indices(index_dir, cutoff)
    exact_refs = defaultdict(list)
    subpage_targets, rejected_subpages, cached_subpage_shas = {}, [], {}
    for event in events.values():
        page = event_page_details(event, event_cache_dir)
        if not page:
            continue
        wiki, meta = page
        references = extract_map_refs(wiki, event['event_url'], event['page_sha256'])
        children, rejected = result_subpages(event, wiki, meta)
        event['result_subpages_discovered'] = len(children)
        rejected_subpages.extend(rejected)
        for url in children:
            subpage_targets[url] = {'event_url': url, 'parent_event_url': event['event_url'],
                                    'event_name': event['event_name']}
            child = event_cache(subpage_cache_dir, url)
            if child is None:
                continue
            child_wiki, child_meta = child
            cached_subpage_shas[url] = child_meta['sha256']
            event['result_subpages_cached'] += 1
            for map_id, refs in extract_map_refs(child_wiki, url, child_meta['sha256']).items():
                references[map_id].update(refs)
        event['exact_map_ids_on_page'] = len(references)
        for map_id, refs in references.items():
            for series_id, source_url, source_sha, series_day in refs:
                exact_refs[map_id].append((event, series_id, source_url, source_sha, series_day))
    events_sorted = sorted(events.values(), key=lambda e: (e['start_date'] or '', e['event_url']))
    fetch_catalog = [{'event_url': event['event_url'], 'event_name': event['event_name']}
                     for event in events_sorted
                     if event['start_date'] and not set(event['scope_flags']) & {
                         'cancelled', 'independent_major_qualifier', 'date_unparsed',
                         'index_tier_conflict', 'index_date_conflict'}]
    title_index = defaultdict(list)
    for event in events_sorted:
        title_index[normalized_title(event['event_name'])].append(event)
    candidates, exact_queue, quarantined_exact = [], [], []
    unresolved = defaultdict(lambda: {'maps': 0, 'example_map_ids': []})
    by_year = defaultdict(Counter)
    by_tier = Counter()
    total_before_cutoff = overlap_day = 0
    for record in read_old_maps(old_db):
        raw_date = record['date_raw']
        if raw_date and raw_date[:10] == cutoff.isoformat():
            overlap_day += 1
        if not raw_date or raw_date[:10] >= cutoff.isoformat():
            continue
        total_before_cutoff += 1
        year = raw_date[:4]
        by_year[year]['old_maps'] += 1
        lead, reason = matched_event(record, title_index, cutoff)
        links = exact_refs.get(record['map_id'], [])
        # The same map can be transcluded on both parent and child pages.
        unique_links = {(event['event_url'], series_id) for event, series_id, _, _, _ in links}
        accepted_exact = False
        if len(unique_links) == 1:
            event, series_id, source_page_url, source_revision_sha, series_day = sorted(
                links, key=lambda item: (item[2] != item[0]['event_url'], item[2]))[0]
            problems, title_rule = exact_link_check(record, event, match_date=series_day)
            alias_evidence = official_alias_evidence(event, record['event_raw'], title_rule, series_day)
            if problems:
                quarantined_exact.append({**record, 'event_url': event['event_url'],
                                          'event_name': event['event_name'],
                                          'event_start_date': event['page_start_date'],
                                          'event_end_date': event['page_end_date'],
                                          'source_page_url': source_page_url,
                                          'source_revision_sha256': source_revision_sha,
                                          'hltv_series_id': series_id,
                                          'liquipedia_match_date': series_day,
                                          'official_alias_evidence': alias_evidence,
                                          'event_name_match_status':
                                              'unconfirmed' if title_rule is None else 'confirmed_by_code_rule',
                                          'event_name_match_rule': title_rule,
                                          'quarantine_reasons': problems,
                                          'eligible_for_questions': False})
                by_year[year]['exact_reference_quarantined'] += 1
            else:
                exact_queue.append({**record, 'event_url': event['event_url'],
                                    'event_name': event['event_name'], 'tier': event['page_tier'],
                                    'event_start_date': event['start_date'],
                                    'event_end_date': event['page_end_date'],
                                    'index_url': event['index_url'], 'index_sha256': event['index_sha256'],
                                    'source_page_url': source_page_url,
                                    'source_revision_sha256': source_revision_sha,
                                    'liquipedia_match_date': series_day,
                                    'official_alias_evidence': alias_evidence,
                                    'hltv_series_id': series_id, 'match_evidence': 'Match/Map.stats',
                                    'event_name_match_status': 'confirmed_by_code_rule',
                                    'event_name_match_rule': title_rule,
                                    'scope_review_state': 'candidate_exact_map_link',
                                    'roster_status': 'unverified', 'eligible_for_questions': False})
                accepted_exact = True
                by_year[year]['exact_map_links'] += 1
                by_tier[event['index_tier']] += 1
        elif len(unique_links) > 1:
            reason = 'same_map_linked_by_multiple_events'
            by_year[year]['conflicting_exact_links'] += 1
            quarantined_exact.append({**record, 'candidate_links': sorted(
                [{'event_url': event['event_url'], 'hltv_series_id': series_id,
                  'source_page_url': source_page_url}
                 for event, series_id, source_page_url, _, _ in links],
                key=lambda item: (item['event_url'], item['hltv_series_id'], item['source_page_url'])),
                                      'quarantine_reasons': [reason],
                                      'eligible_for_questions': False})
        if lead:
            candidates.append({**record, 'event_url': lead['event_url'],
                               'event_name': lead['event_name'], 'index_tier': lead['index_tier'],
                               'index_url': lead['index_url'], 'index_sha256': lead['index_sha256'],
                               'page_sha256': lead['page_sha256'],
                               'hltv_series_id': None, 'match_evidence': 'normalized_index_title_and_date',
                               'scope_review_state': lead['scope_review_state'],
                               'eligible_for_questions': False})
            by_year[year]['index_title_candidates'] += 1
            if accepted_exact:
                by_year[year]['both_exact_and_title'] += 1
        elif not accepted_exact:
            key = (year, record['event_raw'] or '', reason or 'unmatched')
            item = unresolved[key]
            item['maps'] += 1
            if len(item['example_map_ids']) < 3:
                item['example_map_ids'].append(record['map_id'])
            by_year[year]['unmatched_maps'] += 1
        if lead or accepted_exact:
            by_year[year]['maps_with_any_scope_lead'] += 1
    unresolved_rows = [dict(year=year, event_raw=name, reason=reason, **value)
                       for (year, name, reason), value in unresolved.items()]
    unresolved_rows.sort(key=lambda x: (x['year'], -x['maps'], x['event_raw']))
    exact_queue.sort(key=lambda x: x['map_id'])
    quarantined_exact.sort(key=lambda x: x['map_id'])
    candidates.sort(key=lambda x: x['map_id'])
    baseline_rows, baseline_provenance = verified_baseline(baseline_dir)
    current_rows = {row['map_id']: row for row in exact_queue}
    if len(current_rows) != len(exact_queue):
        raise ValueError('Duplicate map ID in v3 exact queue')
    changed_baseline = [map_id for map_id, previous in baseline_rows.items()
                        if map_id not in current_rows or
                        any(current_rows[map_id].get(key) != value
                            for key, value in previous.items())]
    if changed_baseline:
        raise ValueError(f'v3 lost or changed v2 map rows: {changed_baseline[:10]}')
    new_exact_queue = [row for row in exact_queue if row['map_id'] not in baseline_rows]
    if baseline_provenance and any(not row['event_name_match_rule'].startswith('official_infobox_')
                                   for row in new_exact_queue):
        raise ValueError('v3 accepted a new map outside the official short-name rule')
    new_admission_audit, alias_groups = [], defaultdict(list)
    for row in new_exact_queue:
        evidence = row['official_alias_evidence']
        if (not evidence or
                evidence['event_page_sha256'] != events[row['event_url']]['page_sha256'] or
                normalized_title(evidence['raw']) != normalized_title(row['event_raw']) or
                TICKER_SCOPE_EXCLUSIONS.search(row['event_raw'])):
            raise ValueError(f'Official short-name provenance invalid for map {row["map_id"]}')
        day_delta = abs((date.fromisoformat(row['date_raw'][:10]) -
                         date.fromisoformat(row['liquipedia_match_date'])).days)
        if day_delta > 1:
            raise ValueError(f'Official short-name map date diverged: {row["map_id"]}')
        new_admission_audit.append({
            'map_id': row['map_id'], 'event_url': row['event_url'],
            'event_raw': row['event_raw'], 'event_name_match_rule': row['event_name_match_rule'],
            'official_alias_evidence': evidence, 'old_map_date': row['date_raw'][:10],
            'liquipedia_match_date': row['liquipedia_match_date'], 'day_delta': day_delta,
            'event_start_date': row['event_start_date'], 'event_end_date': row['event_end_date'],
            'source_page_url': row['source_page_url'],
            'source_revision_sha256': row['source_revision_sha256'],
            'hltv_series_id': row['hltv_series_id'], 'hltv_map_url': row['hltv_map_url']})
        alias_groups[(row['event_url'], row['event_raw'], evidence['field'], evidence['raw'],
                      evidence['event_page_sha256'])].append(row)
    new_alias_groups = [{
        'event_url': event_url, 'legacy_event_raw': legacy_raw, 'official_field': field,
        'official_field_raw': official_raw, 'event_page_sha256': page_sha,
        'tier': rows[0]['tier'], 'event_start_date': rows[0]['event_start_date'],
        'event_end_date': rows[0]['event_end_date'], 'map_count': len(rows),
        'map_ids': sorted(row['map_id'] for row in rows)}
        for (event_url, legacy_raw, field, official_raw, page_sha), rows
        in sorted(alias_groups.items())]
    cover_plan, cover_report = capture_cover_plan(old_db, exact_queue)
    new_cover_plan, new_cover_report = capture_cover_plan(old_db, new_exact_queue)
    fetch_urls = {row['event_url'] for row in fetch_catalog}
    events_needing_map_links = [event for event in events_sorted
                                if event['scope_review_state'] == 'index_and_page_tier_date_agree'
                                and event['exact_map_ids_on_page'] == 0]
    report = {'schema_version': 1, 'rule_version': RULE_VERSION,
              'cutoff_exclusive': cutoff.isoformat(),
              'index_scope': 'S archive 2012-2023; A archive 2016-2023',
              'events_on_index_before_cutoff': len(events_sorted),
              'events_by_year_and_index_tier': dict(sorted(Counter(
                  f"{event['start_date'][:4]}-{event['index_tier']}"
                  for event in events_sorted if event['start_date']).items())),
              'event_scope_review_states': dict(sorted(Counter(
                  event['scope_review_state'] for event in events_sorted).items())),
              'event_scope_flag_counts': dict(sorted(Counter(
                  flag for event in events_sorted for flag in event['scope_flags']).items())),
              'event_pages_cached_and_tier_date_agree': sum(
                  e['scope_review_state'] == 'index_and_page_tier_date_agree' for e in events_sorted),
              'event_pages_missing': sum(e['scope_review_state'] == 'index_candidate_page_missing'
                                         for e in events_sorted),
              'fetch_target_event_pages': len(fetch_catalog),
              'fetch_target_pages_missing': sum(e['event_url'] in fetch_urls and not e['page_sha256']
                                                for e in events_sorted),
              'validated_event_pages_without_map_ids': len(events_needing_map_links),
              'result_subpages_discovered': len(subpage_targets),
              'result_subpages_cached': len(cached_subpage_shas),
              'result_subpages_missing': len(subpage_targets) - len(cached_subpage_shas),
              'result_subpages_rejected_for_scope': len(rejected_subpages),
              'old_maps_before_cutoff': total_before_cutoff,
              'old_maps_on_overlap_day_excluded': overlap_day,
              'index_title_candidates': len(candidates),
              'exact_map_links_ready_for_roster_capture': len(exact_queue),
              'exact_reference_quarantined_maps': len(quarantined_exact),
              'exact_reference_quarantine_reason_counts': dict(sorted(Counter(
                  reason for row in quarantined_exact
                  for reason in row['quarantine_reasons']).items())),
              'exact_map_links_by_tier': dict(sorted(by_tier.items())),
              'accepted_event_name_match_rules': dict(sorted(Counter(
                  row['event_name_match_rule'] for row in exact_queue).items())),
              'v2_baseline': baseline_provenance,
              'new_exact_maps_vs_v2': len(new_exact_queue),
              'new_exact_maps_by_year': dict(sorted(Counter(
                  row['date_raw'][:4] for row in new_exact_queue).items())),
              'new_official_shortname_rules': dict(sorted(Counter(
                  row['event_name_match_rule'] for row in new_exact_queue).items())),
              'new_official_shortname_groups': len(new_alias_groups),
              'new_match_date_absolute_day_delta_counts': dict(sorted(Counter(
                  row['day_delta'] for row in new_admission_audit).items())),
              'capture_cover_plan': cover_report,
              'new_capture_cover_plan': new_cover_report,
              'by_year': {year: dict(sorted(counts.items())) for year, counts in sorted(by_year.items())},
              'unresolved_event_name_rows': len(unresolved_rows),
              'unresolved_map_reason_counts': dict(sorted(Counter({
                  reason: sum(item['maps'] for item in unresolved_rows if item['reason'] == reason)
                  for reason in {item['reason'] for item in unresolved_rows}}).items())),
              'eligible_for_questions': False,
              'limits': ['Index membership is not individual event-page verification.',
                         'Old event names and timestamps are unverified and timezone unspecified.',
                         'Exact links do not verify actual ten-player rosters or publication rights.',
                         'A-tier archive begins in 2016, so 2012-2015 A coverage is unknown.',
                         'Main event pages may omit result subpages; exact queue is a lower bound.']}
    payloads = {'events.jsonl': jsonl_bytes(events_sorted),
                'events-to-fetch.jsonl': jsonl_bytes(fetch_catalog),
                'events-needing-map-links.jsonl': jsonl_bytes(events_needing_map_links),
                'result-subpages-to-fetch.jsonl': jsonl_bytes(
                    [subpage_targets[url] for url in sorted(subpage_targets)]),
                'result-subpages-rejected.jsonl': jsonl_bytes(rejected_subpages),
                'map-candidates.jsonl': jsonl_bytes(candidates),
                'exact-map-queue.jsonl': jsonl_bytes(exact_queue),
                'new-exact-map-queue.jsonl': jsonl_bytes(new_exact_queue),
                'new-map-admission-audit.jsonl': jsonl_bytes(new_admission_audit),
                'new-official-alias-groups.jsonl': jsonl_bytes(new_alias_groups),
                'quarantined-exact-links.jsonl': jsonl_bytes(quarantined_exact),
                'capture-cover-plan.jsonl': jsonl_bytes(cover_plan),
                'new-capture-cover-plan.jsonl': jsonl_bytes(new_cover_plan),
                'unresolved-events.jsonl': jsonl_bytes(unresolved_rows),
                'report.json': (json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode()}
    inputs = {'legacy_db_sha256': old_raw_sha,
              'catalog_builder_sha256': sha256(Path(__file__).read_bytes()),
              'alias_ledger_sha256': sha256(ALIAS_LEDGER.read_bytes()),
              'v2_baseline': baseline_provenance,
              'index_pages': index_inputs,
              'cached_event_pages': {event['event_url']: event['page_sha256']
                                     for event in events_sorted if event['page_sha256']},
              'cached_result_subpages': cached_subpage_shas}
    manifest = {'schema_version': 1, 'rule_version': RULE_VERSION,
                'version': sha256(json.dumps(inputs, sort_keys=True).encode())[:20],
                'cutoff_exclusive': cutoff.isoformat(), 'candidate_only': True,
                'inputs': inputs,
                'files': {name: file_record(raw) for name, raw in sorted(payloads.items())}}
    payloads['manifest.json'] = (json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode()
    output_dir.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.legacy-as-build-', dir=output_dir.parent) as temporary:
        stage = Path(temporary)
        for name, raw in payloads.items():
            (stage / name).write_bytes(raw)
        output_dir.mkdir(parents=True, exist_ok=True)
        for name in payloads:
            (stage / name).replace(output_dir / name)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--index-dir', type=Path, default=INDEX_DIR)
    parser.add_argument('--event-cache-dir', type=Path, default=EVENT_CACHE)
    parser.add_argument('--subpage-cache-dir', type=Path, default=SUBPAGE_CACHE)
    parser.add_argument('--old-db', type=Path, default=OLD_DB)
    parser.add_argument('--output-dir', type=Path, default=OUTPUT)
    parser.add_argument('--baseline-dir', type=Path, default=V2_BASELINE)
    args = parser.parse_args()
    print(json.dumps(build(args.index_dir, args.event_cache_dir, args.old_db, args.output_dir,
                           subpage_cache_dir=args.subpage_cache_dir,
                           baseline_dir=args.baseline_dir),
                     ensure_ascii=False, indent=2))
