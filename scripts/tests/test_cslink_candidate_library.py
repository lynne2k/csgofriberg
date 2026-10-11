import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cslink_candidate_library import build


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def write_fixture(root, missing_provenance=False, same_series=False):
    plan_dir = root / 'plan'
    captures = root / 'captures'
    plan_dir.mkdir()
    captures.mkdir()
    plans = []
    for map_id, series_id in ((123, 456), (124, 456 if same_series else 457)):
        source_url = f'https://www.hltv.org/stats/matches/mapstatsid/{map_id}/-'
        event_url = f'https://liquipedia.net/counterstrike/Example/{map_id}'
        plan = {'selected_mapstatsid': map_id, 'hltv_series_id': series_id,
                'hltv_series_url': f'https://www.hltv.org/matches/{series_id}/-',
                'hltv_map_url': source_url, 'event_url': event_url,
                'source_page_url': event_url, 'event_name': 'Example Event',
                'event_start_date': '2025-01-01', 'tier': 'A-Tier',
                'source_revision_sha256': 'a' * 64, 'eligible_for_questions': False}
        plans.append(plan)
        rows = []
        for team_index, (team, opponent, score, other) in enumerate(
                (('Alpha', 'Beta', 13, 9), ('Beta', 'Alpha', 9, 13))):
            for index in range(5):
                player_id = str(100 + team_index * 5 + index)
                nickname = f'p{player_id}'
                if team_index == 0 and index == 0:
                    player_id, nickname = ('999', 'standin') if same_series and map_id == 124 else ('3741', 'NiKo')
                if team_index == 1 and index == 0:
                    player_id, nickname = '10264', 'niko'
                rows.append({'matchStatsId': str(map_id), 'playerId': player_id,
                             'playerName': nickname, 'team': team,
                             'url': f'https://www.hltv.org/stats/players/{player_id}/{nickname.lower()}',
                             'details': {'event': 'Example as displayed',
                                         'dateTime': '2025-01-01 10:00', 'map': 'Mirage',
                                         'opponent': opponent, 'teamScore': score,
                                         'opponentScore': other}})
        capture = {'source_url': source_url, 'rows': rows, 'eligible_for_questions': False}
        if not missing_provenance or map_id != 123:
            capture.update({'event_url': event_url, 'hltv_series_id_from_liquipedia': series_id,
                            'source_revision_sha256': 'a' * 64})
        (captures / f'{map_id}.json').write_text(json.dumps(capture))
    plan_raw = ''.join(json.dumps(row, sort_keys=True) + '\n' for row in plans).encode()
    (plan_dir / 'selected-series.jsonl').write_bytes(plan_raw)
    manifest = {'schema_version': 1, 'files': {'selected-series.jsonl': {
        'bytes': len(plan_raw), 'sha256': digest(plan_raw)}}, 'inputs': {}}
    (plan_dir / 'manifest.json').write_text(json.dumps(manifest))
    return plan_dir / 'selected-series.jsonl', captures


class CandidateLibraryTests(unittest.TestCase):
    def test_same_series_can_supply_distinct_map_lineups(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plan, captures = write_fixture(root, same_series=True)
            report = build(plan, captures, root / 'candidate', ledger_path=None)
            self.assertEqual(report['captured_valid_maps'], 2)
            with sqlite3.connect(root / 'candidate/library.sqlite3') as db:
                self.assertEqual(db.execute('SELECT COUNT(DISTINCT map_id) FROM maps WHERE series_id=456')
                                 .fetchone()[0], 2)
                self.assertEqual(db.execute('SELECT COUNT(*) FROM appearances WHERE player_id=?',
                                            ('999',)).fetchone()[0], 1)
                self.assertEqual(db.execute('SELECT COUNT(*) FROM appearances WHERE player_id=?',
                                            ('3741',)).fetchone()[0], 1)

    def test_map_level_pairs_provenance_and_manifest(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plan, captures = write_fixture(root)
            output = root / 'candidate'
            report = build(plan, captures, output, ledger_path=None)
            self.assertEqual(report['captured_valid_maps'], 2)
            self.assertEqual(report['distinct_player_ids'], 10)
            self.assertEqual(report['candidate_teammate_pairs'], 20)
            self.assertEqual(report['pair_map_evidence_records'], 40)
            self.assertEqual(report['maps_with_incomplete_capture_provenance'], 0)
            self.assertFalse(report['eligible_for_questions'])
            manifest = json.loads((output / 'manifest.json').read_text())
            db_raw = (output / 'library.sqlite3').read_bytes()
            self.assertEqual(manifest['files']['library.sqlite3'], {
                'bytes': len(db_raw), 'sha256': digest(db_raw)})
            self.assertEqual(manifest['version'], digest(db_raw)[:20])
            with sqlite3.connect(output / 'library.sqlite3') as db:
                self.assertEqual(db.execute('SELECT COUNT(*) FROM appearances').fetchone()[0], 20)
                self.assertEqual(db.execute('SELECT COUNT(*) FROM edge_evidence').fetchone()[0], 40)
                self.assertEqual(db.execute('SELECT display_name FROM players WHERE player_id=?',
                                            ('3741',)).fetchone()[0], 'NiKo')
                self.assertEqual(db.execute('SELECT display_name FROM players WHERE player_id=?',
                                            ('10264',)).fetchone()[0], 'niko')
                self.assertIsNone(db.execute('SELECT 1 FROM edges WHERE player_a=? AND player_b=?',
                                             ('3741', '10264')).fetchone())
                self.assertEqual(db.execute('SELECT evidence_count FROM edges WHERE player_a=? AND '
                                            'player_b=?', ('101', '3741')).fetchone()[0], 2)
                self.assertEqual(db.execute('SELECT event_as_displayed, source_url, capture_sha256 '
                                            'FROM maps WHERE map_id=123').fetchone(),
                                 ('Example as displayed',
                                  'https://www.hltv.org/stats/matches/mapstatsid/123/-',
                                  digest((captures / '123.json').read_bytes())))
                self.assertTrue(all(value == 0 for (value,) in db.execute(
                    'SELECT eligible_for_questions FROM edges')))

    def test_rejects_capture_conflict_without_overwriting_previous_library(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plan, captures = write_fixture(root)
            output = root / 'candidate'
            build(plan, captures, output, ledger_path=None)
            before = (output / 'manifest.json').read_bytes()
            path = captures / '123.json'
            capture = json.loads(path.read_text())
            capture['event_url'] = 'https://liquipedia.net/counterstrike/Wrong'
            path.write_text(json.dumps(capture))
            with self.assertRaisesRegex(ValueError, 'conflicts with plan'):
                build(plan, captures, output, ledger_path=None)
            self.assertEqual((output / 'manifest.json').read_bytes(), before)

    def test_marks_legacy_capture_metadata_gap(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plan, captures = write_fixture(root, missing_provenance=True)
            output = root / 'candidate'
            report = build(plan, captures, output, ledger_path=None)
            self.assertEqual(report['maps_with_incomplete_capture_provenance'], 1)
            self.assertEqual(report['capture_provenance_gaps'][0]['map_id'], 123)
            with sqlite3.connect(output / 'library.sqlite3') as db:
                self.assertEqual(db.execute('SELECT capture_provenance_status FROM maps WHERE map_id=123')
                                 .fetchone()[0], 'metadata_missing')

    def test_plan_manifest_hash_is_required(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plan, captures = write_fixture(root)
            plan.write_bytes(plan.read_bytes() + b'\n')
            with self.assertRaisesRegex(ValueError, 'differs from its manifest'):
                build(plan, captures, root / 'candidate', ledger_path=None)


if __name__ == '__main__':
    unittest.main()
