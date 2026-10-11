from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cslink_event_cover import choose_cover, choose_pilot, extract_match


class EventCoverTests(unittest.TestCase):
    def test_one_series_covers_both_teams_and_all_event_teams_are_covered(self):
        matches = [
            {'hltv_series_id': 1, 'team_labels': ['a', 'b']},
            {'hltv_series_id': 2, 'team_labels': ['b', 'c']},
            {'hltv_series_id': 3, 'team_labels': ['c', 'd']},
            {'hltv_series_id': 4, 'team_labels': ['d', 'a']},
        ]
        chosen = choose_cover(matches)
        self.assertEqual(len(chosen), 2)
        self.assertEqual({team for match in matches if match['hltv_series_id'] in chosen
                          for team in match['team_labels']}, {'a', 'b', 'c', 'd'})
        self.assertEqual(chosen, choose_cover(list(reversed(matches))))

    def test_odd_and_disconnected_groups_are_not_lost(self):
        matches = [
            {'hltv_series_id': 1, 'team_labels': ['a', 'b']},
            {'hltv_series_id': 2, 'team_labels': ['a', 'c']},
            {'hltv_series_id': 3, 'team_labels': ['b', 'c']},
            {'hltv_series_id': 4, 'team_labels': ['d', 'e']},
        ]
        chosen = choose_cover(matches)
        self.assertEqual(len(chosen), 3)
        self.assertIn(4, chosen)
        self.assertEqual({team for match in matches if match['hltv_series_id'] in chosen
                          for team in match['team_labels']}, {'a', 'b', 'c', 'd', 'e'})

    def test_only_frozen_map_with_matching_series_and_revision_is_selected(self):
        block = ('{{Match|opponent1={{TeamOpponent|FaZe}}|opponent2={{TeamOpponent|faze}}'
                 '|hltv=1234567|map1={{Map|stats=111}}|map2={{Map|stats=222}}}}')
        allowed = {
            111: {'event_url': 'event', 'hltv_series_id': 1234567,
                  'source_page_url': 'page', 'source_revision_sha256': 'sha'},
            222: {'event_url': 'event', 'hltv_series_id': 7654321,
                  'source_page_url': 'page', 'source_revision_sha256': 'sha'},
        }
        # Team labels are not player identities; case-folding these team codes is safe.
        match = extract_match(block, allowed, 'event', 'page', 'sha')
        self.assertIsNone(match)  # Same raw team code after case-folding is invalid.
        block = block.replace('TeamOpponent|faze', 'TeamOpponent|g2')
        match = extract_match(block, allowed, 'event', 'page', 'sha')
        self.assertEqual(match['mapstatsids'], [111])
        self.assertEqual(match['team_labels'], ['faze', 'g2'])
        with self.assertRaisesRegex(ValueError, 'Source mismatch'):
            extract_match(block, allowed, 'event', 'page', 'changed')

    def test_pilot_spreads_across_year_tier_and_distinct_events(self):
        rows = []
        for year in ('2024', '2025'):
            for event_index in range(6):
                for series_index in range(2):
                    rows.append({'event_start_date': f'{year}-01-{event_index + 1:02d}',
                                 'tier': 'S-Tier', 'event_url': f'{year}/event-{event_index}',
                                 'hltv_series_id': int(year) * 100 + event_index * 2 + series_index})
        pilot = choose_pilot(rows)
        self.assertEqual(len(pilot), 6)
        self.assertEqual(len({row['event_url'] for row in pilot}), 6)
        self.assertEqual({row['event_start_date'][:4] for row in pilot}, {'2024', '2025'})


if __name__ == '__main__':
    unittest.main()
