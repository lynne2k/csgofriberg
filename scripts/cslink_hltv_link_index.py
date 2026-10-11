#!/usr/bin/env python3
"""Build HLTV reference links from the frozen Liquipedia map-ID discovery queue.

This does not request HLTV pages or infer player appearances from a URL.
"""

import argparse
from collections import defaultdict
import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
INPUT = ROOT / 'data/cslink/as-tier-snapshot-2026-10-03/map-id-queue.jsonl'
SERIES_INPUT = ROOT / '.local-data/cslink/as-tier-catalog/series-id-queue.jsonl'
OUTPUT = ROOT / 'data/cslink/as-tier-hltv-link-index-2026-10-03-v2'


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def jsonl(rows):
    return ''.join(json.dumps(row, ensure_ascii=False, sort_keys=True) + '\n' for row in rows).encode()


def build(input_path, output_dir, series_input=None):
    input_raw = input_path.read_bytes()
    rows = [json.loads(line) for line in input_raw.splitlines() if line.strip()]
    if not rows:
        raise ValueError('Empty map queue')
    maps = []
    series = {}
    seen_maps = set()
    for row in rows:
        map_id, series_id = row['mapstatsid'], row['hltv_series_id']
        if (type(map_id) is not int or map_id <= 0 or
                type(series_id) is not int or series_id <= 0):
            raise ValueError('Map and series IDs must be positive integers')
        if map_id in seen_maps:
            raise ValueError(f'Duplicate map ID: {map_id}')
        seen_maps.add(map_id)
        if row['roster_status'] != 'unverified' or row['eligible_for_questions'] is not False:
            raise ValueError('This index accepts discovery candidates only')
        path = f'/stats/matches/mapstatsid/{map_id}/-'
        series_url = f'https://www.hltv.org/matches/{series_id}/-'
        maps.append({**row, 'game_link': path,
                     'hltv_map_url': 'https://www.hltv.org' + path,
                     'hltv_series_url': series_url,
                     'hltv_link_status': 'constructed_from_liquipedia_id'})
        if series_id not in series:
            series[series_id] = {'hltv_series_id': series_id,
                                 'hltv_series_url': series_url,
                                 'event_url': row['event_url'],
                                 'event_name': row['event_name'],
                                 'tier': row['tier'],
                                 'source_page_url': row['source_page_url'],
                                 'mapstatsids': [],
                                 'hltv_link_status': 'constructed_from_liquipedia_id'}
        elif series[series_id]['event_url'] != row['event_url']:
            raise ValueError(f'Series ID spans multiple events: {series_id}')
        series[series_id]['mapstatsids'].append(map_id)
    series_input_sha256 = None
    conflicts = []
    if series_input is not None:
        series_raw = series_input.read_bytes()
        series_input_sha256 = digest(series_raw)
        source_series = {}
        map_to_series = defaultdict(set)
        for raw_line in series_raw.splitlines():
            if not raw_line.strip():
                continue
            row = json.loads(raw_line)
            series_id = row['hltv_series_id']
            if type(series_id) is not int or series_id <= 0:
                raise ValueError('Series IDs must be positive integers')
            if row['roster_status'] != 'unverified' or row['eligible_for_questions'] is not False:
                raise ValueError('This index accepts discovery candidates only')
            if series_id in source_series:
                raise ValueError(f'Duplicate source series ID: {series_id}')
            source_series[series_id] = row
            for map_id in row['mapstatsids']:
                map_to_series[map_id].add(series_id)
            if series_id in series:
                if series[series_id]['event_url'] != row['event_url']:
                    raise ValueError(f'Series source disagrees with frozen maps: {series_id}')
                series[series_id]['source_revision_sha256'] = row['source_revision_sha256']
                series[series_id]['source_mapstatsids'] = row['mapstatsids']
                continue
            if row['mapstatsids']:
                raise ValueError(f'Series has maps absent from frozen queue: {series_id}')
            series[series_id] = {'hltv_series_id': series_id,
                                 'hltv_series_url': f'https://www.hltv.org/matches/{series_id}/-',
                                 'event_url': row['event_url'], 'event_name': row['event_name'],
                                 'tier': row['tier'], 'source_page_url': row['source_page_url'],
                                 'source_revision_sha256': row['source_revision_sha256'],
                                 'mapstatsids': [],
                                 'source_mapstatsids': [],
                                 'hltv_link_status': 'constructed_from_liquipedia_id'}
        ambiguous = {map_id: sorted(ids) for map_id, ids in map_to_series.items() if len(ids) > 1}
        for series_id, row in source_series.items():
            frozen_ids = set(series[series_id]['mapstatsids'])
            source_ids = set(row['mapstatsids'])
            if not frozen_ids <= source_ids or not (source_ids - frozen_ids) <= ambiguous.keys():
                raise ValueError(f'Series source disagrees with frozen maps: {series_id}')
            series[series_id]['ambiguous_mapstatsids'] = sorted(source_ids & ambiguous.keys())
        for row in maps:
            map_id = row['mapstatsid']
            if map_id in ambiguous:
                row['hltv_series_candidate_urls'] = [f'https://www.hltv.org/matches/{sid}/-'
                                                     for sid in ambiguous[map_id]]
                row['hltv_series_url'] = None
                row['hltv_link_status'] = 'map_url_constructed_series_ambiguous'
                conflicts.append({'mapstatsid': map_id,
                                  'frozen_series_id': row['hltv_series_id'],
                                  'source_series_ids': ambiguous[map_id]})
    maps.sort(key=lambda row: row['mapstatsid'])
    series_rows = sorted(series.values(), key=lambda row: row['hltv_series_id'])
    for row in series_rows:
        row['mapstatsids'].sort()
    report = {'schema_version': 1,
              'input_path': str(input_path.relative_to(ROOT)) if input_path.is_relative_to(ROOT) else str(input_path),
              'input_sha256': digest(input_raw),
              'series_input_sha256': series_input_sha256,
              'map_links': len(maps), 'series_links_total': len(series_rows),
              'series_links_with_maps': sum(bool(row['mapstatsids']) for row in series_rows),
              'series_links_without_maps': sum(not row['mapstatsids'] for row in series_rows),
              'ambiguous_map_to_series_links': len(conflicts),
              'link_method': 'HLTV numeric ID routes with /- as a redirecting slug placeholder',
              'link_status': 'constructed_from_liquipedia_id; not individually HTTP-verified',
              'roster_status': 'unverified; links alone do not establish teammate evidence'}
    outputs = {'map-links.jsonl': jsonl(maps),
               'series-links.jsonl': jsonl(series_rows),
               'series-map-conflicts.jsonl': jsonl(conflicts),
               'report.json': (json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode()}
    output_dir.mkdir(parents=True, exist_ok=True)
    for name, raw in outputs.items():
        target = output_dir / name
        if target.exists() and target.read_bytes() != raw:
            raise ValueError(f'Refusing to overwrite changed index: {target}')
    manifest = {'files': {name: {'bytes': len(raw), 'sha256': digest(raw)}
                          for name, raw in sorted(outputs.items())}}
    manifest_raw = (json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode()
    target = output_dir / 'manifest.json'
    if target.exists() and target.read_bytes() != manifest_raw:
        raise ValueError(f'Refusing to overwrite changed index: {target}')
    for name, raw in outputs.items():
        (output_dir / name).write_bytes(raw)
    target.write_bytes(manifest_raw)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, default=INPUT)
    parser.add_argument('--series-input', type=Path, default=SERIES_INPUT)
    parser.add_argument('--output-dir', type=Path, default=OUTPUT)
    args = parser.parse_args()
    print(json.dumps(build(args.input, args.output_dir, args.series_input), ensure_ascii=False, indent=2))
