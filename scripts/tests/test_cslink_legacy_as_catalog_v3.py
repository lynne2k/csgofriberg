import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cslink_legacy_as_catalog_v3 import build, exact_link_check, title_compatibility
from scripts.tests.test_cslink_legacy_as_catalog import write_event_page, write_index


class LegacyAsCatalogV3Tests(unittest.TestCase):
    def test_official_short_name_requires_plain_exact_name_and_match_date(self):
        event = {'event_name': 'ESL Challenger at DreamHack Valencia 2022',
                 'event_url': 'https://liquipedia.net/counterstrike/ESL/Challenger/2022/Valencia',
                 'page_start_date': '2022-02-15', 'page_end_date': '2022-02-27',
                 'official_short_names': [
                     {'field': 'tickername', 'raw': 'ESL Challenger Valencia 2022'},
                     {'field': 'shortname', 'raw': 'Valencia'}]}
        record = {'date_raw': '2022-02-16', 'event_raw': 'ESL Challenger Valencia 2022'}
        self.assertEqual(exact_link_check(record, event, match_date='2022-02-17'),
                         ([], 'official_infobox_tickername_exact'))
        self.assertEqual(exact_link_check(record, event, match_date='2022-02-20')[0],
                         ['official_shortname_match_date_mismatch'])
        self.assertEqual(exact_link_check(record, event, match_date=None)[0],
                         ['official_shortname_match_date_unavailable'])
        self.assertIsNone(title_compatibility('ESL Challenger Valencia 2022 Minor',
                                              event['event_name'], '2022', event['event_url'],
                                              [{'field': 'tickername',
                                                'raw': 'ESL Challenger Valencia 2022 Minor'}]))
        self.assertIsNone(title_compatibility('ESL Challenger Valencia 2022 Regionals',
                                              event['event_name'], '2022', event['event_url'],
                                              [{'field': 'tickername',
                                                'raw': 'ESL Challenger Valencia 2022 Regionals'}]))

    def test_build_keeps_ticker_evidence_and_quarantines_wrong_match_day(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            index_dir, event_dir, output = (base / item for item in ('index', 'events', 'out'))
            index_dir.mkdir()
            event_dir.mkdir()
            name = 'ESL Challenger at DreamHack Valencia 2022'
            slug = 'ESL/Challenger/2022/Valencia'
            url = 'https://liquipedia.net/counterstrike/' + slug
            write_index(index_dir, 'S-Tier_Tournaments--2012-2023',
                        'S-Tier_Tournaments/2012-2023', [])
            write_index(index_dir, 'A-Tier_Tournaments--2016-2023',
                        'A-Tier_Tournaments/2016-2023', [(name, slug)])
            wiki = ('{{Infobox league\n|liquipediatier=A-Tier\n|tickername=ESL Challenger Valencia 2022'
                    '\n|sdate=2022-02-15\n|edate=2022-02-27\n}}'
                    '{{Match|date=February 16, 2022 - 12:00|hltv=2357157|map1={{Map|stats=140131}}}}'
                    '{{Match|date=February 20, 2022 - 12:00|hltv=2357158|map1={{Map|stats=140132}}}}')
            write_event_page(event_dir, url, wiki)
            db_path = base / 'staging.sqlite3'
            db = sqlite3.connect(db_path)
            db.execute('''CREATE TABLE maps(map_id INTEGER, source_url TEXT, date_raw TEXT,
                structure_status TEXT, review_status TEXT, record_sha256 TEXT, record_json TEXT)''')
            for map_id in (140131, 140132):
                record = {'metadata': {'event_raw': 'ESL Challenger Valencia 2022',
                                       'teams_display': ['A', 'B']},
                          'stat_groups': [{'names_raw': ['a', 'b', 'c', 'd', 'e']},
                                          {'names_raw': ['f', 'g', 'h', 'i', 'j']}]}
                db.execute('INSERT INTO maps VALUES(?,?,?,?,?,?,?)', (
                    map_id, f'https://www.hltv.org/stats/matches/mapstatsid/{map_id}/-',
                    '2022-02-16 12:00:00', 'structurally_complete', 'unreviewed',
                    'a' * 64, json.dumps(record)))
            db.commit()
            db.close()
            report = build(index_dir, event_dir, db_path, output, subpage_cache_dir=event_dir,
                           baseline_dir=None)
            self.assertEqual(report['new_exact_maps_vs_v2'], 1)
            exact = [json.loads(line) for line in (output / 'new-exact-map-queue.jsonl').read_text().splitlines()]
            self.assertEqual([row['map_id'] for row in exact], [140131])
            evidence = exact[0]['official_alias_evidence']
            self.assertEqual((evidence['field'], evidence['raw'], evidence['liquipedia_match_date']),
                             ('tickername', 'ESL Challenger Valencia 2022', '2022-02-16'))
            self.assertEqual(evidence['event_page_sha256'], exact[0]['source_revision_sha256'])
            quarantined = [json.loads(line) for line in
                           (output / 'quarantined-exact-links.jsonl').read_text().splitlines()]
            self.assertEqual([row['map_id'] for row in quarantined], [140132])
            self.assertEqual(quarantined[0]['quarantine_reasons'],
                             ['official_shortname_match_date_mismatch'])


if __name__ == '__main__':
    unittest.main()
