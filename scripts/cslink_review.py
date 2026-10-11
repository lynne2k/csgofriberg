#!/usr/bin/env python3
"""Compile explicit, offline page observations into review candidates. No crawler."""
import argparse
import copy
import json
from pathlib import Path
import re
import sqlite3

import cslink_data as data

MAP_NAMES = {'anc': 'Ancient', 'cbl': 'Cobblestone', 'cch': 'Cache',
             'd2': 'Dust2', 'inf': 'Inferno', 'mrg': 'Mirage',
             'nuke': 'Nuke', 'ovp': 'Overpass', 'trn': 'Train'}


def compile_batch(version, registry, reviews, batch):
    manifest = data.verify_output(version)
    if manifest['version'] != batch['source_version']:
        raise ValueError('Audit must name its inspected source version')
    registry, reviews = copy.deepcopy(registry), copy.deepcopy(reviews)
    data.validate_players(registry)
    external = {str(p['external_ids']['hltv']): p for p in registry['players']}
    existing = {r['map_id']: r for r in reviews['maps']}
    next_id = max(int(p['player_id'].rsplit('-', 1)[1]) for p in registry['players']) + 1
    batch_hash = data.digest(batch)
    seen = set()
    with sqlite3.connect(f'file:{version / "staging.sqlite3"}?mode=ro', uri=True) as db:
        for item in batch['maps']:
            mid = item['map_id']
            if mid in seen:
                raise ValueError('Duplicate map in audit batch')
            seen.add(mid)
            row = db.execute('SELECT record_json FROM maps WHERE map_id=?', (mid,)).fetchone()
            if not row:
                raise ValueError('Audit map does not exist')
            record = json.loads(row[0])
            if item['record_sha256'] != record['record_sha256'] or item['source_url'] != record['source_url']:
                raise ValueError('Stale audit fingerprint or source URL')
            # Register external identities observed in any reviewed outcome. This
            # does not grant appearances or edges to deferred/excluded maps.
            for group in item['observed_groups']:
                for slot in group['players']:
                    hid = str(slot['hltv_id'])
                    if not re.fullmatch(r'https://www\.hltv\.org/stats/players/' + re.escape(hid) + r'/[^/\s?#]+', slot['profile_url']):
                        raise ValueError('Observed player link and ID disagree')
                    if hid not in external:
                        person = {'player_id': f'cs-person-{next_id:06}', 'nickname': slot['nickname'],
                                  'external_ids': {'hltv': hid},
                                  'evidence_urls': [slot['profile_url'], item['source_url']],
                                  'identity_verified_on': batch['reviewed_on'],
                                  'identity_review_method': 'primary_source_map_profile_link'}
                        registry['players'].append(person)
                        external[hid] = person
                        next_id += 1
            review = {key: item[key] for key in ('map_id', 'record_sha256', 'decision', 'reason', 'competition_type')}
            review.update({key: batch[key] for key in ('reviewed_on', 'reviewed_by', 'review_method')})
            review.update(evidence_schema_version=2, evidence_urls=[item['source_url']],
                          audit_batch_id=batch['batch_id'], audit_batch_sha256=batch_hash,
                          observed_timestamp_ms=item['observed_timestamp_ms'],
                          date_note=batch['time_note'])
            if item['decision'] == 'verify':
                assignment = item['group_team_indices']
                if assignment not in [[0, 1], [1, 0]]:
                    raise ValueError('Explicit team assignment is required')
                if [record['metadata']['score'][i] for i in assignment] != item['observed_score']:
                    raise ValueError('Observed score does not match team assignment')
                if MAP_NAMES.get(record['metadata']['map_raw']) != re.sub(r'_(se|ce)$', '', item['observed_map']):
                    raise ValueError('Observed map differs from original record')
                names = [list(g['names_raw']) for g in record['stat_groups']]
                for fix in item.get('nickname_corrections', []):
                    names[fix['group_no']-1][fix['slot']-1] = fix['corrected']
                ordered = []
                for g, observed in enumerate(item['observed_groups']):
                    by_name = {p['nickname']: p for p in observed['players']}
                    if len(by_name) != 5 or set(names[g]) != set(by_name):
                        raise ValueError('Exact case-sensitive roster differs; explicit correction required')
                    ordered.append({**observed, 'players': [by_name[name] for name in names[g]]})
                review.update(actual_map_played=True, group_team_indices=assignment,
                              observed_groups=ordered,
                              player_ids=[[external[str(p['hltv_id'])]['player_id'] for p in g['players']] for g in ordered])
                if item.get('nickname_corrections'):
                    review['nickname_corrections'] = item['nickname_corrections']
            data.apply_review(copy.deepcopy(record), review, data.validate_players(registry))
            if mid in existing:
                if existing[mid] != review:
                    raise ValueError('Refusing to overwrite a different existing review')
            else:
                reviews['maps'].append(review)
                existing[mid] = review
    # Each of these pairs is independently demonstrated by profile links in this
    # batch. Similar spelling does not assign either identity to other maps.
    for left, right in [('629', '737'), ('334', '7433')]:
        if left in external and right in external:
            pair = [external[left]['player_id'], external[right]['player_id']]
            if pair not in registry['distinct_player_pairs'] and pair[::-1] not in registry['distinct_player_pairs']:
                registry['distinct_player_pairs'].append(pair)
    data.validate_players(registry)
    return registry, reviews


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--batch', type=Path, required=True)
    parser.add_argument('--version-path', type=Path, required=True)
    parser.add_argument('--players', type=Path, default=data.CONFIG / 'players.json')
    parser.add_argument('--reviews', type=Path, default=data.CONFIG / 'reviews.json')
    parser.add_argument('--output-dir', type=Path, required=True)
    args = parser.parse_args()
    registry, reviews = compile_batch(args.version_path.resolve(), json.loads(args.players.read_text()),
                                     json.loads(args.reviews.read_text()), json.loads(args.batch.read_text()))
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for name, value in [('players.json', registry), ('reviews.json', reviews)]:
        path = args.output_dir / name
        if path.exists() and json.loads(path.read_text()) != value:
            raise ValueError(f'Refusing to overwrite different candidate: {path}')
        data.write_json(path, value)
    print(json.dumps({'people': len(registry['players']), 'map_reviews': len(reviews['maps']),
                      'output_dir': str(args.output_dir)}))


if __name__ == '__main__':
    main()
