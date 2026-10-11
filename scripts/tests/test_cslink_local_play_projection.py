import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cslink_candidate_library import build as build_candidate
from cslink_local_play_projection import build, validate_candidate_db
from scripts.tests.test_cslink_candidate_library import write_fixture


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def fixture(root):
    plan, captures = write_fixture(root)
    showmatch_capture = captures / '124.json'
    capture = json.loads(showmatch_capture.read_text())
    for row in capture['rows']:
        row['details']['event'] = 'Showmatch CS'
    showmatch_capture.write_text(json.dumps(capture))
    candidate_dir = root / 'candidate'
    build_candidate(plan, captures, candidate_dir, ledger_path=None)
    candidate_manifest = json.loads((candidate_dir / 'manifest.json').read_text())
    audit_dir = root / 'audit'
    audit_dir.mkdir()
    plan_rows = [json.loads(line) for line in plan.read_text().splitlines() if line.strip()]
    audit_report = {'integrity_issue_count': 0, 'captures_missing_provenance': [],
                    'planned_maps': 2, 'plan_sha256': digest(plan.read_bytes()),
                    'event_review_items': 2}
    (audit_dir / 'report.json').write_text(json.dumps(audit_report))
    (audit_dir / 'event-review.jsonl').write_text(''.join(
        json.dumps({'event_url': row['event_url']}) + '\n' for row in plan_rows))
    approval = {'schema_version': 1, 'approval_id': 'fixture-local-batch',
                'approval_kind': 'user_batch_scope_approval', 'play_scope': 'local',
                'candidate_version': candidate_manifest['version'],
                'candidate_db_sha256': candidate_manifest['files']['library.sqlite3']['sha256'],
                'plan_sha256': digest(plan.read_bytes()),
                'audit_report_sha256': digest((audit_dir / 'report.json').read_bytes()),
                'audit_event_review_sha256': digest((audit_dir / 'event-review.jsonl').read_bytes()),
                'expected_event_count': 2, 'expected_sampled_map_count': 2,
                'excluded_maps': [{'map_id': 124, 'expected_event_as_displayed': 'Showmatch CS',
                                   'reason': 'showmatch_outside_formal_event'}]}
    approval_path = root / 'approval.json'
    approval_path.write_text(json.dumps(approval))
    return plan, candidate_dir, audit_dir, approval_path


class LocalPlayProjectionTests(unittest.TestCase):
    def test_batch_projection_excludes_showmatch_and_preserves_source_review_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            plan, candidate, audit, approval = fixture(root)
            output = root / 'projection'
            source_before = (candidate / 'library.sqlite3').read_bytes()
            report = build(candidate, plan, audit, approval, output, ledger_path=None)
            manifest = json.loads((output / 'manifest.json').read_text())
            self.assertEqual(report['approved_event_count'], 2)
            self.assertEqual(report['included_map_count'], 1)
            self.assertEqual(report['excluded_map_count'], 1)
            self.assertEqual(report['included_pair_count'], 20)
            self.assertEqual(report['included_pair_map_evidence_count'], 20)
            self.assertEqual(manifest['included_map_ids'], [123])
            self.assertEqual([row['map_id'] for row in manifest['excluded_maps']], [124])
            self.assertEqual(manifest['approval']['individual_map_review'], 'not_performed')
            self.assertEqual(manifest['approval']['evidence_state'], 'observed_unreviewed')
            self.assertEqual((candidate / 'library.sqlite3').read_bytes(), source_before)
            with sqlite3.connect(candidate / 'library.sqlite3') as db:
                self.assertEqual(db.execute('SELECT count(*) FROM maps WHERE review_state="unreviewed"'
                                            ).fetchone()[0], 2)
                self.assertEqual(db.execute('SELECT count(*) FROM maps WHERE eligible_for_questions=0'
                                            ).fetchone()[0], 2)
            self.assertEqual(report, build(candidate, plan, audit, approval, output,
                                           ledger_path=None))

    def test_unlisted_showmatch_fails_without_replacing_existing_projection(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            plan, candidate, audit, approval = fixture(root)
            output = root / 'projection'
            build(candidate, plan, audit, approval, output, ledger_path=None)
            previous = (output / 'manifest.json').read_bytes()
            decision = json.loads(approval.read_text())
            decision['excluded_maps'] = []
            approval.write_text(json.dumps(decision))
            with self.assertRaisesRegex(ValueError, 'scope anomaly lacks explicit disposition'):
                build(candidate, plan, audit, approval, output, ledger_path=None)
            self.assertEqual((output / 'manifest.json').read_bytes(), previous)

    def test_source_hash_change_fails_closed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            plan, candidate, audit, approval = fixture(root)
            (candidate / 'library.sqlite3').write_bytes(
                (candidate / 'library.sqlite3').read_bytes() + b'changed')
            with self.assertRaisesRegex(ValueError, 'differs from its manifest'):
                build(candidate, plan, audit, approval, root / 'projection', ledger_path=None)

    def test_cross_team_edge_and_incomplete_lineup_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            plan, candidate, _audit, _approval = fixture(root)
            plan_rows = [json.loads(line) for line in plan.read_text().splitlines() if line.strip()]
            plan_by_id = {row['selected_mapstatsid']: row for row in plan_rows}
            db_path = candidate / 'library.sqlite3'
            with sqlite3.connect(db_path) as db:
                db.row_factory = sqlite3.Row
                a, b, map_id = db.execute('SELECT player_a,player_b,map_id FROM edge_evidence LIMIT 1'
                                          ).fetchone()
                db.execute('UPDATE edge_evidence SET team_name=? WHERE player_a=? AND player_b=? '
                           'AND map_id=?', ('Wrong team', a, b, map_id))
                db.commit()
                with self.assertRaisesRegex(ValueError, 'differs from same-map five-player pairs'):
                    validate_candidate_db(db, plan_by_id, 2)
                db.execute('UPDATE edge_evidence SET team_name=? WHERE player_a=? AND player_b=? '
                           'AND map_id=?', ('Alpha', a, b, map_id))
                db.execute('DELETE FROM appearances WHERE map_id=123 AND player_id=?', ('3741',))
                db.commit()
                with self.assertRaisesRegex(ValueError, 'foreign key check failed|five-player teams'):
                    validate_candidate_db(db, plan_by_id, 2)


if __name__ == '__main__':
    unittest.main()
