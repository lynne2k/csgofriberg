import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cslink_legacy_roster_pilot as legacy


EVENT_URL = 'https://liquipedia.net/counterstrike/Intel_Extreme_Masters/Season_XVI/Katowice'
MAP_URL = 'https://www.hltv.org/stats/matches/mapstatsid/134047/liquid-vs-faze'
SERIES_URL = 'https://www.hltv.org/matches/2354380/liquid-vs-faze-iem-katowice-2022'
FAZE_IDS = ['429', '4679', '8183', '10394', '18053']


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value))


class LegacyRosterPilotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.selection = {'schema_version': 1,
                          'event_name': 'Intel Extreme Masters XVI - Katowice',
                          'hltv_event_name': 'IEM Katowice 2022',
                          'event_url': EVENT_URL, 'event_start_date': '2022-02-15',
                          'tier': 'S-Tier', 'team_name': 'FaZe',
                          'maps': [{'map_id': 134047, 'series_id': 2354380,
                                    'series_url': SERIES_URL,
                                    'expected_team_player_ids': FAZE_IDS,
                                    'case': 'jks_with_rain'}]}
        self.selection_path = self.root / 'selection.json'
        write_json(self.selection_path, self.selection)
        self.output = self.root / 'output'

    def test_plan_requires_catalog_exact_map_link_and_uses_event_revision(self):
        source_dir = self.root / 'source'
        csv_path = source_dir / legacy.OLD_CSV
        csv_path.parent.mkdir(parents=True)
        csv_path.write_bytes(b'frozen historical map discovery csv\n')
        csv_hash = legacy.sha(csv_path.read_bytes())
        source_url = 'https://raw.githubusercontent.com/example/revision/historic_games_list.csv'
        lock_path = self.root / 'source.lock.json'
        write_json(lock_path, {'files': {legacy.OLD_CSV: {
            'url': source_url, 'bytes': csv_path.stat().st_size, 'sha256': csv_hash}}})
        record = {'source_url': MAP_URL, 'metadata': {'event_raw': 'IEM Katowice 2022',
                                                      'teams_display': ['Liquid', 'FaZe']},
                  'review_status': 'unreviewed', 'structure_status': 'structurally_complete',
                  'record_sha256': 'a' * 64,
                  'stat_groups': [{'names_raw': ['jks', 'rain', 'broky', 'Twistzz', 'karrigan']}]}
        db_path = self.root / 'staging.sqlite3'
        with sqlite3.connect(db_path) as db:
            db.execute('CREATE TABLE maps (map_id INTEGER, source_url TEXT, record_json TEXT)')
            db.execute('INSERT INTO maps VALUES (?,?,?)',
                       (134047, MAP_URL, json.dumps(record)))
        catalog_dir = self.root / 'catalog'
        catalog_dir.mkdir()
        catalog = {'map_id': 134047, 'event_name': self.selection['event_name'],
                   'event_raw': self.selection['hltv_event_name'], 'event_url': EVENT_URL,
                   'source_page_url': EVENT_URL, 'source_revision_sha256': 'b' * 64,
                   'hltv_map_url': MAP_URL, 'hltv_series_id': 2354380,
                   'record_sha256': 'a' * 64, 'tier': 'S-Tier',
                   'scope_review_state': 'candidate_exact_map_link',
                   'match_evidence': 'Match/Map.stats'}
        queue_path = catalog_dir / 'exact-map-queue.jsonl'
        queue_path.write_text(json.dumps(catalog) + '\n')
        write_json(catalog_dir / 'manifest.json', {
            'files': {'exact-map-queue.jsonl': legacy.file_record(queue_path.read_bytes())},
            'inputs': {'cached_event_pages': {EVENT_URL: 'b' * 64}}})
        with patch.object(legacy, 'read_old_staging', return_value=(db_path, 'frozen')):
            report = legacy.make_plan(self.selection_path, source_dir, self.output,
                                      source_lock_path=lock_path, catalog_dir=catalog_dir)
        self.assertEqual(report['maps'], 1)
        self.assertEqual(report['exact_map_queue_sha256'], legacy.sha(queue_path.read_bytes()))
        plan = json.loads((self.output / 'plan/selected-series.jsonl').read_text())
        self.assertEqual(plan['source_page_url'], EVENT_URL)
        self.assertEqual(plan['source_revision_sha256'], 'b' * 64)
        self.assertNotEqual(plan['source_revision_sha256'], csv_hash)
        self.assertEqual((self.output / 'plan/correction-ledger.jsonl').read_bytes(), b'')
        catalog['hltv_map_url'] = MAP_URL.replace('liquid-vs-faze', 'wrong-page')
        queue_path.write_text(json.dumps(catalog) + '\n')
        manifest_path = catalog_dir / 'manifest.json'
        manifest = json.loads(manifest_path.read_text())
        manifest['files']['exact-map-queue.jsonl'] = legacy.file_record(queue_path.read_bytes())
        write_json(manifest_path, manifest)
        with patch.object(legacy, 'read_old_staging', return_value=(db_path, 'frozen')):
            with self.assertRaisesRegex(ValueError, 'Exact-map event catalog disagrees'):
                legacy.make_plan(self.selection_path, source_dir, self.output,
                                 source_lock_path=lock_path, catalog_dir=catalog_dir)

    def test_capture_numeric_ids_override_old_nicknames(self):
        plan = {'selected_mapstatsid': 134047, 'hltv_map_url': MAP_URL,
                'hltv_series_id': 2354380, 'hltv_series_url': SERIES_URL,
                'event_url': EVENT_URL, 'event_name': 'Intel Extreme Masters XVI - Katowice',
                'tier': 'S-Tier', 'source_revision_sha256': 'b' * 64,
                'eligible_for_questions': False}
        plan_path = self.output / 'plan/selected-series.jsonl'
        plan_path.parent.mkdir(parents=True)
        plan_path.write_text(json.dumps(plan) + '\n')
        ledger_path = self.output / 'plan/correction-ledger.jsonl'
        ledger_path.write_bytes(b'')
        write_json(self.output / 'plan/manifest.json', {
            'schema_version': 1,
            'inputs': {'correction_ledger_sha256': legacy.sha(b'')},
            'files': {'selected-series.jsonl': legacy.file_record(plan_path.read_bytes()),
                      'correction-ledger.jsonl': legacy.file_record(b'')}})
        rows = []
        for team, opponent, ids, score, other in (
                ('FaZe', 'Liquid', FAZE_IDS, 11, 16),
                ('Liquid', 'FaZe', ['100', '101', '102', '103', '104'], 16, 11)):
            for player_id in ids:
                nickname = 'jks' if player_id == '4679' else f'p{player_id}'
                rows.append({'matchStatsId': '134047', 'playerId': player_id,
                             'playerName': nickname, 'team': team,
                             'url': f'https://www.hltv.org/stats/players/{player_id}/{nickname}',
                             'details': {'event': 'IEM Katowice 2022',
                                         'dateTime': '2022-02-17 21:15', 'map': 'Mirage',
                                         'opponent': opponent, 'teamScore': score,
                                         'opponentScore': other}})
        capture = {'source_url': MAP_URL, 'rows': rows, 'event_url': EVENT_URL,
                   'hltv_series_id_from_liquipedia': 2354380,
                   'source_revision_sha256': 'b' * 64,
                   'eligible_for_questions': False}
        capture_path = self.output / 'captures/134047.json'
        write_json(capture_path, capture)
        result = legacy.verify_captures(self.selection_path, self.output)
        self.assertEqual(len(result), 1)
        self.assertEqual({p['source_player_id'] for p in result[0]['team']['players']},
                         set(FAZE_IDS))
        self.assertFalse(result[0]['eligible_for_questions'])
        capture['rows'][0]['playerId'] = '999'
        capture['rows'][0]['url'] = 'https://www.hltv.org/stats/players/999/jks'
        write_json(capture_path, capture)
        with self.assertRaisesRegex(ValueError, 'Numeric roster differs'):
            legacy.verify_captures(self.selection_path, self.output)


if __name__ == '__main__':
    unittest.main()
