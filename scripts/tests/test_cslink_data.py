"""Data-integrity regressions; fixtures are synthetic, never production evidence."""
import csv
import copy
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

MODULE = Path(__file__).resolve().parents[1] / 'cslink_data.py'
spec = importlib.util.spec_from_file_location('cslink_data', MODULE)
pipeline = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pipeline)


def history(map_id=1, **overrides):
    return {'date_unix_iso': '2020-01-01 12:00:00', 'team1': ' Team A ', 'team2': 'Team B',
            'team1_rounds': '(16)', 'team2_rounds': '(4)', 'map_name_short': 'inf',
            'event_name': 'Synthetic fixture', 'game_link': f'/stats/matches/mapstatsid/{map_id}/a-vs-b', **overrides}


def detail(map_id=1, **overrides):
    names = ['NiKo', 'A', 'B', 'C', 'D', 'niko', 'E', 'F', 'G', 'H']
    return {'Unnamed: 0': '0', 'collected_timestamp': '2023-01-01',
            'game_link': f'/stats/matches/mapstatsid/{map_id}/a-vs-b',
            'team1_half1_t': '11', 'team1_half2_ct': '5', 'team2_half1_ct': '4',
            'team1_half2_t': '0', 'team2_half2_t': '',
            **dict(zip(pipeline.NAMES, names)), **overrides}


def registry():
    names = ['NiKo', 'A', 'B', 'C', 'D', 'niko', 'E', 'F', 'G', 'H']
    return {'players': [{'player_id': f'person-{i}', 'nickname': name,
                         'external_ids': {'fixture': str(i)}, 'evidence_urls': ['https://example.com/identity']}
                        for i, name in enumerate(names)], 'distinct_player_pairs': [['person-0', 'person-5']]}


def csv_file(path, rows, fields=None):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('w', newline='') as f:
        writer = csv.DictWriter(f, fieldnames=fields or list(rows[0]))
        writer.writeheader()
        writer.writerows(rows)


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.sources = self.root / 'source'
        h = history()
        legacy = {k: v for k, v in h.items() if k not in {'game_link', 'date_unix_iso'}}
        legacy.update({'datetime': h['date_unix_iso'], **{k: detail()[k] for k in pipeline.NAMES}})
        csv_file(self.sources / pipeline.HISTORY, [h, h, history(2)])
        csv_file(self.sources / pipeline.DETAILS, [detail(), detail(collected_timestamp='2023-01-02')])
        csv_file(self.sources / pipeline.LEGACY, [legacy])
        csv_file(self.sources / pipeline.EXCEPTIONS, [{'game_link': history(2)['game_link']}])
        self.lock = {'revision': 'synthetic', 'rights_status': 'unconfirmed', 'files': {}}
        self.refresh_lock()

    def tearDown(self):
        self.temp.cleanup()

    def refresh_lock(self):
        for name in pipeline.REQUIRED:
            path = self.sources / name
            self.lock['files'][name] = {'bytes': path.stat().st_size, 'sha256': pipeline.file_hash(path)}

    def records(self):
        hs, _ = pipeline.group_source(self.sources, pipeline.HISTORY, ['game_link'])
        ds, _ = pipeline.group_source(self.sources, pipeline.DETAILS, pipeline.NAMES)
        return pipeline.make_record(1, hs[1], ds[1])

    def approval(self, record):
        return {'map_id': 1, 'record_sha256': record['record_sha256'], 'decision': 'verify',
                'reason': 'Synthetic fixture proof', 'evidence_urls': ['https://example.com/match'],
                'actual_map_played': True, 'competition_type': 'official',
                'group_team_indices': [0, 1],
                'player_ids': [[f'person-{i}' for i in range(5)], [f'person-{i}' for i in range(5, 10)]]}

    def observed_approval(self, record):
        people = registry()
        for i, person in enumerate(people['players']):
            person['external_ids'] = {'hltv': str(9000000+i)}
        review = self.approval(record)
        review['evidence_urls'] = [record['source_url']]
        review['evidence_schema_version'] = 2
        review['observed_groups'] = [
            {'metadata_team_name': record['metadata']['teams_display'][g],
             'observed_team_name': record['metadata']['teams_display'][g],
             'players': [{'nickname': record['stat_groups'][g]['names_raw'][s],
                          'hltv_id': str(9000000 + g*5+s),
                          'profile_url': f'https://www.hltv.org/stats/players/{9000000+g*5+s}/fixture'}
                         for s in range(5)]} for g in range(2)]
        return review, people

    def test_niko_case_collision_never_becomes_identity(self):
        path, report = pipeline.build(self.sources, self.root / 'versions', self.lock, registry(), {'maps': []})
        with sqlite3.connect(path / 'staging.sqlite3') as db:
            rows = db.execute("SELECT nickname_raw,player_id FROM appearances WHERE search_key='niko' ORDER BY nickname_raw COLLATE BINARY").fetchall()
            self.assertEqual(rows, [('NiKo', None), ('niko', None)])
            self.assertEqual(db.execute('SELECT count(*) FROM teammate_evidence').fetchone()[0], 0)
        self.assertEqual(report['registered_people'], 10)
        self.assertEqual(report['flag_counts']['cross_group_nickname_collision'], 1)
        self.assertEqual(report['counts']['eligible_for_questions'], 0)

    def test_repeated_ingestion_is_byte_reproducible(self):
        first, _ = pipeline.build(self.sources, self.root / 'versions', self.lock, registry(), {'maps': []})
        snapshot = (first / 'manifest.json').read_bytes()
        second, _ = pipeline.build(self.sources, self.root / 'versions', self.lock, registry(), {'maps': []})
        self.assertEqual(first, second)
        self.assertEqual(snapshot, (second / 'manifest.json').read_bytes())

    def test_duplicate_details_deduplicate_but_keep_both_refs(self):
        rec = self.records()
        self.assertEqual(len(rec['source_refs']['details']), 2)
        self.assertEqual(len(rec['stat_groups']), 2)
        self.assertNotIn('details_conflict', rec['flags'])

    def test_changed_detail_is_quarantined_not_last_write_wins(self):
        csv_file(self.sources / pipeline.DETAILS, [detail(), detail(team1_p1_name='Someone else')])
        rec = self.records()
        self.assertEqual(rec['structure_status'], 'quarantined')
        self.assertEqual(rec['stat_groups'], [])
        self.assertEqual(len(rec['conflicting_variants']['details']), 2)

    def test_missing_name_is_not_filled_or_inferred(self):
        csv_file(self.sources / pipeline.DETAILS, [detail(team1_p1_name='')])
        rec = self.records()
        self.assertEqual(rec['stat_groups'][0]['names_raw'][0], '')
        self.assertIn('missing_nickname', rec['flags'])

    def test_reversed_score_does_not_swap_groups(self):
        csv_file(self.sources / pipeline.HISTORY, [history(team1_rounds='4', team2_rounds='16')])
        rec = self.records()
        self.assertEqual(rec['score_diagnostic']['status'], 'reversed_order_candidate')
        self.assertEqual(rec['stat_groups'][0]['names_raw'][0], 'NiKo')
        self.assertIsNone(rec['stat_groups'][0]['named_team_index'])

    def test_overtime_is_not_treated_as_swap_proof(self):
        diag = pipeline.score_diagnostic(history(team1_rounds='19', team2_rounds='17'), detail())
        self.assertEqual(diag['status'], 'not_comparable')

    def test_conflicting_second_half_columns_remain_unresolved(self):
        diag = pipeline.score_diagnostic(history(), detail(team2_half2_t='1.0'))
        self.assertEqual(diag['status'], 'second_half_schema_conflict')

    def test_missing_details_stays_in_inventory_and_exception_count(self):
        _, report = pipeline.build(self.sources, self.root / 'versions', self.lock, registry(), {'maps': []})
        self.assertEqual(report['maps'], 2)
        self.assertEqual(report['flag_counts']['missing_details'], 1)
        self.assertEqual(report['counts']['missing_details_in_exception_log'], 1)

    def test_source_mutation_is_detected_before_build(self):
        with (self.sources / pipeline.DETAILS).open('a') as f:
            f.write('\n')
        with self.assertRaisesRegex(ValueError, 'checksum'):
            pipeline.build(self.sources, self.root / 'versions', self.lock, registry(), {'maps': []})

    def test_review_cannot_survive_changed_record(self):
        rec = self.records()
        review = self.approval(rec)
        review['record_sha256'] = 'stale'
        with self.assertRaisesRegex(ValueError, 'Stale review'):
            pipeline.apply_review(rec, review, pipeline.validate_players(registry()))

    def test_approved_map_has_twenty_pairs_but_opponents_never_pair(self):
        review = self.approval(self.records())
        path, report = pipeline.build(self.sources, self.root / 'versions', self.lock, registry(), {'maps': [review]})
        self.assertEqual(report['verified_teammate_edges'], 20)
        self.assertFalse(report['release_ready'])  # Rights remain unconfirmed.
        with sqlite3.connect(path / 'staging.sqlite3') as db:
            self.assertEqual(db.execute("SELECT player_id FROM appearances WHERE nickname_raw='NiKo'").fetchone()[0], 'person-0')
            self.assertEqual(db.execute("SELECT player_id FROM appearances WHERE nickname_raw='niko'").fetchone()[0], 'person-5')
            self.assertEqual(db.execute("SELECT count(*) FROM teammate_evidence WHERE player_a='person-0' AND player_b='person-5'").fetchone()[0], 0)

    def test_same_person_in_two_slots_is_rejected(self):
        rec = self.records()
        review = self.approval(rec)
        review['player_ids'][1][0] = 'person-0'
        with self.assertRaisesRegex(ValueError, 'repeated player identity'):
            pipeline.apply_review(rec, review, pipeline.validate_players(registry()))

    def test_identity_registry_rejects_reused_external_id(self):
        people = registry()
        people['players'][5]['external_ids'] = people['players'][0]['external_ids']
        with self.assertRaisesRegex(ValueError, 'External identity'):
            pipeline.validate_players(people)

    def test_legacy_ambiguity_can_be_resolved_by_original_roster(self):
        csv_file(self.sources / pipeline.DETAILS, [detail(), detail(2, team1_p1_name='Other')])
        hs, _ = pipeline.group_source(self.sources, pipeline.HISTORY, ['game_link'])
        ds, _ = pipeline.group_source(self.sources, pipeline.DETAILS, pipeline.NAMES)
        result = pipeline.reconcile_legacy(self.sources, hs, ds)
        self.assertEqual(result['previously_ambiguous_cases'][0]['roster_matched_candidates'], [1])

    def test_legacy_indistinguishable_records_stay_ambiguous(self):
        csv_file(self.sources / pipeline.DETAILS, [detail(), detail(2)])
        hs, _ = pipeline.group_source(self.sources, pipeline.HISTORY, ['game_link'])
        ds, _ = pipeline.group_source(self.sources, pipeline.DETAILS, pipeline.NAMES)
        result = pipeline.reconcile_legacy(self.sources, hs, ds)
        self.assertEqual(result['counts']['unresolved'], 1)

    def test_unexpected_url_is_rejected(self):
        with self.assertRaises(ValueError):
            pipeline.source_map('https://example.com/stats/matches/mapstatsid/1/a-vs-b')
        with self.assertRaises(ValueError):
            pipeline.source_map('/stats/matches/mapstatsid/not-a-number/a-vs-b')

    def test_output_tampering_detected_without_overwriting(self):
        path, _ = pipeline.build(self.sources, self.root / 'versions', self.lock, registry(), {'maps': []})
        target = path / 'report.json'
        target.write_text('{}')
        with self.assertRaisesRegex(ValueError, 'Output checksum'):
            pipeline.build(self.sources, self.root / 'versions', self.lock, registry(), {'maps': []})
        self.assertEqual(target.read_text(), '{}')

    def test_deferred_and_excluded_maps_never_generate_edges(self):
        for decision in ('defer', 'exclude'):
            with self.subTest(decision=decision):
                review = self.approval(self.records())
                review['decision'] = decision
                path, report = pipeline.build(self.sources, self.root / decision, self.lock, registry(), {'maps': [review]})
                self.assertEqual(report['verified_teammate_edges'], 0)
                self.assertEqual(report['counts']['resolved_appearances'], 0)
                with sqlite3.connect(path / 'staging.sqlite3') as db:
                    self.assertEqual(db.execute('SELECT count(*) FROM teammate_evidence').fetchone()[0], 0)

    def test_literal_nan_correction_preserves_original_and_has_bound_evidence(self):
        csv_file(self.sources / pipeline.DETAILS, [detail(team1_p1_name='')])
        self.refresh_lock()
        rec = self.records()
        fingerprint = rec['record_sha256']
        review, people = self.observed_approval(rec)
        review['nickname_corrections'] = [{'group_no': 1, 'slot': 1, 'original': '', 'corrected': 'NaN', 'evidence_url': rec['source_url']}]
        review['observed_groups'][0]['players'][0]['nickname'] = 'NaN'
        people['players'][0]['nickname'] = 'NaN'
        pipeline.apply_review(rec, review, pipeline.validate_players(people))
        self.assertEqual(rec['record_sha256'], fingerprint)
        self.assertEqual(rec['stat_groups'][0]['names_raw'][0], '')
        self.assertEqual(rec['stat_groups'][0]['names_reviewed'][0], 'NaN')
        self.assertEqual(rec['structure_status'], 'corrected_with_evidence')
        self.assertIn('missing_nickname', rec['flags'])
        path, report = pipeline.build(self.sources, self.root / 'corrected', self.lock, people, {'schema_version': 2, 'maps': [review]})
        self.assertEqual(report['verified_teammate_edges'], 20)
        with sqlite3.connect(path / 'staging.sqlite3') as db:
            self.assertEqual(db.execute("SELECT nickname_raw,player_id FROM appearances WHERE group_no=1 AND slot=1").fetchone(), ('', 'person-0'))

    def test_unapproved_missing_name_cannot_be_verified(self):
        csv_file(self.sources / pipeline.DETAILS, [detail(team1_p1_name='')])
        rec = self.records()
        review, people = self.observed_approval(rec)
        with self.assertRaisesRegex(ValueError, 'quarantined'):
            pipeline.apply_review(rec, review, pipeline.validate_players(people))

    def test_case_changed_observation_cannot_select_other_niko(self):
        rec = self.records()
        review, people = self.observed_approval(rec)
        review['observed_groups'][0]['players'][0]['nickname'] = 'niko'
        with self.assertRaisesRegex(ValueError, 'nickname or external identity'):
            pipeline.apply_review(rec, review, pipeline.validate_players(people))

    def test_observed_external_id_cannot_disagree_with_registered_player(self):
        rec = self.records()
        review, people = self.observed_approval(rec)
        review['observed_groups'][0]['players'][0]['hltv_id'] = '9000005'
        with self.assertRaisesRegex(ValueError, 'nickname or external identity'):
            pipeline.apply_review(rec, review, pipeline.validate_players(people))

    def test_profile_link_must_bind_the_observed_external_id(self):
        rec = self.records()
        review, people = self.observed_approval(rec)
        review['observed_groups'][0]['players'][0]['profile_url'] = 'https://www.hltv.org/stats/players/9000005/niko'
        with self.assertRaisesRegex(ValueError, 'profile URL'):
            pipeline.apply_review(rec, review, pipeline.validate_players(people))

    def test_correction_cannot_cover_another_unresolved_structure_error(self):
        csv_file(self.sources / pipeline.HISTORY, [history(team1_rounds='-')])
        rec = self.records()
        review, people = self.observed_approval(rec)
        review['nickname_corrections'] = [{'group_no': 1, 'slot': 1, 'original': 'NiKo', 'corrected': 'Alias', 'evidence_url': rec['source_url']}]
        review['observed_groups'][0]['players'][0]['nickname'] = 'Alias'
        with self.assertRaisesRegex(ValueError, 'quarantined'):
            pipeline.apply_review(rec, review, pipeline.validate_players(people))

    def test_stale_correction_cannot_replace_a_different_source_value(self):
        rec = self.records()
        review, people = self.observed_approval(rec)
        review['nickname_corrections'] = [{'group_no': 1, 'slot': 1, 'original': '', 'corrected': 'NaN', 'evidence_url': rec['source_url']}]
        with self.assertRaisesRegex(ValueError, 'Stale or repeated'):
            pipeline.apply_review(rec, review, pipeline.validate_players(people))

    def test_schema_two_cannot_omit_observed_identity_evidence(self):
        review = self.approval(self.records())
        with self.assertRaisesRegex(ValueError, 'requires observed identity evidence'):
            pipeline.build(self.sources, self.root / 'schema2', self.lock, registry(), {'schema_version': 2, 'maps': [review]})

    def test_rights_clearance_alone_does_not_release_a_question_bank(self):
        lock = copy.deepcopy(self.lock)
        lock['rights_status'] = 'cleared'
        _, report = pipeline.build(self.sources, self.root / 'rights', lock, registry(), {'maps': [self.approval(self.records())]})
        self.assertEqual(report['counts']['eligible_for_questions'], 1)
        self.assertFalse(report['release_ready'])
        self.assertFalse(report['release_gates']['question_coverage_accepted'])


if __name__ == '__main__':
    unittest.main()
