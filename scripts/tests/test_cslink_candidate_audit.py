import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cslink_candidate_audit import audit, compare_versions
from cslink_hltv_stage import stage


def jsonl(rows):
    return ''.join(json.dumps(row) + '\n' for row in rows)


class CandidateAuditTests(unittest.TestCase):
    def fixture(self, root):
        snapshot = root / 'snapshot'
        capture_dir = root / 'captures'
        stage_dir = root / 'stage'
        snapshot.mkdir()
        capture_dir.mkdir()
        event_url = 'https://liquipedia.net/counterstrike/Sample_Event'
        source_url = 'https://www.hltv.org/stats/matches/mapstatsid/123/-'
        source_sha = 'a' * 64
        plan_row = {'selected_mapstatsid': 123, 'hltv_series_id': 456,
                    'hltv_map_url': source_url, 'event_url': event_url,
                    'event_name': 'Sample Event', 'tier': 'S-Tier',
                    'event_start_date': '2025-01-01', 'source_page_url': event_url,
                    'source_revision_sha256': source_sha, 'roster_status': 'unverified',
                    'eligible_for_questions': False}
        plan_path = root / 'plan.jsonl'
        plan_path.write_text(jsonl([plan_row]))
        (snapshot / 'events.jsonl').write_text(jsonl([{
            'event_url': event_url, 'event_name': 'Sample Event', 'page_tier': 'S-Tier',
            'index_tier': 'S', 'page_start_date': '2025-01-01',
            'review_state': 'needs_scope_review'}]))
        (snapshot / 'map-id-queue.jsonl').write_text(jsonl([{
            'mapstatsid': 123, 'event_url': event_url, 'hltv_series_id': 456,
            'source_page_url': event_url, 'source_revision_sha256': source_sha,
            'tier': 'S-Tier'}]))
        rows = []
        for team_index, (team, opponent, score, other_score) in enumerate(
                [('Alpha', 'Beta', 13, 9), ('Beta', 'Alpha', 9, 13)]):
            for index in range(5):
                player_id = str(100 + team_index * 5 + index)
                nickname = f'p{player_id}'
                if team_index == 0 and index == 0:
                    player_id, nickname = '3741', 'NiKo'
                if team_index == 1 and index == 0:
                    player_id, nickname = '10264', 'niko'
                rows.append({'matchStatsId': '123', 'playerId': player_id,
                             'playerName': nickname, 'team': team,
                             'url': f'https://www.hltv.org/stats/players/{player_id}/{nickname.lower()}',
                             'details': {'event': 'Sample Event', 'dateTime': '2025-01-01 10:00',
                                         'map': 'Mirage', 'opponent': opponent,
                                         'teamScore': score, 'opponentScore': other_score}})
        capture = {'source_url': source_url, 'rows': rows, 'event_url': event_url,
                   'hltv_series_id_from_liquipedia': 456,
                   'source_revision_sha256': source_sha}
        capture_path = capture_dir / '123.json'
        capture_path.write_text(json.dumps(capture))
        stage(plan_path, capture_dir, stage_dir)
        return plan_path, snapshot, capture_dir, stage_dir, capture_path

    def test_recomputes_same_map_same_team_edges_and_keeps_case_collisions_distinct(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plan, snapshot, captures, staged, _ = self.fixture(root)
            report = audit(plan, snapshot, captures, staged, root / 'audit')
            self.assertEqual(report['integrity_issue_count'], 0)
            self.assertEqual(report['recomputed_pairs'], 20)
            self.assertEqual(report['casefold_only_nickname_collisions'], 1)
            self.assertFalse(report['question_eligibility'])

            edge_path = staged / 'candidate-edges.jsonl'
            edges = [json.loads(line) for line in edge_path.read_text().splitlines()]
            edges.append({'hltv_player_ids': ['3741', '10264'],
                          'evidence': [edges[0]['evidence'][0]],
                          'review_state': 'unreviewed', 'eligible_for_questions': False})
            edge_path.write_text(jsonl(edges))
            corrupted = audit(plan, snapshot, captures, staged, root / 'audit-corrupted')
            self.assertEqual(corrupted['integrity_issue_counts']['candidate_edge_set_mismatch'], 1)

    def test_missing_capture_provenance_and_tier_mismatch_are_reported(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plan, snapshot, captures, staged, capture_path = self.fixture(root)
            capture = json.loads(capture_path.read_text())
            capture.pop('event_url')
            capture_path.write_text(json.dumps(capture))
            source_events_path = snapshot / 'events.jsonl'
            source_event = json.loads(source_events_path.read_text())
            source_event['page_tier'] = 'A-Tier'
            source_events_path.write_text(jsonl([source_event]))
            report = audit(plan, snapshot, captures, staged, root / 'audit')
            self.assertEqual(report['captures_missing_provenance'], [123])
            self.assertEqual(report['integrity_issue_counts']['capture_missing_provenance_fields'], 1)
            self.assertEqual(report['integrity_issue_counts']['event_source_binding_mismatch'], 1)
            self.assertEqual(report['integrity_issue_counts']['stage_capture_binding_mismatch'], 1)

    def test_version_comparison_exposes_display_time_drift_without_roster_change(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            plan, snapshot, captures, staged, capture_path = self.fixture(root)
            old_audit = root / 'old-audit'
            audit(plan, snapshot, captures, staged, old_audit)
            changed = json.loads(capture_path.read_text())
            for row in changed['rows']:
                row['details']['dateTime'] = '2025-01-01 16:00'
            current_captures = root / 'current-captures'
            current_captures.mkdir()
            (current_captures / '123.json').write_text(json.dumps(changed))
            current_stage = root / 'current-stage'
            stage(plan, current_captures, current_stage)
            current_audit = root / 'current-audit'
            audit(plan, snapshot, current_captures, current_stage, current_audit)
            comparison = compare_versions(staged, current_stage, old_audit,
                                          current_audit, root / 'comparison.json')
            self.assertEqual(comparison['changed_maps'][0]['changed_fields'],
                             ['date_time_as_displayed', 'source_sha256'])
            self.assertTrue(comparison['changed_maps'][0]['roster_unchanged'])
            self.assertEqual(comparison['changed_candidate_edge_count'], 20)
            self.assertFalse(comparison['count_changes'])


if __name__ == '__main__':
    unittest.main()
