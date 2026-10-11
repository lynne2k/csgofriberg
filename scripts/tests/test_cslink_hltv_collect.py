import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cslink_hltv_collect import classify_failure, collect, trace_rejected_target, validate_source_url


class HltvCollectTests(unittest.TestCase):
    def test_collect_validates_and_resumes_without_second_request(self):
        rows = []
        for team_index, (team, opponent, score, other) in enumerate(
                [('Alpha', 'Beta', 13, 9), ('Beta', 'Alpha', 9, 13)]):
            for index in range(5):
                player_id = str(100 + team_index * 5 + index)
                rows.append({'matchStatsId': '123', 'playerId': player_id,
                             'playerName': f'p{player_id}', 'team': team,
                             'url': f'https://www.hltv.org/stats/players/{player_id}/p{player_id}',
                             'details': {'event': 'Sample', 'dateTime': '2025-01-01 10:00',
                                         'map': 'Mirage', 'opponent': opponent,
                                         'teamScore': score, 'opponentScore': other}})
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            binary = root / 'opencli'
            binary.write_text('')
            plan = root / 'plan.jsonl'
            plan.write_text(json.dumps({'selected_mapstatsid': 123,
                                        'hltv_map_url': 'https://www.hltv.org/stats/matches/mapstatsid/123/-',
                                        'hltv_series_id': 456, 'event_url': 'https://example.com/event',
                                        'source_revision_sha256': 'abc'}) + '\n')
            response = type('Response', (), {'returncode': 0, 'stdout': json.dumps(rows), 'stderr': ''})()
            with patch('cslink_hltv_collect.subprocess.run', return_value=response) as run:
                first = collect(plan, root / 'captures', binary, None, 0, 0, 30)
                second = collect(plan, root / 'captures', binary, None, 0, 0, 30)
            self.assertEqual(run.call_count, 1)
            self.assertEqual(first['captured'], 1)
            self.assertEqual(second['cached'], 1)
            stored = json.loads((root / 'captures/123.json').read_text())
            self.assertFalse(stored['eligible_for_questions'])
            self.assertEqual(len(stored['rows']), 10)
            changed = json.loads(plan.read_text())
            changed['source_revision_sha256'] = 'new-source-revision'
            plan.write_text(json.dumps(changed) + '\n')
            with patch('cslink_hltv_collect.subprocess.run', return_value=response) as rerun:
                third = collect(plan, root / 'captures', binary, None, 0, 0, 30)
                rerun.assert_not_called()
            self.assertEqual(third['failed'], 1)
            self.assertEqual(json.loads((root / 'captures/attempts.jsonl').read_text().splitlines()[-1])['status'],
                             'cached_provenance_conflict')

    def test_failure_classification_pauses_on_source_rejection(self):
        self.assertEqual(classify_failure(69, 'Navigation rejected', ''), 'browser_navigation')
        self.assertEqual(classify_failure(1, 'HTTP 403', ''), 'source_access_rejected')
        self.assertEqual(classify_failure(-1, '', ''), 'command_timeout')
        self.assertEqual(classify_failure(75, 'match-map timed out after 60s', ''), 'command_timeout')

    def test_timeout_trace_for_target_challenge_pauses_without_retry(self):
        target = 'https://www.hltv.org/stats/matches/mapstatsid/123/alpha-vs-beta'
        other = 'https://www.hltv.org/stats/matches/mapstatsid/124/other'
        with tempfile.TemporaryDirectory() as temp:
            trace_root = Path(temp)
            trace_dir = trace_root / 'trace-123'
            trace_dir.mkdir()
            (trace_dir / 'network.jsonl').write_text('\n'.join(json.dumps(row) for row in (
                {'url': other, 'status': 403, 'responseHeaders': {'cf-mitigated': 'challenge'}},
                {'url': target, 'status': 403, 'responseHeaders': {'cf-mitigated': 'challenge'}},
            )) + '\n')
            output = 'error: TIMEOUT\ntraceId: trace-123\n'
            self.assertTrue(trace_rejected_target(output, target, trace_root))
            self.assertFalse(trace_rejected_target(output, 'https://www.hltv.org/not-target', trace_root))
            with patch('cslink_hltv_collect.trace_rejected_target', return_value=True):
                self.assertEqual(classify_failure(75, output, '', target), 'source_access_rejected')

    def test_verified_canonical_map_url_is_allowed_but_other_routes_are_rejected(self):
        validate_source_url('https://www.hltv.org/stats/matches/mapstatsid/167591/into-the-breach-vs-9-pandas', 167591)
        for url in ('https://www.hltv.org/stats/matches/mapstatsid/167590/into-the-breach-vs-9-pandas',
                    'https://other.example/stats/matches/mapstatsid/167591/into-the-breach-vs-9-pandas',
                    'https://www.hltv.org/stats/matches/mapstatsid/167591/into-the-breach-vs-9-pandas?x=1'):
            with self.subTest(url=url), self.assertRaises(ValueError):
                validate_source_url(url, 167591)


if __name__ == '__main__':
    unittest.main()
