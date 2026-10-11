#!/usr/bin/env python3
"""Plan a small, auditable map sample covering each team's event appearance.

This reads the frozen Liquipedia discovery snapshot and its checked local cache.
Selected map IDs and constructed links are leads, not verified player rosters.
"""

import argparse
from collections import defaultdict
import hashlib
import json
from pathlib import Path
import random
import re

from cslink_tier_enrich import digits_field, event_cache, template_blocks, without_showmatch_section


ROOT = Path(__file__).resolve().parents[1]
SNAPSHOT = ROOT / 'data/cslink/as-tier-snapshot-2026-10-03'
MAIN_CACHE = ROOT / '.local-data/cslink/as-tier-event-pages'
SUBPAGE_CATALOG = ROOT / '.local-data/cslink/as-tier-catalog/subpage-catalog.jsonl'
SUBPAGE_CACHE = ROOT / '.local-data/cslink/as-tier-subpages'
OUTPUT = ROOT / 'data/cslink/as-tier-event-cover-2026-10-03'
OPPONENT = re.compile(r'\|\s*opponent([12])\s*=\s*\{\{TeamOpponent\|([^|}]+)', re.I)


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def jsonl(rows):
    return ''.join(json.dumps(row, ensure_ascii=False, sort_keys=True) + '\n' for row in rows).encode()


def read_jsonl(path):
    raw = path.read_bytes()
    return [json.loads(line) for line in raw.splitlines() if line.strip()], sha256(raw)


def extract_match(block, allowed_maps, event_url, source_url, source_sha):
    series_id = digits_field(block, 'hltv')
    if series_id is None:
        return None
    opponents = {int(which): label.strip() for which, label in OPPONENT.findall(block)}
    if set(opponents) != {1, 2} or not all(opponents.values()):
        return None
    labels = [opponents[1].casefold(), opponents[2].casefold()]
    if labels[0] == labels[1]:
        return None
    map_ids = []
    for map_block in template_blocks(block, 'Map'):
        map_id = digits_field(map_block, 'stats')
        row = allowed_maps.get(map_id)
        if row and row['event_url'] == event_url and row['hltv_series_id'] == series_id:
            if row['source_page_url'] != source_url or row['source_revision_sha256'] != source_sha:
                raise ValueError(f'Source mismatch for map {map_id}')
            if map_id not in map_ids:
                map_ids.append(map_id)
    if not map_ids:
        return None
    return {'hltv_series_id': series_id, 'team_labels': labels, 'mapstatsids': map_ids,
            'source_page_url': source_url, 'source_revision_sha256': source_sha}


def choose_cover(matches, attempts=32):
    """Return a deterministic small edge cover; this is not an exact minimum."""
    if not matches:
        return []
    by_id = {m['hltv_series_id']: m for m in matches}
    if len(by_id) != len(matches):
        raise ValueError('Duplicate series IDs within event')
    incident = defaultdict(list)
    for match in matches:
        for label in match['team_labels']:
            incident[label].append(match['hltv_series_id'])
    best = None
    for seed in range(attempts):
        order = list(by_id)
        random.Random(seed).shuffle(order)
        order.sort(key=lambda series_id: (
            len(incident[by_id[series_id]['team_labels'][0]]) *
            len(incident[by_id[series_id]['team_labels'][1]]),
            sum(len(incident[label]) for label in by_id[series_id]['team_labels'])))
        covered = set()
        selected = []
        # A maximal matching first lets one chosen series cover two new teams.
        for series_id in order:
            labels = by_id[series_id]['team_labels']
            if all(label not in covered for label in labels):
                selected.append(series_id)
                covered.update(labels)
        # Every remaining team must have a match against an already covered team.
        for label in sorted(set(incident) - covered):
            series_id = min(incident[label], key=lambda candidate: (
                sum(len(incident[team]) for team in by_id[candidate]['team_labels']), candidate))
            if series_id not in selected:
                selected.append(series_id)
            covered.update(by_id[series_id]['team_labels'])
        if covered != set(incident):
            raise AssertionError('Selected matches do not cover all parsed teams')
        selected.sort()
        if best is None or (len(selected), selected) < (len(best), best):
            best = selected
    return best


def choose_pilot(selected_rows, per_year_tier=3):
    """Sample different events across every year and tier for source validation."""
    groups = defaultdict(dict)
    for row in selected_rows:
        key = (row['event_start_date'][:4], row['tier'])
        event_rows = groups[key]
        previous = event_rows.get(row['event_url'])
        if previous is None or row['hltv_series_id'] < previous['hltv_series_id']:
            event_rows[row['event_url']] = row
    pilot = []
    for key in sorted(groups):
        candidates = sorted(groups[key].values(),
                            key=lambda row: (row['event_start_date'], row['event_url']))
        count = min(per_year_tier, len(candidates))
        positions = ([0] if count == 1 else
                     [round(index * (len(candidates) - 1) / (count - 1)) for index in range(count)])
        for row_index in positions:
            pilot.append({**candidates[row_index], 'pilot_reason': 'stratified_year_tier_distinct_event'})
    return pilot


def build(snapshot, main_cache, subpage_catalog, subpage_cache, output):
    events, events_sha = read_jsonl(snapshot / 'events.jsonl')
    maps, maps_sha = read_jsonl(snapshot / 'map-id-queue.jsonl')
    allowed_maps = {row['mapstatsid']: row for row in maps}
    if len(allowed_maps) != len(maps):
        raise ValueError('Duplicate map IDs in frozen snapshot')
    subpages = defaultdict(list)
    subpage_sha = None
    if subpage_catalog.is_file():
        rows, subpage_sha = read_jsonl(subpage_catalog)
        for row in rows:
            subpages[row['parent_event_url']].append(row['event_url'])
    selected_rows = []
    coverage_rows = []
    review_rows = []
    parsed_series_count = 0
    seen_map_ids = set()
    for event in events:
        event_url = event['event_url']
        sources = [(event_url, main_cache)] + [(url, subpage_cache) for url in subpages[event_url]]
        by_id = {}
        for source_url, cache_dir in sources:
            loaded = event_cache(cache_dir, source_url)
            if loaded is None:
                raise ValueError(f'Missing cached source page: {source_url}')
            wiki, meta = loaded
            wiki = without_showmatch_section(re.sub(r'<!--.*?-->', '', wiki, flags=re.S))
            for block in template_blocks(wiki, 'Match'):
                match = extract_match(block, allowed_maps, event_url, source_url, meta['sha256'])
                if match is None:
                    continue
                series_id = match['hltv_series_id']
                if series_id in by_id and by_id[series_id] != match:
                    raise ValueError(f'Conflicting series data: {series_id}')
                by_id[series_id] = match
        matches = list(by_id.values())
        parsed_series_count += len(matches)
        seen_map_ids.update(map_id for m in matches for map_id in m['mapstatsids'])
        selected_ids = choose_cover(matches)
        selected = {series_id: by_id[series_id] for series_id in selected_ids}
        team_labels = sorted({team for match in matches for team in match['team_labels']})
        team_to_selected = defaultdict(list)
        for series_id in selected_ids:
            for label in selected[series_id]['team_labels']:
                team_to_selected[label].append(series_id)
        if set(team_to_selected) != set(team_labels):
            raise AssertionError(f'Incomplete event team cover: {event_url}')
        for label in team_labels:
            coverage_rows.append({'event_url': event_url, 'event_name': event['event_name'],
                                  'team_label_raw': label,
                                  'selected_series_ids': sorted(team_to_selected[label]),
                                  'team_identity_status': 'unreviewed_raw_label',
                                  'roster_coverage_status': 'first_map_unverified'})
        for series_id in selected_ids:
            match = selected[series_id]
            map_id = match['mapstatsids'][0]
            selected_rows.append({'event_url': event_url, 'event_name': event['event_name'],
                                  'tier': event['page_tier'], 'event_start_date': event['page_start_date'],
                                  'hltv_series_id': series_id,
                                  'hltv_series_url': f'https://www.hltv.org/matches/{series_id}/-',
                                  'team_labels_raw': match['team_labels'],
                                  'selected_mapstatsid': map_id,
                                  'candidate_mapstatsids_in_series': match['mapstatsids'],
                                  'hltv_map_url': f'https://www.hltv.org/stats/matches/mapstatsid/{map_id}/-',
                                  'hltv_link_status': 'constructed_unverified',
                                  'source_page_url': match['source_page_url'],
                                  'source_revision_sha256': match['source_revision_sha256'],
                                  'roster_status': 'unverified', 'eligible_for_questions': False,
                                  'selection_reason': 'cover_event_team_raw_labels',
                                  'next_action': 'verify_actual_map_rosters_from_permitted_source'})
        listed = int(event['participants_raw']) if str(event['participants_raw']).isdigit() else None
        reasons = []
        if not matches:
            reasons.append('no_series_with_map_id')
        if listed is not None and len(team_labels) != listed:
            reasons.append('raw_team_label_count_differs_from_listed_participants')
        if event['review_state'] != 'scope_approved':
            reasons.append('event_scope_review_pending')
        if reasons:
            review_rows.append({'event_url': event_url, 'event_name': event['event_name'],
                                'reasons': reasons, 'listed_participants': listed,
                                'parsed_team_labels': len(team_labels),
                                'team_labels_raw': team_labels,
                                'series_with_maps': len(matches)})
    if seen_map_ids != set(allowed_maps):
        raise ValueError(f'Parsed match maps differ from frozen snapshot: '
                         f'{len(seen_map_ids)} parsed, {len(allowed_maps)} frozen')
    selected_rows.sort(key=lambda row: (row['event_start_date'], row['event_url'], row['hltv_series_id']))
    coverage_rows.sort(key=lambda row: (row['event_url'], row['team_label_raw']))
    review_rows.sort(key=lambda row: row['event_url'])
    pilot_rows = choose_pilot(selected_rows)
    report = {'schema_version': 1, 'source': 'frozen Liquipedia MediaWiki API cache',
              'events_sha256': events_sha, 'map_queue_sha256': maps_sha,
              'subpage_catalog_sha256': subpage_sha,
              'event_candidates': len(events),
              'events_with_discovered_maps': sum(bool(event['discovered_unique_map_ids']) for event in events),
              'series_with_maps_parsed': parsed_series_count, 'map_ids_parsed': len(seen_map_ids),
              'raw_event_team_labels': len(coverage_rows),
              'selected_series': len(selected_rows), 'selected_initial_maps': len(selected_rows),
              'stratified_pilot_series': len(pilot_rows),
              'events_needing_review': len(review_rows),
              'roster_coverage_status': 'none_verified',
              'question_eligibility': False,
              'selection_method': 'deterministic multi-start greedy matching plus edge cover; not exact minimum'}
    outputs = {'selected-series.jsonl': jsonl(selected_rows),
               'pilot-sample.jsonl': jsonl(pilot_rows),
               'team-coverage.jsonl': jsonl(coverage_rows),
               'event-review.jsonl': jsonl(review_rows),
               'report.json': (json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode()}
    manifest = {'files': {name: {'bytes': len(raw), 'sha256': sha256(raw)}
                          for name, raw in sorted(outputs.items())}}
    outputs['manifest.json'] = (json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode()
    output.mkdir(parents=True, exist_ok=True)
    for name, raw in outputs.items():
        target = output / name
        if target.exists() and target.read_bytes() != raw:
            raise ValueError(f'Refusing to overwrite changed coverage plan: {target}')
    for name, raw in outputs.items():
        (output / name).write_bytes(raw)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--snapshot', type=Path, default=SNAPSHOT)
    parser.add_argument('--main-cache', type=Path, default=MAIN_CACHE)
    parser.add_argument('--subpage-catalog', type=Path, default=SUBPAGE_CATALOG)
    parser.add_argument('--subpage-cache', type=Path, default=SUBPAGE_CACHE)
    parser.add_argument('--output', type=Path, default=OUTPUT)
    args = parser.parse_args()
    print(json.dumps(build(args.snapshot, args.main_cache, args.subpage_catalog,
                           args.subpage_cache, args.output), ensure_ascii=False, indent=2))
