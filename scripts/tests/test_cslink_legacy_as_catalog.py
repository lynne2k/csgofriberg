import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cslink_legacy_as_catalog import (
    build, exact_link_check, normalized_title, result_subpages, title_compatibility,
)


def write_index(directory, stem, page, rows):
    html = '<h3 id="2022">2022</h3><div class="tournaments-listing"><table>'
    for name, url in rows:
        html += ('<tr class="row--body"><td>CS:GO</td><td>icon</td>'
                 f'<td><a href="/counterstrike/{url}">{name}</a></td>'
                 '<td>Feb 15 – 27, 2022</td><td>prize</td><td>place</td><td>24</td></tr>')
    html += '</table></div>'
    raw = json.dumps({'parse': {'text': html}}).encode()
    (directory / f'{stem}.json').write_bytes(raw)
    (directory / f'{stem}.meta.json').write_text(json.dumps({
        'page': page, 'sha256': hashlib.sha256(raw).hexdigest()}))


def write_event_page(directory, url, wiki):
    key = hashlib.sha256(url.encode()).hexdigest()[:20]
    raw = json.dumps({'query': {'pages': [{'revisions': [{'slots': {
        'main': {'content': wiki}}}]}]}}).encode()
    (directory / f'{key}.json').write_bytes(raw)
    (directory / f'{key}.meta.json').write_text(json.dumps({
        'event_url': url, 'sha256': hashlib.sha256(raw).hexdigest(),
        'page_title': url.removeprefix('https://liquipedia.net/counterstrike/').replace('_', ' '),
        'revision_timestamp': '2026-10-08T00:00:00Z'}))


def write_old_db(path):
    db = sqlite3.connect(path)
    db.execute('''CREATE TABLE maps(map_id INTEGER, source_url TEXT, date_raw TEXT,
        structure_status TEXT, review_status TEXT, record_sha256 TEXT, record_json TEXT)''')
    for map_id, date_raw, event_raw in (
        (134388, '2022-02-27 16:00:00', 'IEM Katowice 2022'),
        (134389, '2022-02-27 16:00:00', 'IEM Katowice 2022'),
        (134390, '2022-02-27 16:00:00', 'Intel Extreme Masters XVI - Katowice'),
        (134999, '2022-02-27 16:00:00', 'Showmatch'),
        (159569, '2023-07-13 21:00:00', 'Intel Extreme Masters XVI - Katowice')):
        record = {'metadata': {'event_raw': event_raw,
                               'teams_display': ['FaZe', 'G2']},
                  'stat_groups': [{'names_raw': ['jks', 'broky', 'rain', 'Twistzz', 'karrigan']},
                                  {'names_raw': ['NiKo', 'm0NESY', 'huNter-', 'JACKZ', 'Aleksib']}]}
        db.execute('INSERT INTO maps VALUES(?,?,?,?,?,?,?)', (
            map_id, f'https://www.hltv.org/stats/matches/mapstatsid/{map_id}/-',
            date_raw, 'structurally_complete', 'unreviewed', 'a' * 64,
            json.dumps(record)))
    db.commit()
    db.close()


class LegacyAsCatalogTests(unittest.TestCase):
    def test_exact_map_link_requires_validated_event_page_and_excludes_showmatch(self):
        with tempfile.TemporaryDirectory() as tmp:
            base = Path(tmp)
            index_dir, event_dir, output = (base / item for item in ('index', 'events', 'out'))
            index_dir.mkdir()
            event_dir.mkdir()
            name = 'Intel Extreme Masters XVI - Katowice'
            url = 'https://liquipedia.net/counterstrike/Intel_Extreme_Masters/Season_XVI/Katowice'
            write_index(index_dir, 'S-Tier_Tournaments--2012-2023',
                        'S-Tier_Tournaments/2012-2023',
                        [(name, 'Intel_Extreme_Masters/Season_XVI/Katowice')])
            write_index(index_dir, 'A-Tier_Tournaments--2016-2023',
                        'A-Tier_Tournaments/2016-2023', [])
            wiki = ('{{Infobox league\n|liquipediatier=S-Tier\n|sdate=2022-02-15\n|edate=2022-02-27\n}}'
                    '==Results==\n{{Match|hltv=2354404|map1={{Map|stats=134388}}}}\n'
                    '{{#section:Intel Extreme Masters/Season XVI/Katowice/Challengers Stage|Results}}\n'
                    '{{#section:Intel Extreme Masters/Season XVI/Katowice/Qualifier|Results}}\n'
                    '=={{Stage|Showmatch}}==\n{{Match|hltv=2354405|map1={{Map|stats=134999}}}}')
            write_event_page(event_dir, url, wiki)
            child_url = url + '/Challengers_Stage'
            write_event_page(event_dir, child_url,
                             '{{Match|hltv=2354406|map1={{Map|stats=134389}}}}')
            old_db = base / 'staging.sqlite3'
            write_old_db(old_db)
            report = build(index_dir, event_dir, old_db, output, subpage_cache_dir=event_dir)
            self.assertEqual(report['old_maps_before_cutoff'], 4)
            self.assertEqual(report['old_maps_on_overlap_day_excluded'], 1)
            self.assertEqual(report['exact_map_links_ready_for_roster_capture'], 2)
            self.assertEqual(report['result_subpages_discovered'], 1)
            self.assertEqual(report['result_subpages_rejected_for_scope'], 1)
            exact = [json.loads(line) for line in (output / 'exact-map-queue.jsonl').read_text().splitlines()]
            self.assertEqual([row['map_id'] for row in exact], [134388, 134389])
            self.assertEqual(exact[0]['hltv_series_id'], 2354404)
            self.assertEqual(exact[0]['event_url'], url)
            self.assertEqual(exact[1]['source_page_url'], child_url)
            self.assertEqual(exact[0]['event_name_match_status'], 'confirmed_by_code_rule')
            self.assertEqual(exact[0]['event_name_match_rule'], 'iem_season_venue_year_alias')
            self.assertEqual(exact[0]['event_end_date'], '2022-02-27')
            self.assertFalse(exact[0]['eligible_for_questions'])
            cover = [json.loads(line) for line in (output / 'capture-cover-plan.jsonl').read_text().splitlines()]
            self.assertEqual({row['selected_mapstatsid'] for row in cover}, {134388})
            self.assertTrue(all(row['event_start_date'] == '2022-02-15' for row in cover))
            self.assertTrue(all(row['eligible_for_questions'] is False for row in cover))
            titles = [json.loads(line) for line in (output / 'map-candidates.jsonl').read_text().splitlines()]
            self.assertEqual([row['map_id'] for row in titles], [134390])
            self.assertIsNone(titles[0]['hltv_series_id'])
            previous = (output / 'manifest.json').read_bytes()
            build(index_dir, event_dir, old_db, output, subpage_cache_dir=event_dir)
            self.assertEqual((output / 'manifest.json').read_bytes(), previous)
            write_event_page(event_dir, url, wiki.replace('liquipediatier=S-Tier',
                                                         'liquipediatier=A-Tier'))
            blocked = build(index_dir, event_dir, old_db, output, subpage_cache_dir=event_dir)
            self.assertEqual(blocked['exact_map_links_ready_for_roster_capture'], 0)
            key = hashlib.sha256(url.encode()).hexdigest()[:20]
            (event_dir / f'{key}.json').write_text('changed')
            with self.assertRaisesRegex(ValueError, 'Changed event cache'):
                build(index_dir, event_dir, old_db, output, subpage_cache_dir=event_dir)

    def test_title_normalization_is_conservative(self):
        self.assertEqual(normalized_title('Intel Extreme Masters Köln 2022'),
                         normalized_title('IEM Koln 2022'))
        self.assertNotEqual(normalized_title('IEM Katowice 2022 Play-in'),
                            normalized_title('IEM Katowice 2022'))

    def test_exact_link_requires_compatible_date_and_event_title(self):
        event = {'event_name': 'Intel Extreme Masters XVI - Katowice',
                 'event_url': 'https://liquipedia.net/counterstrike/Intel_Extreme_Masters/Season_XVI/Katowice',
                 'page_start_date': '2022-02-15', 'page_end_date': '2022-02-27'}
        valid = {'date_raw': '2022-02-27 16:00:00', 'event_raw': 'IEM Katowice 2022'}
        self.assertEqual(exact_link_check(valid, event), ([], 'iem_season_venue_year_alias'))
        self.assertEqual(exact_link_check({**valid, 'date_raw': '2023-02-27'}, event)[0],
                         ['outside_event_date_window'])
        self.assertEqual(exact_link_check({**valid, 'event_raw': 'IEM Katowice 2022 Regionals'},
                                          event)[0], ['legacy_event_title_unconfirmed'])
        self.assertEqual(exact_link_check({**valid, 'event_raw': 'StarSeries Asia Qualifier'},
                                          event)[0], ['legacy_event_title_unconfirmed'])
        self.assertIsNone(title_compatibility('IEM Katowice 2022 Qualifier',
                                              event['event_name'], '2022', event['event_url']))

    def test_explicit_alias_requires_pinned_hltv_capture(self):
        event = {'event_name': 'CCT Season 1 Central Europe Malta Finals',
                 'event_url': 'https://liquipedia.net/counterstrike/CCT/Season_1/Central_Europe/Finals/Malta',
                 'page_start_date': '2023-02-16', 'page_end_date': '2023-02-19'}
        record = {'date_raw': '2023-02-16', 'event_raw': 'CCT Central Europe Malta Finals 1'}
        with tempfile.TemporaryDirectory() as tmp:
            reasons, rule = exact_link_check(record, event, Path(tmp))
        self.assertEqual(rule, 'explicit_hltv_map_event_alias:151238')
        self.assertEqual(reasons, ['explicit_alias_evidence_unavailable'])

    def test_result_subpages_accept_same_event_stage_and_reject_cross_event(self):
        event = {'event_url': 'https://liquipedia.net/counterstrike/PGL/2021/Stockholm'}
        wiki = ('{{ShowStandings|page=PGL/2021/Stockholm/Challengers Stage}}'
                '{{ShowStandings|page={{PAGENAME}}/Legends Stage}}'
                '[[PGL/2021/Stockholm/Group Stage|click here]]'
                '{{#lst:PGL/2021/Stockholm/Playoffs|Results}}'
                '{{ShowStandings|page=PGL/2021/Stockholm/Qualifier}}'
                '{{ShowStandings|page=PGL/2022/Stockholm/Finals}}')
        urls, rejected = result_subpages(event, wiki, {'page_title': 'PGL/2021/Stockholm'})
        self.assertEqual(urls, [event['event_url'] + '/' + suffix for suffix in
                                ('Challengers_Stage', 'Group_Stage', 'Legends_Stage', 'Playoffs')])
        self.assertEqual(len(rejected), 2)


if __name__ == '__main__':
    unittest.main()
