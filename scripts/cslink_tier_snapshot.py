#!/usr/bin/env python3
"""Freeze the A/S event and map-ID discovery queue against a pinned old snapshot."""

import argparse
import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def sha256(raw):
    return hashlib.sha256(raw).hexdigest()


def lines(path):
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def snapshot(catalog_dir, old_matches, output_dir):
    events_path = catalog_dir / 'events-enriched.jsonl'
    maps_path = catalog_dir / 'map-id-queue.jsonl'
    upstream_report = json.loads((catalog_dir / 'enrichment-report.json').read_text())
    events = lines(events_path)
    maps = lines(maps_path)
    if len(events) != 110 or len(maps) != upstream_report['discovered_map_ids_unique']:
        raise ValueError('Catalog/report count mismatch')
    if len({x['mapstatsid'] for x in maps}) != len(maps):
        raise ValueError('Map IDs are not unique')
    if any(x['eligible_for_questions'] or x['roster_status'] != 'unverified' for x in maps):
        raise ValueError('Discovery queue must not contain approved rosters')
    old_ids = {x['map_id'] for x in lines(old_matches)}
    overlap = sorted(x['mapstatsid'] for x in maps if x['mapstatsid'] in old_ids)
    new_maps = [x for x in maps if x['mapstatsid'] not in old_ids]
    output_dir.mkdir(parents=True, exist_ok=True)
    outputs = {
        'events.jsonl': events_path.read_bytes(),
        'map-id-queue.jsonl': maps_path.read_bytes(),
        'new-map-id-queue.jsonl': ''.join(json.dumps(x, ensure_ascii=False, sort_keys=True) + '\n'
                                          for x in new_maps).encode(),
    }
    summary = {'schema_version': 1, 'snapshot_date': '2026-10-03',
               'old_matches_file': str(old_matches.relative_to(ROOT)),
               'old_matches_sha256': sha256(old_matches.read_bytes()),
               'event_candidates': len(events), 'event_pages_cached': upstream_report['event_pages_cached'],
               'result_subpages_cached': upstream_report['result_subpages_cached'],
               'series_with_map_ids': upstream_report['series_ids_with_at_least_one_map_id'],
               'map_id_candidates': len(maps), 'old_snapshot_overlap': len(overlap),
               'overlap_map_ids': overlap, 'new_map_id_candidates': len(new_maps),
               'finished_maps_without_stats_id': upstream_report['finished_maps_without_stats_id'],
               'invalid_stats_references': len(upstream_report['invalid_stats_references']),
               'tier_review_state': 'index_and_infobox_agree; per-event scope review pending',
               'roster_review_state': 'none; all map IDs are discovery candidates',
               'source': 'Liquipedia Counter-Strike MediaWiki API; see README.md for attribution and terms'}
    outputs['report.json'] = (json.dumps(summary, ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode()
    for name, raw in outputs.items():
        target = output_dir / name
        if target.exists() and target.read_bytes() != raw:
            raise ValueError(f'Refusing to overwrite changed snapshot: {target}')
        target.write_bytes(raw)
    manifest = {'files': {name: {'bytes': len(raw), 'sha256': sha256(raw)}
                          for name, raw in sorted(outputs.items())}}
    target = output_dir / 'manifest.json'
    raw = (json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode()
    if target.exists() and target.read_bytes() != raw:
        raise ValueError(f'Refusing to overwrite changed snapshot: {target}')
    target.write_bytes(raw)
    return summary


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--catalog-dir', type=Path, default=ROOT / '.local-data/cslink/as-tier-catalog')
    parser.add_argument('--old-matches', type=Path, default=ROOT / '.local-data/cslink/versions/69d3bb14fb82e70ea452/matches.jsonl')
    parser.add_argument('--output-dir', type=Path, default=ROOT / 'data/cslink/as-tier-snapshot-2026-10-03')
    args = parser.parse_args()
    print(json.dumps(snapshot(args.catalog_dir, args.old_matches, args.output_dir), ensure_ascii=False, indent=2))
