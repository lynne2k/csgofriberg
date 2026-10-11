#!/usr/bin/env python3
"""Cache tournament wikitext through Liquipedia's permitted MediaWiki API.

Set CSLINK_LP_CONTACT to a public email address or project URL. The contact is
sent only in User-Agent and is never written to cache or output files.
"""

import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import time
from urllib.error import HTTPError, URLError
from urllib.parse import unquote, urlencode, urlsplit
from urllib.request import Request, build_opener


ROOT = Path(__file__).resolve().parents[1]
API = 'https://liquipedia.net/counterstrike/api.php'
INDEX_PAGES = ['S-Tier_Tournaments', 'A-Tier_Tournaments',
               'S-Tier_Tournaments/2012-2023', 'A-Tier_Tournaments/2016-2023']


def user_agent(contact):
    if not (re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', contact) or
            (contact.startswith('https://') and urlsplit(contact).netloc)):
        raise ValueError('CSLINK_LP_CONTACT must be a public email address or HTTPS project URL')
    return f'CSLinkResearch/0.1 ({"mailto:" if "@" in contact else ""}{contact})'


def title_from_url(url):
    parts = urlsplit(url)
    if parts.scheme != 'https' or parts.netloc != 'liquipedia.net' or not parts.path.startswith('/counterstrike/'):
        raise ValueError(f'Invalid Liquipedia event URL: {url}')
    return unquote(parts.path.removeprefix('/counterstrike/')).replace('_', ' ')


def fetch(catalog, cache_dir, contact, limit):
    ua = user_agent(contact)
    opener = build_opener()
    cache_dir.mkdir(parents=True, exist_ok=True)
    rows = [json.loads(line) for line in catalog.read_text().splitlines() if line.strip()]
    rows = sorted(rows, key=lambda x: x['event_url'])
    fetched = skipped = failed = 0
    last_start = None
    for row in rows[:limit]:
        title = title_from_url(row['event_url'])
        key = hashlib.sha256(row['event_url'].encode()).hexdigest()[:20]
        path = cache_dir / f'{key}.json'
        meta_path = cache_dir / f'{key}.meta.json'
        if path.is_file() and meta_path.is_file():
            meta = json.loads(meta_path.read_text())
            if hashlib.sha256(path.read_bytes()).hexdigest() != meta['sha256'] or meta['event_url'] != row['event_url']:
                raise ValueError(f'Changed cached source: {path}')
            skipped += 1
            continue
        if last_start is not None:
            time.sleep(max(0, 2.2 - (time.monotonic() - last_start)))
        url = API + '?' + urlencode({'action': 'query', 'prop': 'revisions', 'rvprop': 'content|timestamp',
                                     'rvslots': 'main', 'titles': title, 'format': 'json', 'formatversion': '2'})
        request = Request(url, headers={'User-Agent': ua, 'Accept-Encoding': 'gzip', 'Accept': 'application/json'})
        last_start = time.monotonic()
        try:
            with opener.open(request, timeout=35) as response:
                raw = response.read()
                if response.headers.get('Content-Encoding') == 'gzip':
                    raw = gzip.decompress(raw)
            data = json.loads(raw)
            page = data.get('query', {}).get('pages', [{}])[0]
            content = page.get('revisions', [{}])[0].get('slots', {}).get('main', {}).get('content')
            if not isinstance(content, str):
                raise ValueError(f'No wikitext for {title}: {list(data)}')
            path.write_bytes(raw)
            meta_path.write_text(json.dumps({'event_url': row['event_url'], 'page_title': page['title'],
                                             'api_url': url, 'sha256': hashlib.sha256(raw).hexdigest(),
                                             'bytes': len(raw), 'revision_timestamp': page['revisions'][0].get('timestamp'),
                                             'fetched_at_utc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())},
                                            ensure_ascii=False, sort_keys=True, indent=2) + '\n')
            fetched += 1
        except (HTTPError, URLError, ValueError, TimeoutError) as exc:
            failed += 1
            print(f'FAILED {title}: {type(exc).__name__}: {exc}', flush=True)
            if isinstance(exc, HTTPError) and exc.code in (403, 429):
                break
        if (fetched + failed) % 20 == 0:
            print(f'progress fetched={fetched} skipped={skipped} failed={failed}', flush=True)
    print(json.dumps({'fetched': fetched, 'cached': skipped, 'failed': failed,
                      'requested_limit': limit, 'candidate_total': len(rows)}, sort_keys=True), flush=True)


def fetch_indices(cache_dir, contact):
    ua = user_agent(contact)
    opener = build_opener()
    cache_dir.mkdir(parents=True, exist_ok=True)
    last_start = None
    fetched = skipped = 0
    for page in INDEX_PAGES:
        stem = page.replace('/', '--')
        path = cache_dir / f'{stem}.json'
        meta_path = cache_dir / f'{stem}.meta.json'
        if path.is_file() and meta_path.is_file():
            meta = json.loads(meta_path.read_text())
            if hashlib.sha256(path.read_bytes()).hexdigest() != meta['sha256'] or meta['page'] != page:
                raise ValueError(f'Changed cached index: {path}')
            skipped += 1
            continue
        if last_start is not None:
            time.sleep(max(0, 31 - (time.monotonic() - last_start)))
        url = API + '?' + urlencode({'action': 'parse', 'page': page, 'prop': 'text',
                                     'format': 'json', 'formatversion': '2'})
        request = Request(url, headers={'User-Agent': ua, 'Accept-Encoding': 'gzip', 'Accept': 'application/json'})
        last_start = time.monotonic()
        with opener.open(request, timeout=40) as response:
            raw = response.read()
            if response.headers.get('Content-Encoding') == 'gzip':
                raw = gzip.decompress(raw)
        data = json.loads(raw)
        if not isinstance(data.get('parse', {}).get('text'), str):
            raise ValueError(f'No parsed index text: {page}')
        path.write_bytes(raw)
        meta_path.write_text(json.dumps({'api_url': url, 'page': page,
                                         'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw),
                                         'fetched_at_utc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())},
                                        sort_keys=True, indent=2) + '\n')
        fetched += 1
        print(f'index {page}: cached', flush=True)
    print(json.dumps({'index_fetched': fetched, 'index_cached': skipped}, sort_keys=True), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--catalog', type=Path, default=ROOT / '.local-data/cslink/as-tier-catalog/events-to-review.jsonl')
    parser.add_argument('--cache-dir', type=Path)
    parser.add_argument('--indices', action='store_true', help='Fetch the four tier index pages instead of event pages')
    parser.add_argument('--limit', type=int, default=110)
    args = parser.parse_args()
    contact = os.environ.get('CSLINK_LP_CONTACT', '')
    if args.indices:
        fetch_indices(args.cache_dir or ROOT / '.local-data/cslink/as-tier-api', contact)
    else:
        fetch(args.catalog, args.cache_dir or ROOT / '.local-data/cslink/as-tier-event-pages',
              contact, args.limit)
