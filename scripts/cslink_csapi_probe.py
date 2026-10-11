#!/usr/bin/env python3
"""Small, cached coverage probe of a public third-party per-map CS stats API.

This probes a few HLTV series IDs from our A/S queue. It never requests HLTV.
Responses remain local and are not approved teammate evidence.
"""

import argparse
import hashlib
import json
from pathlib import Path
import time
import urllib.error
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
SNAPSHOT = ROOT / 'data/cslink/as-tier-snapshot-2026-10-03/events.jsonl'
SERIES = ROOT / 'data/cslink/as-tier-hltv-link-index-2026-10-03-v2/series-links.jsonl'
OUTPUT = ROOT / '.local-data/cslink/csapi-probe-2026-10-03'
BASE = 'https://api.csapi.de/matches'


def read_jsonl(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def choose(events, series, per_year):
    years = {event['event_url']: int(event['start_date'][:4]) for event in events}
    by_year = {}
    for row in series:
        if not row['mapstatsids']:
            continue
        by_year.setdefault(years[row['event_url']], []).append(row)
    selected = []
    for year, rows in sorted(by_year.items()):
        rows.sort(key=lambda row: row['hltv_series_id'])
        positions = sorted({round(i * (len(rows) - 1) / max(1, per_year - 1))
                            for i in range(per_year)})
        selected.extend((year, rows[position]) for position in positions)
    return selected


def summarize(payload):
    if not isinstance(payload, list):
        return {'shape': type(payload).__name__, 'maps': 0, 'complete_ten_player_maps': 0}
    maps = [item for item in payload if isinstance(item, dict) and item.get('id') != 0]
    complete = sum(isinstance(item.get('team1', {}).get('players'), list)
                   and isinstance(item.get('team2', {}).get('players'), list)
                   and len(item['team1']['players']) == 5
                   and len(item['team2']['players']) == 5
                   and all(type(player.get('id')) is int and player['id'] > 0
                           for side in ('team1', 'team2') for player in item[side]['players'])
                   for item in maps)
    return {'shape': 'list', 'maps': len(maps), 'complete_ten_player_maps': complete,
            'has_hltv_mapstatsid': any('mapstatsid' in item for item in maps)}


def probe(events_path, series_path, output_dir, per_year=3, delay_seconds=1.0):
    selected = choose(read_jsonl(events_path), read_jsonl(series_path), per_year)
    output_dir.mkdir(parents=True, exist_ok=True)
    result = []
    for i, (year, row) in enumerate(selected):
        series_id = row['hltv_series_id']
        url = f'{BASE}/{series_id}/stats?by_map=true'
        target = output_dir / f'{series_id}.json'
        status = None
        error = None
        if target.is_file():
            raw = target.read_bytes()
            status = 'cached'
        else:
            if i:
                time.sleep(delay_seconds)
            request = urllib.request.Request(url, headers={'User-Agent': 'CS-Link-local-coverage-probe/1.0'})
            try:
                with urllib.request.urlopen(request, timeout=20) as response:
                    raw = response.read(2_000_000)
                    status = response.status
                    if status == 200:
                        target.write_bytes(raw)
            except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError) as exc:
                raw = b''
                status = exc.code if isinstance(exc, urllib.error.HTTPError) else None
                error = type(exc).__name__
        try:
            summary = summarize(json.loads(raw)) if raw else {'shape': 'none', 'maps': 0,
                                                               'complete_ten_player_maps': 0}
        except json.JSONDecodeError:
            summary = {'shape': 'invalid_json', 'maps': 0, 'complete_ten_player_maps': 0}
        result.append({'year': year, 'event_name': row['event_name'],
                       'hltv_series_id': series_id, 'hltv_series_url': row['hltv_series_url'],
                       'api_url': url, 'status': status, 'error': error,
                       'raw_sha256': hashlib.sha256(raw).hexdigest() if raw else None,
                       'queue_map_count': len(row['mapstatsids']), **summary})
    report = {'source': BASE, 'purpose': 'coverage probe only',
              'data_rights_status': 'unconfirmed', 'series_requested': len(result),
              'with_any_map_stats': sum(item['maps'] > 0 for item in result),
              'with_complete_ten_player_maps': sum(item['complete_ten_player_maps'] > 0 for item in result),
              'results': result}
    (output_dir / 'report.json').write_text(json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2) + '\n')
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--events', type=Path, default=SNAPSHOT)
    parser.add_argument('--series', type=Path, default=SERIES)
    parser.add_argument('--output-dir', type=Path, default=OUTPUT)
    parser.add_argument('--per-year', type=int, default=3)
    parser.add_argument('--delay-seconds', type=float, default=1.0)
    args = parser.parse_args()
    if not 1 <= args.per_year <= 5 or args.delay_seconds < 1:
        parser.error('Use 1-5 series per year and at least 1 second between requests')
    report = probe(args.events, args.series, args.output_dir, args.per_year, args.delay_seconds)
    print(json.dumps({key: report[key] for key in ('series_requested', 'with_any_map_stats',
                                                   'with_complete_ten_player_maps')}, indent=2))
