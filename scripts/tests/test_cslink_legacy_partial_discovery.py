import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cslink_legacy_partial_discovery as discovery


def partial(map_id, event, first, second, ids_first=None, ids_second=None,
            unknown=(), ambiguous=None, potential=0):
    ids_first = ids_first if ids_first is not None else [None] * 5
    ids_second = ids_second if ids_second is not None else [None] * 5
    ambiguous = ambiguous or {}
    return {
        'map_id': map_id, 'status': 'partial_identity', 'event_url': event,
        'unknown_nicknames': list(unknown), 'ambiguous_nicknames': ambiguous,
        'potential_new_pair_count': potential,
        'group_results': [
            {'group_no': 1, 'status': 'unresolved_names',
             'nicknames': first, 'ids': ids_first},
            {'group_no': 2, 'status': 'unresolved_names',
             'nicknames': second, 'ids': ids_second},
        ],
    }


class PartialDiscoveryTests(unittest.TestCase):
    def test_numeric_pair_hypotheses_never_cross_teams_or_fill_unknown_ids(self):
        row = partial(1, 'event', list('abcde'), list('fghij'),
                      ['1', '2', None, None, None], ['3', '4', None, None, None],
                      unknown=['c', 'd', 'e', 'h', 'i', 'j'], potential=1)
        item = discovery.candidate(row, {(1, 2)})
        self.assertEqual(item['pair_hypotheses'], {(3, 4)})
        self.assertNotIn((1, 3), item['pair_hypotheses'])
        self.assertEqual(len(item['signatures']), 2)
        with self.assertRaisesRegex(ValueError, 'disagree'):
            discovery.candidate({**row, 'potential_new_pair_count': 2}, {(1, 2)})

    def test_lanes_avoid_repeated_roster_and_cover_distinct_ambiguities(self):
        first = list('abcde')
        second = list('fghij')
        rows = [
            partial(1, 'event', first, second, unknown=['a', 'b']),
            partial(2, 'event', first[::-1], second[::-1], unknown=['a', 'b']),
            partial(3, 'event2', list('klmno'), list('pqrst'),
                    ambiguous={'rain': ['1', '2'], 'steel': ['3', '4']}),
            partial(4, 'event3', list('uvwxy'), list('zABCD'),
                    ambiguous={'rain': ['1', '2'], 'mds': ['5', '6']}),
        ]
        selected, covered = discovery.rank_candidates(
            [discovery.candidate(row, set()) for row in rows],
            {'unknown': 1, 'ambiguous': 2, 'known_pair': 0})
        self.assertEqual([row['map_id'] for row in selected], [1, 3, 4])
        self.assertEqual(len(covered['ambiguous_names']), 3)
        self.assertEqual(len(covered['signatures']), 6)

    def test_known_pair_lane_uses_marginal_numeric_hypotheses(self):
        ids = ['1', '2', None, None, None]
        rows = [
            partial(10, 'event1', list('abcde'), list('fghij'),
                    ids_first=ids, potential=1),
            partial(11, 'event2', list('abcde'), list('klmno'),
                    ids_first=ids, potential=1),
            partial(12, 'event3', list('pqrst'), list('uvwxy'),
                    ids_first=['3', '4', None, None, None], potential=1),
        ]
        selected, covered = discovery.rank_candidates(
            [discovery.candidate(row, set()) for row in rows],
            {'unknown': 0, 'ambiguous': 0, 'known_pair': 3})
        self.assertEqual([row['map_id'] for row in selected], [10, 12])
        self.assertEqual(len(covered['pair_hypotheses']), 2)

    def test_current_local_source_failure_aborts_before_writing_plan(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            old_db = root / 'old.sqlite3'
            sqlite3.connect(old_db).close()
            row = partial(42, 'event', list('abcde'), list('fghij'),
                          unknown=['a'])
            catalog = {'map_id': 42, 'event_url': 'event'}
            with (patch.object(discovery, 'load_frozen',
                               return_value=([row], {42: catalog}, set(), {})),
                  patch.object(discovery.priority, 'load_old_metadata',
                               return_value={42: {}}),
                  patch.object(discovery.priority, 'load_old_groups',
                               return_value={42: {1: list('abcde'), 2: list('fghij')}}),
                  patch.object(discovery.priority, 'audit_single_map_source',
                               return_value='liquipedia_score_disagrees_with_old_map')):
                with self.assertRaisesRegex(ValueError, 'Failed current local source audit'):
                    discovery.build(root, old_db_path=old_db,
                                    output_root=root / 'output', unknown=1,
                                    ambiguous=0, known_pair=0)
            self.assertFalse((root / 'output').exists())

    def test_collector_row_marks_identity_unverified(self):
        row = partial(42, 'event', list('abcde'), list('fghij'), unknown=['a'])
        catalog = {
            'map_id': 42, 'hltv_map_url': 'https://www.hltv.org/stats/matches/mapstatsid/42/-',
            'hltv_series_id': 7, 'event_url': 'event', 'event_name': 'name',
            'event_start_date': '2020-01-01', 'tier': 'A-Tier',
            'source_page_url': 'source', 'source_revision_sha256': 'sha',
            'record_sha256': 'old', 'liquipedia_match_date': '2020-01-01',
            'event_name_match_status': 'confirmed', 'event_name_match_rule': 'exact',
            'official_alias_evidence': None,
        }
        result = discovery.collector_row(catalog, row, {'lane': 'unknown', 'rank': 1})
        self.assertEqual(result['roster_status'], 'unverified')
        self.assertFalse(result['eligible_for_questions'])
        self.assertNotIn('player_id', json.dumps(result))


if __name__ == '__main__':
    unittest.main()
