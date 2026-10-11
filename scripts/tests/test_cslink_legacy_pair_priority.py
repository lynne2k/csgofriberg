import sys
from pathlib import Path
import unittest
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cslink_legacy_pair_priority as priority


class LegacyPairPriorityTests(unittest.TestCase):
    def test_nickname_case_and_ambiguity_are_kept_separate(self):
        names = {'NiKo': {'3741'}, 'niko': {'10264'}, 'rain': {'8183', '24963'},
                 'a': {'1'}, 'b': {'2'}}
        found = priority.resolve_group(['NiKo', 'niko', 'rain', 'a', 'b'], 'event', {}, names)
        self.assertEqual(found['status'], 'unresolved_names')
        self.assertEqual(found['ids'][:2], ['3741', '10264'])
        self.assertEqual(found['ambiguous'], {'rain': ['8183', '24963']})
        self.assertNotEqual(priority.pair('3741', '1'), priority.pair('10264', '1'))

    def test_same_event_exact_five_overrides_global_name_collision_only_there(self):
        roster = ('NiKo', 'a', 'b', 'c', 'd')
        mapping = tuple(sorted(zip(roster, ('3741', '1', '2', '3', '4'))))
        anchors = {('event-A', tuple(sorted(roster))): {mapping: {100}}}
        global_names = {'NiKo': {'3741', '10264'}, 'a': {'1'}, 'b': {'2'},
                        'c': {'3'}, 'd': {'4'}}
        same = priority.resolve_group(list(roster), 'event-A', anchors, global_names)
        other = priority.resolve_group(list(roster), 'event-B', anchors, global_names)
        self.assertEqual(same['status'], 'same_event_exact_five')
        self.assertEqual(same['ids'][0], '3741')
        self.assertEqual(same['anchor_map_ids'], [100])
        self.assertEqual(other['status'], 'unresolved_names')

    def test_conflicting_same_event_rosters_are_not_resolved(self):
        roster = tuple(sorted(('x', 'a', 'b', 'c', 'd')))
        first = tuple(sorted(zip(roster, ('1', '2', '3', '4', '5'))))
        second = tuple(sorted(zip(roster, ('6', '2', '3', '4', '5'))))
        result = priority.resolve_group(list(roster), 'event',
                                        {('event', roster): {first: {1}, second: {2}}}, {})
        self.assertEqual(result['status'], 'conflicting_same_event_anchors')

    def test_pair_novelty_uses_only_same_team_numeric_ids(self):
        row = {'map_id': 42, 'hltv_map_url': 'https://www.hltv.org/map/42',
               'event_url': 'event', 'date_raw': '2022-01-01', 'tier': 'A-Tier'}
        groups = {1: ['a', 'b', 'c', 'd', 'e'], 2: ['f', 'g', 'h', 'i', 'j']}
        names = {n: {str(i)} for i, n in enumerate('abcdefghij', 1)}
        baseline = priority.team_pairs(['1', '2', '3', '4', '5'])
        result, novel = priority.classify_map(row, groups, {}, names, baseline)
        self.assertEqual(result['status'], 'full_ten_name_hypothesis')
        self.assertEqual(result['existing_known_pair_count'], 10)
        self.assertEqual(len(novel), 10)
        self.assertNotIn(priority.pair('1', '6'), novel)

    def test_greedy_chooses_marginal_coverage_and_deterministic_ties(self):
        ranked, covered = priority.greedy_rank({10: {(1, 2), (2, 3)},
                                                20: {(2, 3), (3, 4)},
                                                30: {(5, 6)}})
        self.assertEqual(ranked, [(10, 2, 2), (20, 1, 2), (30, 1, 1)])
        self.assertEqual(len(covered), 4)

    def test_lp_score_name_and_unique_map_are_required(self):
        row = {'map_id': 42, 'hltv_series_id': 1, 'hltv_map_url': 'source',
               'record_sha256': 'record', 'source_page_url': 'page',
               'event_url': 'page', 'source_revision_sha256': 'revision',
               'liquipedia_match_date': '2022-01-01'}
        old = {'source_url': 'source', 'record_sha256': 'record',
               'map_raw': 'inf', 'score': [16, 9]}
        proof = {'match_date': '2022-01-01', 'map_name': 'Inferno',
                 'map_scores': [9, 16]}
        with patch.object(priority, 'source_match_proof', return_value=proof):
            self.assertIsNone(priority.audit_single_map_source(
                row, old, {'page': ('wiki', 'revision')}))
            self.assertEqual(priority.audit_single_map_source(
                row, {**old, 'map_raw': 'mrg'}, {'page': ('wiki', 'revision')}),
                'liquipedia_map_name_disagrees_with_old_map')
            self.assertEqual(priority.audit_single_map_source(
                row, {**old, 'score': [16, 10]}, {'page': ('wiki', 'revision')}),
                'liquipedia_score_disagrees_with_old_map')
        with patch.object(priority, 'source_match_proof', side_effect=ValueError('two maps')):
            self.assertEqual(priority.audit_single_map_source(
                row, old, {'page': ('wiki', 'revision')}),
                'liquipedia_map_proof_nonunique_or_incomplete')


if __name__ == '__main__':
    unittest.main()
