from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cslink_roster_pilot import validate_capture


def sample():
    teams = [('Alpha', 'Beta', 13, 9), ('Beta', 'Alpha', 9, 13)]
    rows = []
    for team_index, (team, opponent, score, opponent_score) in enumerate(teams):
        for player_index in range(5):
            player_id = str(100 + team_index * 5 + player_index)
            rows.append({'matchStatsId': '123', 'playerId': player_id,
                         'playerName': f'p{player_id}', 'team': team,
                         'url': f'https://www.hltv.org/stats/players/{player_id}/p{player_id}',
                         'details': {'event': 'Sample', 'dateTime': '2025-01-01 10:00',
                                     'map': 'Mirage', 'opponent': opponent,
                                     'teamScore': score, 'opponentScore': opponent_score}})
    return {'source_url': 'https://www.hltv.org/stats/matches/mapstatsid/123/-', 'rows': rows}


class RosterPilotTests(unittest.TestCase):
    def test_valid_two_team_sample_preserves_numeric_player_ids(self):
        result = validate_capture(sample(), 123)
        self.assertEqual([len(team['players']) for team in result['teams']], [5, 5])
        self.assertEqual(result['teams'][0]['players'][0]['source_player_id'], '100')
        self.assertFalse(result['eligible_for_questions'])

    def test_duplicate_identity_and_score_conflict_are_rejected(self):
        duplicate = sample()
        duplicate['rows'][5]['playerId'] = '100'
        duplicate['rows'][5]['url'] = 'https://www.hltv.org/stats/players/100/p100'
        with self.assertRaisesRegex(ValueError, 'Duplicate player ID'):
            validate_capture(duplicate, 123)
        wrong_score = sample()
        wrong_score['rows'][5]['details']['teamScore'] = 8
        with self.assertRaisesRegex(ValueError, 'Team score'):
            validate_capture(wrong_score, 123)


if __name__ == '__main__':
    unittest.main()
