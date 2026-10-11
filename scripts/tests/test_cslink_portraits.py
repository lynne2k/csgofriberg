import io
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import Mock
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from cslink_portraits import Collector, choose_portrait, profile_url, verify_image


class PortraitSafetyTests(unittest.TestCase):
    def setUp(self):
        self.player = {'id': 'hltv:3741', 'hltvId': '3741', 'nickname': 'NiKo',
                       'profileUrl': 'https://www.hltv.org/stats/players/3741/niko'}
        self.photo = {'url': 'https://img-cdn.hltv.org/playerbodyshot/sample.png?w=400'}
        self.page = {'url': 'https://www.hltv.org/player/3741/niko', 'profilePresent': True,
                     'nickname': 'NiKo', 'images': [self.photo]}

    def test_nickname_does_not_allow_another_identity_url(self):
        self.assertEqual(profile_url(self.player), self.page['url'])
        with self.assertRaises(ValueError):
            profile_url({**self.player, 'profileUrl': 'https://www.hltv.org/player/10264/niko'})
        status, photo = choose_portrait({**self.page, 'url': 'https://www.hltv.org/player/10264/niko'}, self.player)
        self.assertEqual((status, photo), ('identity_mismatch', None))

    def test_normalized_page_nickname_can_change_without_losing_numeric_identity(self):
        self.assertEqual(choose_portrait({**self.page, 'nickname': 'NewAlias'}, self.player), ('ready', self.photo))

    def test_challenge_cannot_be_mistaken_for_missing_portrait(self):
        self.assertEqual(choose_portrait({'challenge': True, 'images': []}, self.player), ('verification_pending', None))
        self.assertEqual(choose_portrait({**self.page, 'profilePresent': False}, self.player), ('profile_unavailable', None))

    def test_logo_or_placeholder_is_not_a_portrait(self):
        for url in ['https://img-cdn.hltv.org/teamlogo/sample.png',
                    'https://example.com/playerbodyshot/sample.png',
                    'https://img-cdn.hltv.org/playerbodyshot/placeholder.png']:
            self.assertEqual(choose_portrait({**self.page, 'images': [{'url': url}]}, self.player), ('no_portrait', None))

    def test_responsive_duplicate_is_one_photo_but_two_distinct_photos_are_ambiguous(self):
        self.assertEqual(choose_portrait({**self.page, 'images': [self.photo, self.photo]}, self.player), ('ready', self.photo))
        self.assertEqual(choose_portrait({**self.page, 'images': [self.photo,
            {'url': 'https://img-cdn.hltv.org/playerbodyshot/second.png'}]}, self.player), ('ambiguous_portrait', None))

    def test_rejects_non_image_and_truncated_png(self):
        with self.assertRaises(Exception):
            verify_image(b'<html>security verification</html>')
        stream = io.BytesIO()
        Image.new('RGBA', (100, 120)).save(stream, format='PNG')
        raw = stream.getvalue()
        self.assertEqual((verify_image(raw)['width'], verify_image(raw)['height']), (100, 120))
        with self.assertRaises(Exception):
            verify_image(raw[:40])

    def recovery_collector(self, results):
        collector = Collector.__new__(Collector)
        collector.args = SimpleNamespace(verification_recoveries=2, verification_cooldown=300)
        collector.collect = Mock(side_effect=results)
        collector.store_record = Mock()
        collector.event = Mock()
        collector.checkpoint = Mock()
        collector.delay = Mock()
        collector.next_retry_at = None
        return collector

    def test_verification_recovers_same_player_after_cooldown(self):
        pending = {'status': 'verification_pending'}
        success = {'status': 'downloaded'}
        collector = self.recovery_collector([pending, success])
        self.assertEqual(collector.collect_with_recovery(self.player), success)
        self.assertEqual(collector.collect.call_count, 2)
        collector.delay.assert_called_once_with(300)
        collector.store_record.assert_called_once_with('3741', pending)
        self.assertIsNone(collector.next_retry_at)

    def test_persistent_verification_has_bounded_retries(self):
        pending = {'status': 'verification_pending'}
        collector = self.recovery_collector([pending, pending, pending])
        self.assertEqual(collector.collect_with_recovery(self.player), pending)
        self.assertEqual(collector.collect.call_count, 3)
        self.assertEqual(collector.delay.call_count, 2)

    def test_missing_portrait_is_not_repeated_as_verification(self):
        collector = self.recovery_collector([{'status': 'no_portrait'}])
        self.assertEqual(collector.collect_with_recovery(self.player), {'status': 'no_portrait'})
        collector.delay.assert_not_called()


if __name__ == '__main__':
    unittest.main()
