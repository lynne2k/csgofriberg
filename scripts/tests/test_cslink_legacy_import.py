import sys
from collections import defaultdict
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cslink_legacy_import as legacy


class LegacyImportTests(unittest.TestCase):
    def setUp(self):
        self.row = {'map_id': 42, 'structure_status': 'structurally_complete',
                    'hltv_map_url': 'https://www.hltv.org/stats/matches/mapstatsid/42/a-vs-b',
                    'record_sha256': 'a' * 64, 'event_url': 'https://liquipedia.net/counterstrike/E',
                    'event_name': 'Event', 'tier': 'S-Tier'}
        self.metadata = {'source_url': self.row['hltv_map_url'], 'record_sha256': 'a' * 64,
                         'teams_display': ['A', 'B'], 'score': [16, 9],
                         'date_raw': '2022-01-01', 'map_raw': 'inf'}
        self.groups = {1: list('abcde'), 2: list('fghij')}
        self.names = {name: {str(index)} for index, name in enumerate('abcdefghij', 1)}

    def make_map(self, **kwargs):
        return legacy.import_map(kwargs.get('row', self.row), kwargs.get('metadata', self.metadata),
                                 kwargs.get('groups', self.groups), kwargs.get('anchors', {}),
                                 kwargs.get('names', self.names), kwargs.get('warnings', ()),
                                 kwargs.get('roster_index'))

    def test_duplicate_relationships_keep_multiple_source_links(self):
        first, _ = self.make_map()
        row = {**self.row, 'map_id': 43,
               'hltv_map_url': 'https://www.hltv.org/stats/matches/mapstatsid/43/a-vs-b'}
        second, _ = self.make_map(row=row, metadata={**self.metadata, 'source_url': row['hltv_map_url']})
        self.assertEqual(len(legacy.relation_pairs(first['groups']) | legacy.relation_pairs(second['groups'])), 20)
        self.assertNotEqual(first['sourceUrl'], second['sourceUrl'])
        self.assertEqual(first['sourceUrl'], self.row['hltv_map_url'])
        self.assertEqual(first['sourceFingerprint'], 'a' * 64)

    def test_niko_case_stays_distinct(self):
        people, appearances = legacy.resolve_group(['NiKo', 'niko', 'a', 'b', 'c'], 'event', {},
            {**self.names, 'NiKo': {'3741'}, 'niko': {'10264'}})
        self.assertEqual([p['id'] for p in people[:2]], ['hltv:3741', 'hltv:10264'])
        self.assertNotEqual(appearances[0]['playerId'], appearances[1]['playerId'])

    def test_ambiguous_name_is_scoped_unless_same_event_roster_is_anchored(self):
        names = {**self.names, 'a': {'1', '101'}}
        old, _ = self.make_map(names=names)
        self.assertTrue(old['groups'][0][0]['playerId'].startswith('legacy:'))
        signature = ('a', 'b', 'c', 'd', 'e')
        mapping = tuple(zip(signature, ['101', '2', '3', '4', '5']))
        anchors = {(self.row['event_url'], signature): {mapping: {5}}}
        anchored, _ = self.make_map(names=names, anchors=anchors)
        self.assertEqual(anchored['groups'][0][0]['playerId'], 'hltv:101')
        elsewhere, _ = self.make_map(names=names, anchors=anchors,
                                    row={**self.row, 'event_url': 'different-event'})
        self.assertNotEqual(elsewhere['groups'][0][0]['playerId'], old['groups'][0][0]['playerId'])

    def test_unknown_scoped_id_stable_for_reordering_but_not_event_or_roster(self):
        names = {n: ids for n, ids in self.names.items() if n != 'a'}
        first, _ = self.make_map(names=names)
        reversed_groups = {1: list(reversed(self.groups[1])), 2: self.groups[2]}
        reordered, _ = self.make_map(names=names, groups=reversed_groups)
        self.assertEqual(first['groups'][0][0]['playerId'], reordered['groups'][0][-1]['playerId'])
        self.assertEqual(first['groups'][0][0]['identityBasis'], 'legacy_context_unmapped_nickname')
        other, _ = self.make_map(names=names, row={**self.row, 'event_url': 'other'})
        self.assertNotEqual(first['groups'][0][0]['playerId'], other['groups'][0][0]['playerId'])
        changed, _ = self.make_map(names=names, groups={1: list('abcdy'), 2: self.groups[2]})
        self.assertNotEqual(first['groups'][0][0]['playerId'], changed['groups'][0][0]['playerId'])
        self.assertIn(('hltv:2', 'hltv:3'), legacy.relation_pairs(first['groups']))

    def test_reversing_team_labels_does_not_change_same_group_relations(self):
        first, _ = self.make_map()
        second, _ = self.make_map(metadata={**self.metadata, 'teams_display': ['B', 'A'], 'score': [9, 16]})
        self.assertEqual(first['groups'], second['groups'])
        self.assertEqual(legacy.relation_pairs(first['groups']), legacy.relation_pairs(second['groups']))
        self.assertNotIn(('hltv:1', 'hltv:6'), legacy.relation_pairs(first['groups']))

    def test_same_numeric_identity_twice_is_quarantined(self):
        # Same ID twice inside one group drops only that group.
        game_map, people = self.make_map(names={**self.names, 'b': {'1'}})
        self.assertEqual(len(game_map['groups']), 1)
        self.assertEqual(game_map['droppedGroups'][0]['reason'], 'duplicate_candidate_ids')
        self.assertEqual({p['nickname'] for p in people}, set('fghij'))
        # Same ID on both sides without an anchor: split that person into roster-scoped IDs.
        game_map, people = self.make_map(names={**self.names, 'f': {'1'}})
        self.assertEqual(len({p['id'] for p in people}), 10)
        self.assertEqual(game_map['groups'][0][0]['identityBasis'], 'legacy_context_cross_team_identity_split')
        self.assertEqual(game_map['groups'][1][0]['identityBasis'], 'legacy_context_cross_team_identity_split')
        with self.assertRaisesRegex(ValueError, 'no_usable_five_player_group'):
            self.make_map(names={**self.names, 'b': {'1'}, 'g': {'6'}})

    def test_bad_source_and_incomplete_or_duplicate_groups_are_quarantined(self):
        with self.assertRaisesRegex(ValueError, 'frozen_old_record_mismatch'):
            self.make_map(metadata={**self.metadata, 'source_url': 'other'})
        with self.assertRaisesRegex(ValueError, 'invalid_hltv_map_url'):
            url = 'https://example.com/42'
            self.make_map(row={**self.row, 'hltv_map_url': url}, metadata={**self.metadata, 'source_url': url})
        with self.assertRaisesRegex(ValueError, 'no_old_roster_rows'):
            self.make_map(groups={})
        for bad, reason in [(list('abcd'), 'group_missing_players'), (list('abbde'), 'group_duplicate_nickname'),
                            (list('abcdez'), 'group_more_than_five_players')]:
            game_map, people = self.make_map(groups={1: bad, 2: list('fghij')})
            self.assertEqual(game_map['droppedGroups'], [{'groupNo': 1, 'reason': reason, 'nicknames': bad}])
            self.assertEqual([[a['nickname'] for a in g] for g in game_map['groups']], [list('fghij')])
            self.assertEqual(len(legacy.relation_pairs(game_map['groups'])), 10)
        with self.assertRaisesRegex(ValueError, 'no_usable_five_player_group'):
            self.make_map(groups={1: list('abcd'), 2: list('fghijk')})

    def test_source_warnings_are_kept_on_imported_map(self):
        game_map, _ = self.make_map(warnings=['liquipedia_score_disagrees_with_old_map'])
        self.assertEqual(game_map['sourceWarnings'], ['liquipedia_score_disagrees_with_old_map'])
        self.assertEqual(len(game_map['groups']), 2)

    def test_cross_team_duplicate_nickname_keeps_corroborated_side(self):
        groups = {1: ['steel', 'b', 'c', 'd', 'e'], 2: ['steel', 'g', 'h', 'i', 'j']}
        names = {**self.names, 'steel': {'7253'}}
        event = self.row['event_url']
        index = legacy.catalog_roster_index(
            [{'map_id': 42, 'event_url': event}, {'map_id': 50, 'event_url': event}],
            {42: groups, 50: {1: groups[1], 2: list('vwxyz')}})
        game_map, people = self.make_map(groups=groups, names=names, roster_index=index)
        self.assertEqual([[a['nickname'] for a in g] for g in game_map['groups']], [groups[1]])
        self.assertEqual(game_map['droppedGroups'][0]['reason'], 'cross_team_duplicate_uncorroborated_roster')
        self.assertEqual(game_map['droppedGroups'][0]['otherGroupSupportMapIds'], [50])
        # Neither side corroborated: both kept, the shared person is split per roster.
        game_map, people = self.make_map(groups=groups, names=names)
        self.assertEqual(len(game_map['groups']), 2)
        steel = [a['playerId'] for g in game_map['groups'] for a in g if a['nickname'] == 'steel']
        self.assertEqual(len(set(steel)), 2)
        self.assertTrue(all(pid.startswith('legacy:') for pid in steel))
        # Ambiguous name: distinct scoped IDs already, so nothing is dropped even with corroboration.
        game_map, people = self.make_map(groups=groups, names={**names, 'steel': {'7253', '7382'}},
                                         roster_index=index)
        self.assertNotIn('droppedGroups', game_map)
        self.assertEqual(len(game_map['groups']), 2)
        steel = [a['playerId'] for g in game_map['groups'] for a in g if a['nickname'] == 'steel']
        self.assertEqual(len(set(steel)), 2)
        self.assertNotIn(tuple(sorted(steel)), legacy.relation_pairs(game_map['groups']))

    def test_case_variant_across_teams_is_not_a_duplicate(self):
        names = {**self.names, 'NiKo': {'3741'}, 'niko': {'10264'}}
        game_map, people = self.make_map(groups={1: ['NiKo', 'b', 'c', 'd', 'e'], 2: ['niko', 'g', 'h', 'i', 'j']},
                                         names=names)
        self.assertNotIn('droppedGroups', game_map)
        self.assertEqual([game_map['groups'][0][0]['playerId'], game_map['groups'][1][0]['playerId']],
                         ['hltv:3741', 'hltv:10264'])

    def test_conflicting_same_event_anchors_are_quarantined(self):
        signature = tuple('abcde')
        first = tuple(zip(signature, ['1', '2', '3', '4', '5']))
        second = tuple(zip(signature, ['101', '2', '3', '4', '5']))
        anchors = {(self.row['event_url'], signature): {first: {1}, second: {2}}}
        game_map, _ = self.make_map(anchors=anchors)
        self.assertEqual(game_map['droppedGroups'][0]['reason'], 'conflicting_same_event_anchors')
        self.assertEqual(len(game_map['groups']), 1)

    def learn_aliases(self, old_name='AMANEK', new_name='amanek', pid='9616', second=None):
        history_maps = {42: {'event_url': self.row['event_url']}}
        history_groups = {42: {'A': [(new_name, pid), ('b', '2'), ('c', '3'), ('d', '4'), ('e', '5')],
                              'B': [(n, str(i)) for i, n in enumerate('fghij', 6)]}}
        old_groups = {42: {1: [old_name, 'b', 'c', 'd', 'e'], 2: list('fghij')}}
        metadata = {42: self.metadata}
        if second:
            history_maps[43] = {'event_url': 'other-event'}
            history_groups[43] = {'A': [(new_name, second), ('b', '2'), ('c', '3'), ('d', '4'), ('e', '5')]}
            old_groups[43] = {1: [old_name, 'b', 'c', 'd', 'e'], 2: list('fghij')}
            metadata[43] = {**self.metadata, 'source_url': self.metadata['source_url'].replace('/42/', '/43/')}
        anchors = defaultdict(lambda: defaultdict(set))
        names = defaultdict(set, {**self.names, 'NiKo': {'3741'}, 'niko': {'10264'}})
        evidence, rejected = legacy.learn_same_map_aliases(
            history_maps, history_groups, old_groups, metadata, anchors, names)
        return evidence, rejected, anchors, names

    def test_same_map_four_exact_names_learn_alias_and_keep_url_evidence(self):
        evidence, rejected, anchors, names = self.learn_aliases()
        self.assertEqual(names['AMANEK'], {'9616'})
        self.assertEqual(evidence[0]['sourceUrl'], self.row['hltv_map_url'])
        self.assertEqual(evidence[0]['sharedNicknames'], list('bcde'))
        self.assertFalse(rejected)
        self.assertIn((self.row['event_url'], ('AMANEK', 'b', 'c', 'd', 'e')), anchors)

    def test_two_same_map_alias_ids_remain_ambiguous_globally(self):
        evidence, rejected, anchors, names = self.learn_aliases(second='999')
        self.assertEqual(names['AMANEK'], {'9616', '999'})
        self.assertEqual(len(evidence), 2)
        people, _ = legacy.resolve_group(['AMANEK', 'b', 'c', 'd', 'e'], 'unseen', anchors, names)
        self.assertEqual(people[0]['identityKind'], 'legacy_context')

    def test_niko_existing_ids_are_never_replaced_by_four_name_rule(self):
        for old_name, pid in [('NiKo', '10264'), ('niko', '3741')]:
            evidence, rejected, _, names = self.learn_aliases(old_name=old_name, pid=pid)
            self.assertFalse(evidence)
            self.assertEqual(rejected[0]['reason'], 'protected_niko_identity_conflict')
            self.assertEqual(names['NiKo'], {'3741'})
            self.assertEqual(names['niko'], {'10264'})

    def test_three_common_names_or_different_map_do_not_produce_aliases(self):
        anchors = defaultdict(lambda: defaultdict(set))
        history = {42: {'A': [('x', '1'), ('b', '2'), ('c', '3'), ('d', '4'), ('y', '5')]}}
        evidence, _ = legacy.learn_same_map_aliases(
            {42: {'event_url': 'event'}}, history, {42: self.groups}, {42: self.metadata}, anchors, {})
        self.assertEqual(evidence, [])
        history[42]['A'][-1] = ('e', '5')
        evidence, _ = legacy.learn_same_map_aliases(
            {42: {'event_url': 'event'}}, history, {43: self.groups}, {43: self.metadata}, anchors, {})
        self.assertEqual(evidence, [])


if __name__ == '__main__':
    unittest.main()
