#!/usr/bin/env python3
"""Build a reviewable A/S tournament candidate list from cached Liquipedia API replies.

This reads MediaWiki API `action=parse` JSON, never generated website pages.
Index membership is a lead, not approval of a tournament or of map appearances.
"""

import argparse
from collections import Counter
from datetime import date
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re
from urllib.parse import urljoin, urlsplit


ROOT = Path(__file__).resolve().parents[1]
PAGES = {
    'S-Tier_Tournaments': 'S',
    'A-Tier_Tournaments': 'A',
    'S-Tier_Tournaments--2012-2023': 'S',
    'A-Tier_Tournaments--2016-2023': 'A',
}
FIRST_DATE = date(2023, 7, 13)  # Keep the overlap day; map IDs handle duplicates later.
LAST_DATE = date(2026, 10, 3)
MONTHS = {month: index for index, month in enumerate(
    ('Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'), 1)}


class TournamentRows(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.div_depth = 0
        self.listing_depth = None
        self.year = None
        self.row = None
        self.cell = None
        self.rows = []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'h3' and re.fullmatch(r'20\d\d', attrs.get('id', '')):
            self.year = int(attrs['id'])
        if tag == 'div':
            self.div_depth += 1
            if 'tournaments-listing' in attrs.get('class', '').split():
                self.listing_depth = self.div_depth
        if self.listing_depth is None:
            return
        if tag == 'tr' and 'row--body' in attrs.get('class', ''):
            self.row = {'year': self.year, 'class': attrs.get('class', ''), 'cells': []}
        elif tag == 'td' and self.row is not None:
            self.cell = {'text': [], 'links': [], 'sort_value': attrs.get('data-sort-value')}
        elif tag == 'a' and self.cell is not None:
            self.cell['links'].append({'href': attrs.get('href', ''), 'title': attrs.get('title', '')})

    def handle_data(self, data):
        if self.cell is not None:
            self.cell['text'].append(data)

    def handle_endtag(self, tag):
        if tag == 'td' and self.cell is not None and self.row is not None:
            self.cell['text'] = ' '.join(' '.join(self.cell['text']).split())
            self.row['cells'].append(self.cell)
            self.cell = None
        elif tag == 'tr' and self.row is not None:
            self.rows.append(self.row)
            self.row = None
        elif tag == 'div':
            if self.listing_depth == self.div_depth:
                self.listing_depth = None
            self.div_depth -= 1


def start_date(date_text):
    """Parse only the opening date; uncertain formats stay unclassified."""
    match = re.search(r'\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2})\b', date_text)
    years = re.findall(r'\b20\d{2}\b', date_text)
    if not match or not years:
        return None
    year = int(years[0])
    if len(years) == 1:
        months = re.findall(r'\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b', date_text)
        if len(months) > 1 and MONTHS[match.group(1)] > MONTHS[months[-1]]:
            year -= 1
    try:
        return date(year, MONTHS[match.group(1)], int(match.group(2)))
    except ValueError:
        return None


def candidate(row, tier, index_url):
    cells = row['cells']
    if len(cells) < 7:
        return None
    event_cell = cells[2]
    link = next((link for link in event_cell['links']
                 if link['href'].startswith('/counterstrike/') and
                 '/File:' not in link['href']), None)
    if not link:
        return None
    url = urljoin('https://liquipedia.net', link['href'])
    if urlsplit(url).netloc != 'liquipedia.net':
        return None
    name = event_cell['text'] or event_cell.get('sort_value') or link['title']
    raw_date = cells[3]['text']
    begun = start_date(raw_date)
    reasons = []
    if begun is None:
        reasons.append('date_unparsed')
    elif not FIRST_DATE <= begun <= LAST_DATE:
        reasons.append('outside_window')
    if re.search(r'\b(?:cancelled|canceled)\b', ' '.join(c['text'] for c in cells), re.I):
        reasons.append('cancelled')
    if re.search(r'\bRMR\b|Regional.Major.Rankings', name + ' ' + url, re.I):
        reasons.append('independent_major_qualifier')
    return {
        'event_url': url, 'event_name': name, 'index_tier': tier,
        'index_url': index_url, 'index_year': row['year'],
        'date_raw': raw_date, 'start_date': begun.isoformat() if begun else None,
        'participants_raw': cells[6]['text'], 'review_state': 'candidate' if not reasons else 'needs_scope_review',
        'scope_flags': reasons, 'hltv_event_id': None, 'map_count': None,
    }


def build(cache_dir, output_dir):
    events = {}
    page_reports = []
    for stem, tier in PAGES.items():
        path = cache_dir / (stem + '.json')
        meta_path = cache_dir / (stem + '.meta.json')
        raw = path.read_bytes()
        meta = json.loads(meta_path.read_text())
        if hashlib.sha256(raw).hexdigest() != meta['sha256']:
            raise ValueError(f'API cache checksum mismatch: {path}')
        data = json.loads(raw)
        if 'parse' not in data or not isinstance(data['parse'].get('text'), str):
            raise ValueError(f'No parsed HTML in API response: {path}')
        parser = TournamentRows()
        parser.feed(data['parse']['text'])
        index_url = 'https://liquipedia.net/counterstrike/' + meta['page']
        parsed = [candidate(row, tier, index_url) for row in parser.rows]
        parsed = [item for item in parsed if item]
        for item in parsed:
            key = item['event_url']
            if key in events and events[key]['index_tier'] != tier:
                events[key]['scope_flags'].append('index_tier_conflict')
                item['scope_flags'].append('index_tier_conflict')
                # Retain the first row for inspection; the conflict is explicit.
            elif key not in events:
                events[key] = item
        page_reports.append({'page': meta['page'], 'api_sha256': meta['sha256'],
                             'listing_rows': len(parser.rows), 'parsed_events': len(parsed)})
    ordered = sorted(events.values(), key=lambda x: (x['start_date'] or '', x['event_url']))
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / 'events-all.jsonl').write_text(''.join(json.dumps(x, ensure_ascii=False, sort_keys=True) + '\n' for x in ordered))
    eligible = [x for x in ordered if x['review_state'] == 'candidate']
    (output_dir / 'events-to-review.jsonl').write_text(''.join(json.dumps(x, ensure_ascii=False, sort_keys=True) + '\n' for x in eligible))
    report = {'schema_version': 1, 'scope_start': FIRST_DATE.isoformat(), 'scope_end': LAST_DATE.isoformat(),
              'pages': page_reports, 'unique_index_events': len(ordered),
              'window_candidates_pending_per_event_review': len(eligible),
              'candidate_by_year_and_tier': dict(sorted(Counter(f"{x['start_date'][:4]}-{x['index_tier']}" for x in eligible).items())),
              'flag_counts': dict(sorted(Counter(flag for x in ordered for flag in x['scope_flags']).items())),
              'hltv_event_ids_resolved': 0, 'map_rosters_verified': 0,
              'note': 'Index rows are candidates only. Check each event page, exclude independent qualifiers, and map to a licensed actual-appearance source before publishing.'}
    (output_dir / 'report.json').write_text(json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2) + '\n')
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--cache-dir', type=Path, default=ROOT / '.local-data/cslink/as-tier-api')
    parser.add_argument('--output-dir', type=Path, default=ROOT / '.local-data/cslink/as-tier-catalog')
    args = parser.parse_args()
    print(json.dumps(build(args.cache_dir, args.output_dir), ensure_ascii=False, indent=2))
