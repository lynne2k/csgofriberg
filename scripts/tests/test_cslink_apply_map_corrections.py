import hashlib
import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cslink_apply_map_corrections import BASE, LEDGER, build


class MapCorrectionTests(unittest.TestCase):
    def test_one_verified_link_correction_keeps_all_other_rows_and_source_auditable(self):
        with tempfile.TemporaryDirectory() as temp:
            output = Path(temp) / 'corrected'
            report = build(BASE, LEDGER, output)
            original = [json.loads(line) for line in (BASE / 'selected-series.jsonl').read_text().splitlines()]
            corrected_raw = (output / 'selected-series.jsonl').read_bytes()
            corrected = [json.loads(line) for line in corrected_raw.splitlines()]
            self.assertEqual(len(original), 805)
            self.assertEqual(len(corrected), 805)
            self.assertEqual(sum(a != b for a, b in zip(original, corrected)), 1)
            self.assertEqual(len({row['selected_mapstatsid'] for row in corrected}), 805)
            before = next(row for row in original if row['hltv_series_id'] == 2368425)
            after = next(row for row in corrected if row['hltv_series_id'] == 2368425)
            self.assertEqual(before['selected_mapstatsid'], 167590)
            self.assertEqual(after['selected_mapstatsid'], 167591)
            self.assertEqual(after['source_selected_mapstatsid'], 167590)
            self.assertEqual(after['source_candidate_mapstatsids_in_series'], [167590, 167592, 167594])
            self.assertEqual(after['candidate_mapstatsids_in_series'], [167591, 167592, 167594])
            self.assertEqual(after['hltv_map_url'],
                             'https://www.hltv.org/stats/matches/mapstatsid/167591/into-the-breach-vs-9-pandas')
            self.assertEqual(after['source_hltv_map_url'], before['hltv_map_url'])
            self.assertEqual(after['source_revision_sha256'], before['source_revision_sha256'])
            self.assertEqual(after['roster_status'], 'unverified')
            self.assertIs(after['eligible_for_questions'], False)
            self.assertEqual(report['changed_rows'], 1)
            self.assertEqual(report['effective_plan_sha256'], hashlib.sha256(corrected_raw).hexdigest())
            manifest = json.loads((output / 'manifest.json').read_text())
            for name, expected in manifest['files'].items():
                raw = (output / name).read_bytes()
                self.assertEqual(expected, {'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest()})
            self.assertEqual(build(BASE, LEDGER, output), report)
            with (output / 'report.json').open('a') as handle:
                handle.write(' ')
            with self.assertRaisesRegex(ValueError, 'Refusing to overwrite changed effective plan'):
                build(BASE, LEDGER, output)

    def test_source_or_ledger_drift_fails_closed(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            changed_base = root / 'base'
            changed_base.mkdir()
            shutil.copy2(BASE / 'manifest.json', changed_base / 'manifest.json')
            raw = (BASE / 'selected-series.jsonl').read_bytes()
            (changed_base / 'selected-series.jsonl').write_bytes(raw + b' ')
            with self.assertRaisesRegex(ValueError, 'Frozen source plan or manifest changed'):
                build(changed_base, LEDGER, root / 'output-1')

            ledger = json.loads(LEDGER.read_text().strip())
            ledger['original_row_sha256'] = '0' * 64
            changed_ledger = root / 'changed-ledger.jsonl'
            changed_ledger.write_text(json.dumps(ledger) + '\n')
            with self.assertRaisesRegex(ValueError, 'Correction conflicts with frozen row'):
                build(BASE, changed_ledger, root / 'output-2')

            ledger['original_row_sha256'] = json.loads(LEDGER.read_text())['original_row_sha256']
            ledger['verified_mapstatsid'] = 167592  # Another original candidate, not the checked HLTV ID.
            changed_ledger.write_text(json.dumps(ledger) + '\n')
            with self.assertRaisesRegex(ValueError, 'Invalid or conflicting map ID correction'):
                build(BASE, changed_ledger, root / 'output-3')


if __name__ == '__main__':
    unittest.main()
