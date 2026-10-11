import json
from datetime import date
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cslink_legacy_batch as batch


EVENT_URL = 'https://liquipedia.net/counterstrike/Test_Event/2022'
INDEX_URL = 'https://liquipedia.net/counterstrike/S-Tier_Tournaments/2012-2023'


def write_page(directory, url, wiki):
    key = batch.sha(url.encode())[:20]
    raw = json.dumps({'query': {'pages': [{'revisions': [{'slots': {
        'main': {'content': wiki}}}]}]}}).encode()
    directory.mkdir(parents=True, exist_ok=True)
    (directory / f'{key}.json').write_bytes(raw)
    meta = {'event_url': url, 'sha256': batch.sha(raw)}
    (directory / f'{key}.meta.json').write_bytes(batch.encoded(meta))
    return meta['sha256']


def capture(map_id, event_sha):
    rows = []
    for team, opponent, score, opposite, start in (
            ('Alpha', 'Beta', 16, 12, 1), ('Beta', 'Alpha', 12, 16, 6)):
        for player_id in range(start, start + 5):
            rows.append({'matchStatsId': str(map_id), 'playerId': str(player_id),
                         'playerName': f'p{player_id}', 'team': team,
                         'url': f'https://www.hltv.org/stats/players/{player_id}/p{player_id}',
                         'details': {'event': 'Test Event 2022',
                                     'dateTime': '2022-02-16 13:00', 'map': 'Mirage',
                                     'opponent': opponent, 'teamScore': score,
                                     'opponentScore': opposite}})
    return {'source_url': f'https://www.hltv.org/stats/matches/mapstatsid/{map_id}/alpha-vs-beta',
            'event_url': EVENT_URL, 'hltv_series_id_from_liquipedia': 500,
            'source_revision_sha256': event_sha, 'roster_status': 'unreviewed',
            'eligible_for_questions': False,
            'authorization_status': 'user_reported_admin_permission_personal_project',
            'captured_at_utc': '2026-10-08T00:00:00+00:00', 'rows': rows}


class LegacyBatchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.catalog = self.root / 'catalog'
        self.catalog.mkdir()
        self.old_db = self.root / 'old.sqlite3'
        self.event_cache = self.root / 'event-cache'
        self.capture_dir = self.root / 'captures'
        self.capture_dir.mkdir()
        self.output = self.root / 'batch'
        wiki = ('{{Infobox league\n|liquipediatier=S-Tier\n|sdate=2022-02-15\n'
                '|edate=2022-02-20\n}}\n'
                '{{Match\n|opponent1={{TeamOpponent|alpha}}\n'
                '|opponent2={{TeamOpponent|beta}}\n'
                '|date=February 16, 2022 - 13:00\n|hltv=500\n'
                '|map1={{Map|map=Mirage|t1t=8|t1ct=8|t2t=6|t2ct=6|stats=100}}\n'
                '|map2={{Map|map=Mirage|t1t=8|t1ct=8|t2t=6|t2ct=6|stats=101}}\n'
                '|map3={{Map|map=Mirage|t1t=8|t1ct=8|t2t=6|t2ct=6|stats=102}}\n}}')
        event_sha = write_page(self.event_cache, EVENT_URL, wiki)
        index_sha = 'a' * 64
        event = {'event_url': EVENT_URL, 'event_name': 'Test Event 2022',
                 'index_url': INDEX_URL, 'index_sha256': index_sha,
                 'page_sha256': event_sha, 'page_tier': 'S-Tier',
                 'start_date': '2022-02-15', 'page_start_date': '2022-02-15',
                 'page_end_date': '2022-02-20',
                 'scope_flags': [], 'scope_review_state': 'index_and_page_tier_date_agree'}
        exact = []
        cover = []
        db = sqlite3.connect(self.old_db)
        try:
            db.execute('CREATE TABLE maps (map_id INTEGER PRIMARY KEY, source_url TEXT, '
                       'date_raw TEXT, structure_status TEXT, review_status TEXT, '
                       'record_sha256 TEXT, record_json TEXT)')
            for map_id in (100, 101, 102):
                map_url = f'https://www.hltv.org/stats/matches/mapstatsid/{map_id}/alpha-vs-beta'
                row_sha = str(map_id).zfill(64)
                date_raw = '2022-02-16 13:00:00'
                record = {'source_url': map_url, 'record_sha256': row_sha,
                          'metadata': {'event_raw': 'Test Event 2022'}}
                db.execute('INSERT INTO maps VALUES (?,?,?,?,?,?,?)',
                           (map_id, map_url, date_raw, 'structurally_complete',
                            'unreviewed', row_sha, json.dumps(record)))
                exact.append({'map_id': map_id, 'date_raw': date_raw,
                              'hltv_map_url': map_url, 'hltv_series_id': 500,
                              'event_url': EVENT_URL, 'event_name': 'Test Event 2022',
                              'event_raw': 'Test Event 2022',
                              'event_start_date': '2022-02-15',
                              'event_end_date': '2022-02-20', 'tier': 'S-Tier',
                              'event_name_match_status': 'confirmed_by_code_rule',
                              'event_name_match_rule': 'normalized_title_exact',
                              'index_url': INDEX_URL, 'index_sha256': index_sha,
                              'source_page_url': EVENT_URL,
                              'source_revision_sha256': event_sha,
                              'record_sha256': row_sha, 'structure_status': 'structurally_complete',
                              'review_status': 'unreviewed', 'eligible_for_questions': False,
                              'scope_review_state': 'candidate_exact_map_link',
                              'match_evidence': 'Match/Map.stats'})
                cover.append({'selected_mapstatsid': map_id, 'hltv_map_url': map_url,
                              'hltv_series_id': 500,
                              'hltv_series_url': 'https://www.hltv.org/matches/500/-',
                              'event_url': EVENT_URL, 'event_start_date': '2022-02-15',
                              'tier': 'S-Tier', 'source_page_url': EVENT_URL,
                              'source_revision_sha256': event_sha,
                              'legacy_record_sha256': row_sha})
            db.commit()
        finally:
            db.close()
        files = {'events.jsonl': batch.jsonl([event]),
                 'exact-map-queue.jsonl': batch.jsonl(exact),
                 'quarantined-exact-links.jsonl': b'',
                 'capture-cover-plan.jsonl': batch.jsonl(cover),
                 'report.json': batch.encoded({'schema_version': 1})}
        for name, raw in files.items():
            (self.catalog / name).write_bytes(raw)
        manifest = {'schema_version': 1, 'rule_version': batch.RULE_VERSION,
                    'cutoff_exclusive': '2023-07-13',
                    'inputs': {'legacy_db_sha256': batch.sha(self.old_db.read_bytes()),
                               'catalog_builder_sha256': batch.sha(
                                   (batch.ROOT / 'scripts/cslink_legacy_as_catalog.py').read_bytes()),
                               'alias_ledger_sha256': batch.sha(batch.ALIAS_LEDGER.read_bytes()),
                               'index_pages': {'S': {'source_url': INDEX_URL,
                                                     'raw': {'sha256': index_sha}}},
                               'cached_event_pages': {EVENT_URL: event_sha},
                               'cached_result_subpages': {}},
                    'files': {name: batch.file_record(raw) for name, raw in files.items()}}
        (self.catalog / 'manifest.json').write_bytes(batch.encoded(manifest))
        self.event_sha = event_sha
        for map_id in (100, 101):
            (self.capture_dir / f'{map_id}.json').write_bytes(batch.encoded(capture(map_id, event_sha)))

    def run_batch(self):
        return batch.build(self.catalog, self.old_db, self.event_cache,
                           self.root / 'missing-subpages', [self.capture_dir],
                           self.output, required_ids={100})

    def rewrite_exact(self, map_id, **changes):
        path = self.catalog / 'exact-map-queue.jsonl'
        rows = [json.loads(line) for line in path.read_text().splitlines()]
        for row in rows:
            if row['map_id'] == map_id:
                row.update(changes)
        raw = batch.jsonl(rows)
        path.write_bytes(raw)
        manifest_path = self.catalog / 'manifest.json'
        manifest = json.loads(manifest_path.read_bytes())
        manifest['files']['exact-map-queue.jsonl'] = batch.file_record(raw)
        manifest['inputs']['legacy_db_sha256'] = batch.sha(self.old_db.read_bytes())
        manifest_path.write_bytes(batch.encoded(manifest))

    def make_v3_catalog(self):
        """A cumulative v3 queue with one newly admitted official short name."""
        directory = self.root / 'catalog-v3'
        directory.mkdir()
        baseline_raw = (self.catalog / 'manifest.json').read_bytes()
        baseline = json.loads(baseline_raw)
        baseline_queue = (self.catalog / 'exact-map-queue.jsonl').read_bytes()
        old_exact = batch.checked_rows(baseline_queue)
        new = dict(old_exact[-1], map_id=103,
                   hltv_map_url='https://www.hltv.org/stats/matches/mapstatsid/103/alpha-vs-beta',
                   event_raw='Short Test 2022', record_sha256='103'.zfill(64),
                   event_name_match_rule='official_infobox_tickername_exact',
                   liquipedia_match_date='2022-02-16')
        new['official_alias_evidence'] = {
            'field': 'tickername', 'raw': 'Short Test 2022',
            'event_page_url': EVENT_URL, 'event_page_sha256': self.event_sha,
            'event_page_revision_timestamp': None,
            'liquipedia_match_date': '2022-02-16'}
        events = batch.checked_rows((self.catalog / 'events.jsonl').read_bytes())
        events[0]['official_short_names'] = [{'field': 'tickername', 'raw': 'Short Test 2022'}]
        old_cover = batch.checked_rows((self.catalog / 'capture-cover-plan.jsonl').read_bytes())
        new_cover = dict(old_cover[-1], selected_mapstatsid=103,
                         hltv_map_url=new['hltv_map_url'], legacy_record_sha256=new['record_sha256'],
                         event_name_match_status='confirmed_by_code_rule',
                         event_name_match_rule=new['event_name_match_rule'],
                         liquipedia_match_date=new['liquipedia_match_date'],
                         official_alias_evidence=new['official_alias_evidence'])
        audit_keys = ('event_url', 'event_raw', 'event_name_match_rule',
                      'official_alias_evidence', 'liquipedia_match_date',
                      'event_start_date', 'event_end_date', 'source_page_url',
                      'source_revision_sha256', 'hltv_series_id', 'hltv_map_url')
        audit = {'map_id': 103, 'old_map_date': '2022-02-16', 'day_delta': 0,
                 **{key: new[key] for key in audit_keys}}
        group = {'event_url': EVENT_URL, 'official_field': 'tickername',
                 'official_field_raw': 'Short Test 2022', 'map_count': 1,
                 'map_ids': [103], 'event_page_sha256': self.event_sha}
        files = {'events.jsonl': batch.jsonl(events),
                 'exact-map-queue.jsonl': batch.jsonl([*old_exact, new]),
                 'quarantined-exact-links.jsonl': b'',
                 'capture-cover-plan.jsonl': batch.jsonl([*old_cover, new_cover]),
                 'new-exact-map-queue.jsonl': batch.jsonl([new]),
                 'new-capture-cover-plan.jsonl': batch.jsonl([new_cover]),
                 'new-map-admission-audit.jsonl': batch.jsonl([audit]),
                 'new-official-alias-groups.jsonl': batch.jsonl([group]),
                 'report.json': batch.encoded({'schema_version': 1})}
        for name, raw in files.items():
            (directory / name).write_bytes(raw)
        manifest = dict(baseline, rule_version=batch.scope_v3.RULE_VERSION,
                        inputs={**baseline['inputs'],
                                'catalog_builder_sha256': batch.sha(
                                    (batch.ROOT / 'scripts/cslink_legacy_as_catalog_v3.py').read_bytes()),
                                'v2_baseline': {
                                    'version': baseline.get('version'),
                                    'manifest_sha256': batch.sha(baseline_raw),
                                    'exact_map_queue_sha256': batch.sha(baseline_queue)}},
                        files={name: batch.file_record(raw) for name, raw in files.items()})
        (directory / 'manifest.json').write_bytes(batch.encoded(manifest))
        return directory

    def test_materializes_two_maps_same_series_and_keeps_remaining_queue(self):
        first = self.run_batch()
        self.assertEqual(first['included_capture_count'], 2)
        self.assertEqual(first['playable_map_count'], 2)
        self.assertEqual(first['remaining_exact_maps'], 1)
        self.assertEqual(first['remaining_cover_maps'], 1)
        current = self.output / 'current'
        self.assertTrue(current.is_symlink())
        remaining = [json.loads(line) for line in (current / 'remaining-cover-status.jsonl').read_text().splitlines()]
        self.assertEqual(remaining[0]['status'], 'not_attempted')
        db = sqlite3.connect(current / 'library/library.sqlite3')
        try:
            self.assertEqual([r[0] for r in db.execute('SELECT map_id FROM maps ORDER BY map_id')],
                             [100, 101])
            self.assertEqual(db.execute('SELECT COUNT(*) FROM appearances').fetchone()[0], 20)
        finally:
            db.close()
        first_target = current.resolve()
        second = self.run_batch()
        self.assertEqual(first['version'], second['version'])
        self.assertEqual(current.resolve(), first_target)

    def test_bad_capture_cannot_remove_a_previously_imported_map(self):
        first = self.run_batch()
        bad_path = self.capture_dir / '101.json'
        bad = json.loads(bad_path.read_bytes())
        bad['rows'][0]['playerId'] = '999'
        bad_path.write_bytes(batch.encoded(bad))
        with self.assertRaisesRegex(ValueError, 'Previously imported historical maps would disappear'):
            self.run_batch()
        self.assertEqual((self.output / 'current').resolve().name, first['version'])
        self.assertTrue((self.output / 'versions' / first['version']).is_dir())

    def test_catalog_tamper_aborts_before_current_pointer_moves(self):
        first = self.run_batch()
        path = self.catalog / 'exact-map-queue.jsonl'
        path.write_bytes(path.read_bytes() + b'changed')
        with self.assertRaisesRegex(ValueError, 'catalog sidecar checksum'):
            self.run_batch()
        self.assertEqual((self.output / 'current').resolve().name, first['version'])

    def test_failed_collector_attempt_keeps_map_in_queue_with_reason(self):
        (self.capture_dir / 'attempts.jsonl').write_text(json.dumps({
            'at_utc': '2026-10-08T00:01:00+00:00', 'mapstatsid': 102,
            'status': 'validation_failed', 'error': 'Expected exactly ten player rows'}) + '\n')
        report = self.run_batch()
        self.assertEqual(report['playable_map_count'], 2)
        self.assertEqual(report['failed_capture_attempts'][0]['map_id'], 102)
        remaining = [json.loads(line) for line in
                     (self.output / 'current/remaining-cover-status.jsonl').read_text().splitlines()]
        self.assertEqual(remaining[0]['status'], 'validation_failed')
        self.assertIn('ten player rows', remaining[0]['reason'])

    def test_same_map_recapture_with_new_timestamp_is_semantically_deduplicated(self):
        extra = self.root / 'extra-captures'
        extra.mkdir()
        recaptured = json.loads((self.capture_dir / '100.json').read_bytes())
        recaptured['captured_at_utc'] = '2026-10-09T00:00:00+00:00'
        (extra / '100.json').write_bytes(batch.encoded(recaptured))
        report = batch.build(self.catalog, self.old_db, self.event_cache,
                             self.root / 'missing-subpages', [self.capture_dir, extra],
                             self.output, required_ids={100})
        self.assertEqual(report['playable_map_count'], 2)
        self.assertEqual(report['matching_duplicate_captures'][0]['map_id'], 100)
        self.assertEqual(report['matching_duplicate_captures'][0]['preferred_sha256'],
                         batch.sha((self.capture_dir / '100.json').read_bytes()))

    def test_staged_version_can_be_promoted_atomically_without_rebuilding(self):
        staging = self.root / 'staging'
        staged = batch.build(self.catalog, self.old_db, self.event_cache,
                             self.root / 'missing-subpages', [self.capture_dir],
                             staging, required_ids={100})
        promoted = batch.promote(staging, self.output)
        self.assertEqual(promoted['version'], staged['version'])
        self.assertEqual((self.output / 'current').resolve().name, staged['version'])
        self.assertEqual((self.output / 'current/manifest.json').read_bytes(),
                         (staging / 'current/manifest.json').read_bytes())
        repeated = batch.promote(staging, self.output)
        self.assertEqual(repeated['version'], staged['version'])

    def test_katowice_pilot_copy_wins_over_equivalent_bulk_recapture(self):
        bulk = self.root / 'bulk'
        pilot = self.root / 'historical-as-v1/captures'
        bulk.mkdir()
        pilot.mkdir(parents=True)
        older = capture(134047, self.event_sha)
        newer = {**older, 'captured_at_utc': '2026-10-09T00:00:00+00:00'}
        (bulk / '134047.json').write_bytes(batch.encoded(newer))
        (pilot / '134047.json').write_bytes(batch.encoded(older))
        found, matches, conflicts, _ = batch.find_captures([bulk, pilot])
        self.assertEqual(conflicts, [])
        self.assertEqual(found[134047][1], pilot / '134047.json')
        self.assertEqual(matches[0]['map_id'], 134047)

    def test_conflicting_recapture_is_quarantined_without_blocking_other_maps(self):
        extra = self.root / 'extra-captures'
        extra.mkdir()
        changed = json.loads((self.capture_dir / '101.json').read_bytes())
        changed['rows'][0]['playerId'] = '999'
        changed['rows'][0]['url'] = 'https://www.hltv.org/stats/players/999/p999'
        (extra / '101.json').write_bytes(batch.encoded(changed))
        report = batch.build(self.catalog, self.old_db, self.event_cache,
                             self.root / 'missing-subpages', [self.capture_dir, extra],
                             self.output, required_ids={100})
        self.assertEqual(report['playable_map_count'], 1)
        self.assertEqual(report['rejected_captures'][0]['map_id'], 101)
        self.assertIn('Duplicate captures disagree', report['rejected_captures'][0]['reason'])
        status = [json.loads(line) for line in
                  (self.output / 'current/remaining-cover-status.jsonl').read_text().splitlines()]
        self.assertEqual(next(row for row in status if row['map_id'] == 101)['status'],
                         'capture_rejected')

    def test_page_reference_tamper_cannot_become_teammates(self):
        first = self.run_batch()
        key = batch.sha(EVENT_URL.encode())[:20]
        page = self.event_cache / f'{key}.json'
        page.write_bytes(page.read_bytes().replace(b'stats=100', b'stats=900'))
        with self.assertRaisesRegex(ValueError, 'Required historical maps missing/invalid'):
            self.run_batch()
        self.assertEqual((self.output / 'current').resolve().name, first['version'])

    def test_cross_year_exact_link_is_rejected_even_if_page_references_map(self):
        db = sqlite3.connect(self.old_db)
        try:
            db.execute('UPDATE maps SET date_raw=? WHERE map_id=100',
                       ('2013-05-16 13:00:00',))
            db.commit()
        finally:
            db.close()
        self.rewrite_exact(100, date_raw='2013-05-16 13:00:00')
        with self.assertRaisesRegex(ValueError, 'Required historical maps missing/invalid') as error:
            self.run_batch()
        self.assertIn('Old map date is outside the event interval', str(error.exception))
        self.assertFalse((self.output / 'current').exists())

    def test_v3_catalog_binds_v2_and_audits_each_new_official_alias_map(self):
        directory = self.make_v3_catalog()
        _, _, events, exact, cover = batch.read_catalog(directory, self.old_db, self.catalog)
        self.assertEqual(set(exact), {100, 101, 102, 103})
        self.assertEqual(exact[103]['official_alias_evidence']['raw'], 'Short Test 2022')
        self.assertEqual(events[EVENT_URL]['official_short_names'][0]['field'], 'tickername')
        self.assertIn(103, cover)
        audit_path = directory / 'new-map-admission-audit.jsonl'
        audit = batch.checked_rows(audit_path.read_bytes())[0]
        audit['official_alias_evidence']['raw'] = 'Wrong Name'
        audit_raw = batch.jsonl([audit])
        audit_path.write_bytes(audit_raw)
        manifest_path = directory / 'manifest.json'
        manifest = json.loads(manifest_path.read_bytes())
        manifest['files'][audit_path.name] = batch.file_record(audit_raw)
        manifest_path.write_bytes(batch.encoded(manifest))
        with self.assertRaisesRegex(ValueError, 'admission audit differs'):
            batch.read_catalog(directory, self.old_db, self.catalog)

    def test_v3_catalog_rejects_an_unbound_v2_baseline(self):
        directory = self.make_v3_catalog()
        manifest_path = directory / 'manifest.json'
        manifest = json.loads(manifest_path.read_bytes())
        manifest['inputs']['v2_baseline']['exact_map_queue_sha256'] = '0' * 64
        manifest_path.write_bytes(batch.encoded(manifest))
        with self.assertRaisesRegex(ValueError, 'does not bind the frozen v2 baseline'):
            batch.read_catalog(directory, self.old_db, self.catalog)

    def test_wrong_event_label_is_rejected_even_with_matching_hltv_capture(self):
        db = sqlite3.connect(self.old_db)
        try:
            record = json.loads(db.execute('SELECT record_json FROM maps WHERE map_id=100').fetchone()[0])
            record['metadata']['event_raw'] = 'Different League 2022'
            db.execute('UPDATE maps SET record_json=? WHERE map_id=100', (json.dumps(record),))
            db.commit()
        finally:
            db.close()
        self.rewrite_exact(100, event_raw='Different League 2022')
        raw = json.loads((self.capture_dir / '100.json').read_bytes())
        for row in raw['rows']:
            row['details']['event'] = 'Different League 2022'
        (self.capture_dir / '100.json').write_bytes(batch.encoded(raw))
        with self.assertRaisesRegex(ValueError, 'Required historical maps missing/invalid') as error:
            self.run_batch()
        self.assertIn('legacy_event_title_unconfirmed', str(error.exception))

    def test_hltv_date_outside_event_is_rejected(self):
        raw = json.loads((self.capture_dir / '100.json').read_bytes())
        for row in raw['rows']:
            row['details']['dateTime'] = '2023-02-16 13:00'
        (self.capture_dir / '100.json').write_bytes(batch.encoded(raw))
        with self.assertRaisesRegex(ValueError, 'Required historical maps missing/invalid') as error:
            self.run_batch()
        self.assertIn('HLTV map date disagrees', str(error.exception))

    def test_historical_map_name_aliases_are_explicit_and_directional(self):
        for lp_name, hltv_name in batch.LP_HLTV_MAP_NAME_PAIRS:
            with self.subTest(lp_name=lp_name, hltv_name=hltv_name):
                self.assertTrue(batch.map_names_agree(lp_name, hltv_name))
                self.assertFalse(batch.map_names_agree(hltv_name, lp_name))
        for lp_name, hltv_name in (('Nuke', 'Mirage_ce'), ('Train', 'Train_ce'),
                                   ('Nuke VE', 'Nuke'), ('Dust II', 'Dust2_ce')):
            with self.subTest(lp_name=lp_name, hltv_name=hltv_name):
                self.assertFalse(batch.map_names_agree(lp_name, hltv_name))
        self.assertTrue(batch.map_names_agree('Dust II', 'Dust-II'))

    def test_attested_hltv_map_alias_passes_capture_validation(self):
        row = json.loads((self.catalog / 'exact-map-queue.jsonl').read_text().splitlines()[0])
        raw = capture(100, self.event_sha)
        for player in raw['rows']:
            player['details']['map'] = 'Dust2_se'
        dates = {'event_start': date(2022, 2, 15), 'event_end': date(2022, 2, 20),
                 'old_day': date(2022, 2, 16),
                 'match': {'match_date': '2022-02-16', 'map_name': 'Dust II',
                           'map_scores': [16, 12]}}
        self.assertEqual(batch.validated_capture(row, batch.encoded(raw), dates)['map_as_displayed'],
                         'Dust2_se')
        for player in raw['rows']:
            player['details']['map'] = 'Nuke_se'
        with self.assertRaisesRegex(ValueError, 'map name differs'):
            batch.validated_capture(row, batch.encoded(raw), dates)


if __name__ == '__main__':
    unittest.main()
