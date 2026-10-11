#!/usr/bin/env python3
"""Discover official-event result subpages referenced by cached event wikitext."""

import argparse
import json
from pathlib import Path
import re
from urllib.parse import quote

from cslink_tier_enrich import ROOT, event_cache


def discover(catalog, cache_dir, output):
    rows = [json.loads(line) for line in catalog.read_text().splitlines() if line.strip()]
    found = {}
    for event in rows:
        loaded = event_cache(cache_dir, event['event_url'])
        if loaded is None:
            continue
        wiki, meta = loaded
        titles = re.findall(r'\{\{#section\s*:\s*([^|}]+)\s*\|\s*Results\s*\}\}', wiki, re.I)
        relative = re.findall(r'\{\{ShowStandings\s*\|\s*page=\{\{PAGENAME\}\}/([^}|]+)', wiki, re.I)
        titles += [meta['page_title'] + '/' + name.strip() for name in relative]
        for title in titles:
            title = title.strip()
            if not title.lower().startswith(meta['page_title'].lower() + '/'):
                raise ValueError(f'Unexpected result transclusion: {title} from {meta["page_title"]}')
            suffix = title[len(meta['page_title']) + 1:]
            if not re.fullmatch(r'(?:Stage\s*[1-9][0-9]*|Opening Stage|Elimination Stage|Playoffs?)', suffix, re.I):
                raise ValueError(f'Unexpected result subpage: {title}')
            url = 'https://liquipedia.net/counterstrike/' + quote(title.replace(' ', '_'), safe='/')
            found[url] = {'event_url': url, 'parent_event_url': event['event_url'],
                          'parent_event_name': event['event_name'], 'discovered_from': 'result_transclusion'}
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(''.join(json.dumps(found[url], ensure_ascii=False, sort_keys=True) + '\n'
                              for url in sorted(found)))
    return {'result_subpages': len(found), 'parent_events': len(set(x['parent_event_url'] for x in found.values()))}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--catalog', type=Path, default=ROOT / '.local-data/cslink/as-tier-catalog/events-to-review.jsonl')
    parser.add_argument('--cache-dir', type=Path, default=ROOT / '.local-data/cslink/as-tier-event-pages')
    parser.add_argument('--output', type=Path, default=ROOT / '.local-data/cslink/as-tier-catalog/subpage-catalog.jsonl')
    args = parser.parse_args()
    print(json.dumps(discover(args.catalog, args.cache_dir, args.output), ensure_ascii=False))
