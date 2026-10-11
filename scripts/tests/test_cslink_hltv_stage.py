import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cslink_hltv_stage import stage


class HltvStageTests(unittest.TestCase):
    def test_numeric_ids_keep_niko_and_niko_distinct_and_no_cross_team_edge(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            captures = root / 'captures'
            captures.mkdir()
            plan = root / 'plan.jsonl'
            plan.write_text(json.dumps({'selected_mapstatsid': 123, 'hltv_series_id': 456,
                                        'event_url': 'https://example.com/event',
                                        'event_name': 'Sample Event'}) + '\n')
            rows = []
            for team_index, (team, opponent, score, other) in enumerate(
                    [('Alpha', 'Beta', 13, 9), ('Beta', 'Alpha', 9, 13)]):
                for index in range(5):
                    player_id = str(100 + team_index * 5 + index)
                    name = f'p{player_id}'
                    if team_index == 0 and index == 0:
                        player_id, name = '3741', 'NiKo'
                    elif team_index == 1 and index == 0:
                        player_id, name = '10264', 'niko'
                    rows.append({'matchStatsId': '123', 'playerId': player_id,
                                 'playerName': name, 'team': team,
                                 'url': f'https://www.hltv.org/stats/players/{player_id}/{name.lower()}',
                                 'details': {'event': 'Sample Event', 'dateTime': '2025-01-01 10:00',
                                             'map': 'Mirage', 'opponent': opponent,
                                             'teamScore': score, 'opponentScore': other}})
            (captures / '123.json').write_text(json.dumps({
                'source_url': 'https://www.hltv.org/stats/matches/mapstatsid/123/-', 'rows': rows}))
            output = root / 'stage'
            report = stage(plan, captures, output)
            self.assertEqual(report['captured_valid_maps'], 1)
            self.assertEqual(report['candidate_teammate_pairs'], 20)
            players = [json.loads(line) for line in (output / 'players.jsonl').read_text().splitlines()]
            self.assertIn('3741', [row['hltv_player_id'] for row in players])
            self.assertIn('10264', [row['hltv_player_id'] for row in players])
            edges = [json.loads(line) for line in (output / 'candidate-edges.jsonl').read_text().splitlines()]
            self.assertNotIn(['3741', '10264'], [row['hltv_player_ids'] for row in edges])
            self.assertTrue(all(not row['eligible_for_questions'] for row in edges))

            corrected_plan = {'selected_mapstatsid': 123, 'hltv_series_id': 456,
                              'event_url': 'https://example.com/event',
                              'event_name': 'Sample Event',
                              'hltv_map_url': 'https://www.hltv.org/stats/matches/mapstatsid/123/verified'}
            plan.write_text(json.dumps(corrected_plan) + '\n')
            rejected = stage(plan, captures, output)
            self.assertEqual(rejected['invalid_captures'], 1)
            self.assertEqual(rejected['captured_valid_maps'], 0)


if __name__ == '__main__':
    unittest.main()
