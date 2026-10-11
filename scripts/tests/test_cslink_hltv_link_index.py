import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cslink_hltv_link_index import build


class HltvLinkIndexTests(unittest.TestCase):
    def test_links_preserve_source_and_reject_approved_rosters(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / 'maps.jsonl'
            output = root / 'index'
            row = {'mapstatsid': 159569, 'hltv_series_id': 2365224,
                   'event_url': 'https://liquipedia.net/counterstrike/example',
                   'event_name': 'Example', 'source_page_url': 'https://liquipedia.net/counterstrike/example',
                   'source_revision_sha256': 'abc', 'tier': 'S-Tier',
                   'roster_status': 'unverified', 'eligible_for_questions': False}
            source.write_text(json.dumps(row) + '\n')
            report = build(source, output)
            self.assertEqual((report['map_links'], report['series_links_with_maps']), (1, 1))
            linked = json.loads((output / 'map-links.jsonl').read_text())
            self.assertEqual(linked['game_link'], '/stats/matches/mapstatsid/159569/-')
            self.assertEqual(linked['hltv_map_url'], 'https://www.hltv.org' + linked['game_link'])
            self.assertEqual(linked['hltv_series_url'], 'https://www.hltv.org/matches/2365224/-')
            self.assertEqual(linked['source_revision_sha256'], 'abc')
            self.assertEqual(build(source, output), report)
            series_source = root / 'series.jsonl'
            series_source.write_text(''.join(json.dumps(item) + '\n' for item in [
                {**row, 'mapstatsids': [159569]},
                {**row, 'hltv_series_id': 2365225, 'mapstatsids': []},
            ]))
            with_series = build(source, root / 'with-series', series_source)
            self.assertEqual(with_series['series_links_total'], 2)
            self.assertEqual(with_series['series_links_without_maps'], 1)
            self.assertEqual(with_series['ambiguous_map_to_series_links'], 0)
            row['eligible_for_questions'] = True
            source.write_text(json.dumps(row) + '\n')
            with self.assertRaisesRegex(ValueError, 'discovery candidates only'):
                build(source, output)


if __name__ == '__main__':
    unittest.main()
