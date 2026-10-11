#!/usr/bin/env python3
"""Create an immutable effective capture plan from the frozen source plan plus reviewed ID corrections.

This script is offline. It does not change the Liquipedia cache, source snapshot,
original cover plan, or its manifest. Link verification is distinct from roster review.
"""

import argparse
from datetime import date
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / 'data/cslink/as-tier-event-cover-2026-10-03'
LEDGER = ROOT / 'data/cslink/map-id-corrections-2026-10-04.jsonl'
OUTPUT = ROOT / 'data/cslink/as-tier-event-cover-2026-10-04-corrected'
BASE_PLAN_SHA256 = 'e6c4a5f1ec550fb18b282a13702b9416dfbc7fdf5bb85552209593458194615e'
BASE_MANIFEST_SHA256 = '1ffe74c470c499ef5ae45d4587891758ba2fbd21bab9e49f1bd41429b06c79c3'


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def jsonl(rows):
    return ''.join(json.dumps(row, ensure_ascii=False, sort_keys=True) + '\n' for row in rows).encode()


def hltv_path(url, pattern):
    parsed = urlsplit(url)
    match = re.fullmatch(pattern, parsed.path)
    if parsed.scheme != 'https' or parsed.netloc != 'www.hltv.org' or not match or parsed.query or parsed.fragment:
        raise ValueError(f'Invalid HLTV reference URL: {url}')
    return int(match.group(1))


def build(base_dir=BASE, ledger_path=LEDGER, output_dir=OUTPUT):
    base_path = base_dir / 'selected-series.jsonl'
    base_raw = base_path.read_bytes()
    manifest_raw = (base_dir / 'manifest.json').read_bytes()
    if digest(base_raw) != BASE_PLAN_SHA256 or digest(manifest_raw) != BASE_MANIFEST_SHA256:
        raise ValueError('Frozen source plan or manifest changed')
    manifest = json.loads(manifest_raw)
    selected_info = manifest['files']['selected-series.jsonl']
    if selected_info != {'bytes': len(base_raw), 'sha256': BASE_PLAN_SHA256}:
        raise ValueError('Frozen manifest does not bind the selected-series plan')
    original_lines = [line + b'\n' for line in base_raw.splitlines() if line.strip()]
    original_rows = [json.loads(line) for line in original_lines]
    selected_ids = [row['selected_mapstatsid'] for row in original_rows]
    series_ids = [row['hltv_series_id'] for row in original_rows]
    if len(set(selected_ids)) != len(selected_ids) or len(set(series_ids)) != len(series_ids):
        raise ValueError('Frozen selection has duplicate map or series IDs')
    original_candidate_ids = {map_id for row in original_rows
                              for map_id in row['candidate_mapstatsids_in_series']}

    ledger_raw = ledger_path.read_bytes()
    corrections = [json.loads(line) for line in ledger_raw.splitlines() if line.strip()]
    if len(corrections) != 1:
        raise ValueError('This frozen correction plan requires exactly one ledger entry')
    correction = corrections[0]
    old_id, new_id = correction['original_mapstatsid'], correction['verified_mapstatsid']
    series_id = correction['hltv_series_id']
    if (type(old_id) is not int or type(new_id) is not int or old_id <= 0 or new_id <= 0 or
            old_id == new_id or type(series_id) is not int or series_id <= 0 or
            correction['base_plan_sha256'] != BASE_PLAN_SHA256 or
            new_id in original_candidate_ids or new_id in selected_ids):
        raise ValueError('Invalid or conflicting map ID correction')
    if (hltv_path(correction['canonical_map_url'], r'/stats/matches/mapstatsid/(\d+)/[^/]+') != new_id or
            hltv_path(correction['original_map_url'], r'/stats/matches/mapstatsid/(\d+)/-') != old_id or
            hltv_path(correction['hltv_series_url'], r'/matches/(\d+)/[^/]+') != series_id):
        raise ValueError('Correction URLs do not bind the selected map and series IDs')
    if (correction['map_number'] != 1 or correction['map_name'] != 'Overpass' or
            correction['verification_time_precision'] != 'day' or
            correction['verified_timezone'] != 'Asia/Shanghai' or
            not correction['verification_method'] or not correction['verification_note']):
        raise ValueError('Missing map-slot or manual verification provenance')
    date.fromisoformat(correction['verified_on_local'])

    matching = [i for i, row in enumerate(original_rows)
                if row['selected_mapstatsid'] == old_id and row['hltv_series_id'] == series_id]
    if len(matching) != 1:
        raise ValueError('Correction does not identify one selected source row')
    index = matching[0]
    source = original_rows[index]
    if (digest(original_lines[index]) != correction['original_row_sha256'] or
            source['event_url'] != correction['event_url'] or
            source['source_page_url'] != correction['source_page_url'] or
            source['source_revision_sha256'] != correction['source_revision_sha256'] or
            source['hltv_series_url'] != correction['hltv_series_url'] or
            source['hltv_map_url'] != correction['original_map_url'] or
            source['candidate_mapstatsids_in_series'][0] != old_id or
            source['roster_status'] != 'unverified' or source['eligible_for_questions'] is not False):
        raise ValueError('Correction conflicts with frozen row or release gates')

    effective = [dict(row) for row in original_rows]
    updated = dict(source)
    updated.update({
        'selected_mapstatsid': new_id,
        'candidate_mapstatsids_in_series': [new_id if value == old_id else value
                                            for value in source['candidate_mapstatsids_in_series']],
        'hltv_map_url': correction['canonical_map_url'],
        'hltv_link_status': 'verified_from_official_hltv_series_page',
        'source_selected_mapstatsid': old_id,
        'source_candidate_mapstatsids_in_series': source['candidate_mapstatsids_in_series'],
        'source_hltv_map_url': source['hltv_map_url'],
        'map_id_correction_id': correction['correction_id'],
        'verified_map_number': correction['map_number'],
        'verified_map_name': correction['map_name'],
        'link_verified_on_local': correction['verified_on_local'],
    })
    effective[index] = updated
    if any(effective[i] != original_rows[i] for i in range(len(effective)) if i != index):
        raise AssertionError('An unrelated selection row changed')
    if len({row['selected_mapstatsid'] for row in effective}) != len(effective):
        raise ValueError('Corrected plan has duplicate selected map IDs')
    if updated['roster_status'] != 'unverified' or updated['eligible_for_questions'] is not False:
        raise ValueError('A link correction cannot approve a roster or question')

    plan_raw = jsonl(effective)
    audit = {'correction_id': correction['correction_id'],
             'source_plan_sha256': BASE_PLAN_SHA256, 'correction_ledger_sha256': digest(ledger_raw),
             'original_row_sha256': correction['original_row_sha256'],
             'effective_row_sha256': digest(jsonl([updated])),
             'hltv_series_id': series_id, 'original_mapstatsid': old_id,
             'verified_mapstatsid': new_id, 'canonical_map_url': correction['canonical_map_url'],
             'verification_source_url': correction['hltv_series_url'],
             'source_page_url': correction['source_page_url'],
             'source_revision_sha256': correction['source_revision_sha256']}
    report = {'schema_version': 1, 'source_plan_sha256': BASE_PLAN_SHA256,
              'source_manifest_sha256': BASE_MANIFEST_SHA256,
              'correction_ledger_sha256': digest(ledger_raw),
              'effective_plan_sha256': digest(plan_raw),
              'selected_series': len(effective), 'changed_rows': 1,
              'link_review_state': 'manual_official_series_link_check',
              'roster_review_state': 'unverified', 'eligible_for_questions': False}
    outputs = {'selected-series.jsonl': plan_raw,
               'correction-applied.jsonl': jsonl([audit]),
               'report.json': (json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode()}
    output_manifest = {'schema_version': 1,
                       'inputs': {'source_plan_sha256': BASE_PLAN_SHA256,
                                  'source_manifest_sha256': BASE_MANIFEST_SHA256,
                                  'correction_ledger_sha256': digest(ledger_raw)},
                       'files': {name: {'bytes': len(raw), 'sha256': digest(raw)}
                                 for name, raw in sorted(outputs.items())}}
    outputs['manifest.json'] = (json.dumps(output_manifest, ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode()
    output_dir.mkdir(parents=True, exist_ok=True)
    for name, raw in outputs.items():
        target = output_dir / name
        if target.exists() and target.read_bytes() != raw:
            raise ValueError(f'Refusing to overwrite changed effective plan: {target}')
    for name, raw in outputs.items():
        (output_dir / name).write_bytes(raw)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--base', type=Path, default=BASE)
    parser.add_argument('--ledger', type=Path, default=LEDGER)
    parser.add_argument('--output', type=Path, default=OUTPUT)
    args = parser.parse_args()
    print(json.dumps(build(args.base, args.ledger, args.output), ensure_ascii=False, indent=2))
