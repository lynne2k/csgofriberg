#!/usr/bin/env python3
"""Extract tournament tier, series IDs and map IDs from cached MediaWiki wikitext.

The output is a discovery queue. An HLTV map ID alone is not a verified roster.
"""

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]


def template_blocks(source, name):
    start_marker = '{{' + name
    position = 0
    while True:
        start = source.find(start_marker, position)
        if start < 0:
            return
        boundary = source[start + len(start_marker):start + len(start_marker) + 1]
        if boundary not in ('|', ' ', '\n', '\t'):
            position = start + len(start_marker)
            continue
        depth = 0
        cursor = start
        while cursor < len(source):
            if source.startswith('{{', cursor):
                depth += 1
                cursor += 2
            elif source.startswith('}}', cursor):
                depth -= 1
                cursor += 2
                if depth == 0:
                    yield source[start:cursor]
                    break
            else:
                cursor += 1
        position = cursor


def field(source, key):
    found = re.search(r'(?m)^\s*\|\s*' + re.escape(key) + r'\s*=\s*([^\r\n]*)', source, re.I)
    return found.group(1).strip() if found else None


def digits_field(source, key):
    found = re.search(r'\|\s*' + re.escape(key) + r'\s*=\s*([1-9][0-9]*)\s*(?=[|}\r\n])', source, re.I)
    return int(found.group(1)) if found else None


def event_cache(cache_dir, event_url):
    key = hashlib.sha256(event_url.encode()).hexdigest()[:20]
    raw_path = cache_dir / f'{key}.json'
    meta_path = cache_dir / f'{key}.meta.json'
    if not (raw_path.is_file() and meta_path.is_file()):
        return None
    raw = raw_path.read_bytes()
    meta = json.loads(meta_path.read_text())
    if hashlib.sha256(raw).hexdigest() != meta['sha256'] or meta['event_url'] != event_url:
        raise ValueError(f'Changed event cache: {raw_path}')
    data = json.loads(raw)
    page = data['query']['pages'][0]
    text = page['revisions'][0]['slots']['main']['content']
    return text, meta


def without_showmatch_section(wiki):
    marker = re.search(r'(?im)^={2,5}\s*(?:\{\{Stage\s*\|\s*)?Showmatch(?:\s*\}\})?\s*={2,5}\s*$', wiki)
    return wiki[:marker.start()] if marker else wiki


def enrich(catalog, cache_dir, output_dir, subpage_catalog=None, subpage_cache_dir=None):
    events = [json.loads(line) for line in catalog.read_text().splitlines() if line.strip()]
    subpages = {}
    if subpage_catalog and subpage_catalog.is_file():
        for line in subpage_catalog.read_text().splitlines():
            if line.strip():
                row = json.loads(line)
                subpages.setdefault(row['parent_event_url'], []).append(row['event_url'])
    enriched = []
    map_rows = []
    series_rows = []
    missing = []
    missing_subpages = []
    invalid_stats_refs = []
    all_series_ids = set()
    for event in events:
        loaded = event_cache(cache_dir, event['event_url'])
        if loaded is None:
            missing.append(event['event_url'])
            continue
        wiki, meta = loaded
        wiki = re.sub(r'<!--.*?-->', '', wiki, flags=re.S)
        infobox = next(template_blocks(wiki, 'Infobox league'), None)
        tier = field(infobox, 'liquipediatier') if infobox else None
        start = field(infobox, 'sdate') if infobox else None
        end = field(infobox, 'edate') if infobox else None
        flags = []
        if tier != event['index_tier'] + '-Tier':
            flags.append('tier_missing_or_mismatch')
        if start != event['start_date']:
            flags.append('start_date_missing_or_mismatch')
        source_pages = [(event['event_url'], wiki, meta)]
        for url in subpages.get(event['event_url'], []):
            child = event_cache(subpage_cache_dir, url)
            if child is None:
                missing_subpages.append(url)
                continue
            source_pages.append((url, *child))
        series = []
        map_ids = set()
        finished_missing_stats = 0
        invalid_refs_before = len(invalid_stats_refs)
        for source_url, source_wiki, source_meta in source_pages:
            source_wiki = re.sub(r'<!--.*?-->', '', source_wiki, flags=re.S)
            source_wiki = without_showmatch_section(source_wiki)
            for block in template_blocks(source_wiki, 'Match'):
                match_id = digits_field(block, 'hltv')
                maps = []
                for map_block in template_blocks(block, 'Map'):
                    map_id = digits_field(map_block, 'stats')
                    if map_id is not None:
                        if map_id >= 1_000_000 or map_id == match_id:
                            invalid_stats_refs.append({'event_url': event['event_url'],
                                                       'source_page_url': source_url,
                                                       'stats_value': map_id, 'hltv_series_id': match_id})
                        else:
                            maps.append(map_id)
                    elif re.search(r'\|\s*finished\s*=\s*true(?=[|}\s])', map_block, re.I):
                        finished_missing_stats += 1
                maps = sorted(set(maps))
                if match_id is not None or maps:
                    series.append({'hltv_series_id': match_id, 'mapstatsids': maps})
                if match_id is not None:
                    all_series_ids.add(match_id)
                    series_rows.append({'hltv_series_id': match_id, 'mapstatsids': maps,
                                        'event_url': event['event_url'], 'event_name': event['event_name'],
                                        'tier': tier, 'source_page_url': source_url,
                                        'source_revision_sha256': source_meta['sha256'],
                                        'source_field': 'Match.hltv', 'roster_status': 'unverified',
                                        'eligible_for_questions': False})
                for map_id in maps:
                    if map_id in map_ids:
                        flags.append('duplicate_map_id_in_event')
                        continue
                    map_ids.add(map_id)
                    map_rows.append({'mapstatsid': map_id, 'hltv_series_id': match_id,
                                     'event_url': event['event_url'], 'event_name': event['event_name'],
                                     'tier': tier, 'source_page_url': source_url,
                                     'source_revision_sha256': source_meta['sha256'],
                                     'source_field': 'Match/Map.stats', 'roster_status': 'unverified',
                                     'eligible_for_questions': False})
        if not series:
            flags.append('no_match_templates_on_main_page')
        if finished_missing_stats:
            flags.append('finished_maps_without_stats_id')
        if len(invalid_stats_refs) > invalid_refs_before:
            flags.append('stats_field_is_series_id_or_invalid')
        enriched.append({**event, 'page_tier': tier, 'page_start_date': start,
                         'page_end_date': end, 'page_revision_timestamp': meta['revision_timestamp'],
                         'page_sha256': meta['sha256'], 'cached_result_subpages': len(source_pages) - 1,
                         'discovered_match_templates_with_ids': len(series),
                         'discovered_unique_series_ids': len({s['hltv_series_id'] for s in series if s['hltv_series_id']}),
                         'discovered_unique_map_ids': len(map_ids),
                         'finished_maps_without_stats_id': finished_missing_stats,
                         'validation_flags': sorted(set(flags)),
                         'review_state': 'needs_scope_review' if flags else 'catalog_discovered'})
    by_map = {}
    duplicates = []
    for row in map_rows:
        key = row['mapstatsid']
        if key in by_map:
            duplicates.append({'mapstatsid': key, 'first_event': by_map[key]['event_url'],
                               'second_event': row['event_url']})
        else:
            by_map[key] = row
    by_series = {}
    for row in series_rows:
        key = row['hltv_series_id']
        if key in by_series:
            if by_series[key]['event_url'] != row['event_url']:
                raise ValueError(f'Series ID spans events: {key}')
            by_series[key]['mapstatsids'] = sorted(set(by_series[key]['mapstatsids']) | set(row['mapstatsids']))
        else:
            by_series[key] = row
    output_dir.mkdir(parents=True, exist_ok=True)
    for name, rows in [('events-enriched.jsonl', enriched),
                       ('series-id-queue.jsonl', sorted(by_series.values(), key=lambda x: x['hltv_series_id'])),
                       ('map-id-queue.jsonl', sorted(by_map.values(), key=lambda x: x['mapstatsid']))]:
        (output_dir / name).write_text(''.join(json.dumps(x, ensure_ascii=False, sort_keys=True) + '\n' for x in rows))
    report = {'events_in_index_scope': len(events), 'event_pages_cached': len(enriched),
              'event_pages_missing': len(missing), 'result_subpages_missing': len(missing_subpages),
              'result_subpages_cached': sum(e['cached_result_subpages'] for e in enriched),
              'discovered_series_ids_unique': len(all_series_ids),
              'series_ids_without_map_id': sum(not row['mapstatsids'] for row in by_series.values()),
              'series_ids_with_at_least_one_map_id': len({x['hltv_series_id'] for x in by_map.values()
                                                       if x['hltv_series_id'] is not None}),
              'discovered_map_ids_unique': len(by_map),
              'events_without_map_ids': sum(e['discovered_unique_map_ids'] == 0 for e in enriched),
              'finished_maps_without_stats_id': sum(e['finished_maps_without_stats_id'] for e in enriched),
              'validation_flag_counts': dict(sorted(Counter(f for e in enriched for f in e['validation_flags']).items())),
              'duplicate_map_ids_across_events': duplicates, 'missing_pages': missing,
              'missing_result_subpages': missing_subpages,
              'invalid_stats_references': invalid_stats_refs,
              'note': 'Counts cover cached event/result pages. Maps without stats IDs and unreferenced subpages may remain; map IDs are not proof of ten actual participants.'}
    (output_dir / 'enrichment-report.json').write_text(json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2) + '\n')
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--catalog', type=Path, default=ROOT / '.local-data/cslink/as-tier-catalog/events-to-review.jsonl')
    parser.add_argument('--cache-dir', type=Path, default=ROOT / '.local-data/cslink/as-tier-event-pages')
    parser.add_argument('--subpage-catalog', type=Path, default=ROOT / '.local-data/cslink/as-tier-catalog/subpage-catalog.jsonl')
    parser.add_argument('--subpage-cache-dir', type=Path, default=ROOT / '.local-data/cslink/as-tier-subpages')
    parser.add_argument('--output-dir', type=Path, default=ROOT / '.local-data/cslink/as-tier-catalog')
    args = parser.parse_args()
    print(json.dumps(enrich(args.catalog, args.cache_dir, args.output_dir,
                            args.subpage_catalog, args.subpage_cache_dir), ensure_ascii=False, indent=2))
