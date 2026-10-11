import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cslink_tier_catalog import TournamentRows, candidate, start_date
from cslink_tier_enrich import digits_field, template_blocks, enrich, without_showmatch_section


class TierCatalogTests(unittest.TestCase):
    def test_date_boundary_and_cross_year(self):
        self.assertEqual(start_date('Dec 29 – Jan 4, 2024').isoformat(), '2023-12-29')
        self.assertEqual(start_date('Jul 13 – 23, 2023').isoformat(), '2023-07-13')
        self.assertIsNone(start_date('TBD'))

    def test_index_row_is_only_a_candidate(self):
        html = ('<h3 id="2024">2024</h3><div class="tournaments-listing"><table>'
                '<tr class="row--body"><td>CS2</td><td>icon</td>'
                '<td><a href="/counterstrike/PGL/2024/Copenhagen">PGL Major Copenhagen 2024</a></td>'
                '<td>Mar 17 – 31, 2024</td><td>prize</td><td>place</td><td>24</td></tr>'
                '</table></div>')
        parser = TournamentRows()
        parser.feed(html)
        record = candidate(parser.rows[0], 'S', 'https://liquipedia.net/counterstrike/S-Tier_Tournaments')
        self.assertEqual(record['start_date'], '2024-03-17')
        self.assertEqual(record['review_state'], 'candidate')
        self.assertIsNone(record['hltv_event_id'])

    def test_showmatch_section_is_not_discovered_as_official_results(self):
        wiki = ('==Results==\n{{Match|map1={{Map|stats=190895}}|hltv=2378454}}\n'
                '=={{Stage|Showmatch}}==\n{{Match|map1={{Map|stats=190896}}|hltv=2378455}}')
        blocks = list(template_blocks(without_showmatch_section(wiki), 'Match'))
        self.assertEqual(len(blocks), 1)
        self.assertEqual(digits_field(next(template_blocks(blocks[0], 'Map')), 'stats'), 190895)

    def test_nested_match_map_ids_and_source_cache_integrity(self):
        wiki = ('{{Infobox league\n|liquipediatier=S-Tier\n|sdate=2025-01-23\n|edate=2025-01-26\n}}'
                '{{Match\n|map1={{Map|map=Anubis|stats=190895|vod=x}}\n'
                '|map2={{Map|map=Dust II|stats=190897|vod=x}}\n'
                '|map3={{Map|map=Mirage|stats=2378454}}\n|hltv=2378454\n}}')
        block = next(template_blocks(wiki, 'Match'))
        self.assertEqual(digits_field(block, 'hltv'), 2378454)
        self.assertEqual([digits_field(x, 'stats') for x in template_blocks(block, 'Map')], [190895, 190897, 2378454])
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            catalog = directory / 'catalog.jsonl'
            cache = directory / 'cache'
            output = directory / 'output'
            cache.mkdir()
            url = 'https://liquipedia.net/counterstrike/BLAST/Bounty/2025/Spring'
            item = {'event_url': url, 'event_name': 'BLAST Bounty', 'index_tier': 'S',
                    'start_date': '2025-01-23', 'review_state': 'candidate'}
            catalog.write_text(json.dumps(item) + '\n')
            import hashlib
            key = hashlib.sha256(url.encode()).hexdigest()[:20]
            raw = json.dumps({'query': {'pages': [{'revisions': [{'slots': {'main': {'content': wiki}}}]}]}}).encode()
            (cache / f'{key}.json').write_bytes(raw)
            (cache / f'{key}.meta.json').write_text(json.dumps({
                'event_url': url, 'sha256': hashlib.sha256(raw).hexdigest(), 'revision_timestamp': '2025-01-27T00:00:00Z'}))
            report = enrich(catalog, cache, output)
            self.assertEqual(report['discovered_series_ids_unique'], 1)
            self.assertEqual(report['discovered_map_ids_unique'], 2)
            self.assertEqual(len(report['invalid_stats_references']), 1)
            maps = [json.loads(x) for x in (output / 'map-id-queue.jsonl').read_text().splitlines()]
            self.assertEqual([x['mapstatsid'] for x in maps], [190895, 190897])
            series = [json.loads(x) for x in (output / 'series-id-queue.jsonl').read_text().splitlines()]
            self.assertEqual(series[0]['hltv_series_id'], 2378454)
            self.assertEqual(series[0]['mapstatsids'], [190895, 190897])
            self.assertTrue(all(x['roster_status'] == 'unverified' and not x['eligible_for_questions'] for x in maps))
            (cache / f'{key}.json').write_bytes(raw + b' ')
            with self.assertRaisesRegex(ValueError, 'Changed event cache'):
                enrich(catalog, cache, output)


if __name__ == '__main__':
    unittest.main()
