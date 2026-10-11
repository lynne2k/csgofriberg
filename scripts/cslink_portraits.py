#!/usr/bin/env python3
"""Resumable personal HLTV portrait capture through the installed OpenCLI bridge."""
import argparse
from collections import Counter
from datetime import datetime, timezone
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import time
from urllib.error import HTTPError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PLAN = ROOT / '.local-data/cslink/portrait-pilot-2026-10-10/photo-candidates.json'
DEFAULT_OUTPUT = ROOT / '.local-data/cslink/player-portraits-v1'
NODE = ROOT / '.local-tools/node-v26.7.0-darwin-arm64/bin/node'
OPENCLI = ROOT / '.local-tools/opencli/node_modules/@jackwener/opencli/dist/src/main.js'
SESSION = 'cslink-portraits-batch'
MAX_BYTES = 8_000_000

# Only the observed profile's own portrait is eligible. Never choose another
# player's photo from recent matches, related players, advertisements, or teams.
EXTRACT = r'''(() => {
  const profile = document.querySelector('.playerProfile');
  const nickname = document.querySelector('.playerNickname')?.textContent?.trim() || '';
  const text = document.body?.innerText || '';
  const challenge = /just a moment|security verification|verify you are human|checking your browser|attention required/i.test(document.title + '\n' + text.slice(0, 1200));
  return {url: location.href, title: document.title, profilePresent: !!profile,
    nickname, fullName: document.querySelector('.playerRealname')?.textContent?.trim() || null,
    challenge, challengeText: challenge ? text.slice(0, 900) : null,
    images: [...(profile?.querySelectorAll('img') || [])]
      .filter(i => i.className.includes('bodyshot') || (i.currentSrc || i.src).includes('/playerbodyshot/'))
      .map(i => ({alt: i.alt, className: i.className, url: i.currentSrc || i.src,
        width: i.naturalWidth, height: i.naturalHeight}))};
})()'''


def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def write_json(path, value):
    temp = path.with_suffix(path.suffix + '.tmp')
    temp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')
    temp.replace(path)


def profile_url(player):
    if not re.fullmatch(r'[1-9]\d*', str(player['hltvId'])) or player['id'] != f"hltv:{player['hltvId']}":
        raise ValueError('invalid_hltv_identity')
    parts = urlsplit(player['profileUrl'])
    pattern = rf'/(?:stats/players|player)/{player["hltvId"]}/[^/?#]+'
    if (parts.scheme != 'https' or parts.netloc != 'www.hltv.org' or
            not re.fullmatch(pattern, parts.path) or parts.query or parts.fragment):
        raise ValueError('profile_url_identity_mismatch')
    return 'https://www.hltv.org' + parts.path.replace('/stats/players/', '/player/')


def choose_portrait(page, player):
    if page.get('challenge'):
        return 'verification_pending', None
    expected = rf'https://www\.hltv\.org/player/{player["hltvId"]}/[^/?#]+'
    if not re.fullmatch(expected, page.get('url', '')):
        return 'identity_mismatch', None
    if not page.get('profilePresent') or not page.get('nickname'):
        return 'profile_unavailable', None
    eligible = {}
    for photo in page.get('images', []):
        parts = urlsplit(photo.get('url', ''))
        if (parts.scheme == 'https' and parts.netloc == 'img-cdn.hltv.org' and
                parts.path.startswith('/playerbodyshot/') and
                not re.search(r'(?:unknown|placeholder|blank|silhouette)', parts.path, re.I)):
            eligible[photo['url']] = photo
    if not eligible:
        return 'no_portrait', None
    if len(eligible) != 1:
        return 'ambiguous_portrait', None
    return 'ready', next(iter(eligible.values()))


def verify_image(raw):
    if len(raw) > MAX_BYTES:
        raise ValueError('image_too_large')
    with Image.open(io.BytesIO(raw)) as image:
        width, height = image.size
        fmt = image.format
        if width < 64 or height < 64 or width * height > 20_000_000:
            raise ValueError('unexpected_image_dimensions')
        if fmt not in ('PNG', 'JPEG', 'WEBP'):
            raise ValueError('unexpected_image_format')
        image.verify()
    return {'width': width, 'height': height,
            'extension': {'PNG': 'png', 'JPEG': 'jpg', 'WEBP': 'webp'}[fmt],
            'bytes': len(raw), 'sha256': digest(raw)}


class Collector:
    def __init__(self, args):
        self.args = args
        self.output = args.output.resolve()
        self.output.mkdir(parents=True, exist_ok=True)
        self.lock = (self.output / 'run.lock').open('a+')
        fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        for folder in ('images', 'records', 'observations'):
            (self.output / folder).mkdir(exist_ok=True)
        raw = args.plan.read_bytes()
        plan = json.loads(raw)
        self.players = plan['players']
        self.by_id = {str(p['hltvId']): p for p in self.players}
        if len(self.by_id) != len(self.players) or len(self.players) != plan['total']:
            raise ValueError('duplicate_or_incorrect_plan_count')
        for player in self.players:
            profile_url(player)
        manifest = {'planSha256': digest(raw), 'dataVersion': plan['dataVersion'], 'total': len(self.players)}
        manifest_path = self.output / 'manifest.json'
        if manifest_path.exists() and json.loads(manifest_path.read_text()) != manifest:
            raise ValueError('output_bound_to_different_plan')
        write_json(manifest_path, manifest)
        (self.output / 'photo-candidates.json').write_bytes(raw)
        self.manifest = manifest
        self.records = {}
        for path in (self.output / 'records').glob('*.json'):
            record = json.loads(path.read_text())
            pid = path.stem
            if pid not in self.by_id or record['id'] != f'hltv:{pid}':
                raise ValueError('record_identity_mismatch')
            if record['status'] == 'downloaded':
                image = self.output / record['imageFile']
                if not image.is_file() or digest(image.read_bytes()) != record['sha256']:
                    record = {**record, 'status': 'cache_invalid'}
            self.records[pid] = record
        self.started = time.monotonic()
        self.started_at = now()
        self.attempted = 0
        self.saved = 0
        self.stop_requested = False
        self.last_navigation = 0
        self.current_player = None
        self.next_retry_at = None
        self.phase = 'starting'
        self.state = 'running'
        self.initial_downloaded = sum(r['status'] == 'downloaded' for r in self.records.values())
        self.bridge_env = dict(os.environ, OPENCLI_WINDOW='background',
                               OPENCLI_BROWSER_CONNECT_TIMEOUT='15', OPENCLI_BROWSER_COMMAND_TIMEOUT='40')
        for sig in (signal.SIGINT, signal.SIGTERM):
            signal.signal(sig, lambda *_: setattr(self, 'stop_requested', True))

    def event(self, event, **fields):
        row = {'at': now(), 'event': event, **fields}
        with (self.output / 'attempts.jsonl').open('a') as log:
            log.write(json.dumps(row, ensure_ascii=False) + '\n')
        print(json.dumps(row, ensure_ascii=False), flush=True)

    def checkpoint(self):
        counts = Counter(record['status'] for record in self.records.values())
        resolved = counts['downloaded'] + counts['no_portrait']
        processed = sum(counts.values())
        elapsed = round(time.monotonic() - self.started, 1)
        rate = self.attempted / elapsed if elapsed and self.attempted else None
        report = {**self.manifest, 'pid': os.getpid(), 'session': SESSION,
                  'startedAt': self.started_at, 'updatedAt': now(), 'state': self.state,
                  'phase': self.phase, 'currentPlayer': self.current_player,
                  'nextRetryAt': self.next_retry_at,
                  'counts': dict(counts), 'downloaded': counts['downloaded'],
                  'withoutPortrait': counts['no_portrait'], 'resolved': resolved,
                  'processed': processed, 'notYetAttempted': len(self.players) - processed,
                  'unresolved': len(self.players) - resolved, 'elapsedSecondsThisRun': elapsed,
                  'attemptedThisRun': self.attempted, 'downloadedThisRun': self.saved,
                  'estimatedRemainingSeconds': round((len(self.players) - resolved) / rate) if rate else None,
                  'intervalSeconds': self.args.interval, 'verificationPolicy': 'wait_retry_then_cooldown',
                  'verificationCooldownSeconds': self.args.verification_cooldown,
                  'verificationRecoveries': self.args.verification_recoveries}
        write_json(self.output / 'status.json', report)
        (self.output / 'PROGRESS.md').write_text(
            '# HLTV 选手定妆照抓取进度\n\n'
            f'- 更新：{report["updatedAt"]}\n- 任务状态：{self.state} / {self.phase}\n'
            f'- 总队列：{len(self.players)} 个 HLTV 编号\n- 已下载：{counts["downloaded"]}\n'
            f'- 页面没有定妆照：{counts["no_portrait"]}\n- 尚待处理或重试：{report["unresolved"]}\n'
            f'- 当前选手：{self.current_player}\n\n'
            f'- 下次自动重试：{self.next_retry_at or "无待定重试"}\n\n'
            '照片保存在 `images/`，身份、图片 URL、来源页面和校验值在 `records/`。'
            '成功记录会跳过；自动验证等待、重试后会冷却再试，持续失败时保留页面供检查。\n')

    def bridge(self, *args, timeout=50):
        command = [str(NODE), str(OPENCLI), 'browser', SESSION, *args]
        start = time.monotonic()
        result = subprocess.run(command, capture_output=True, text=True, env=self.bridge_env, timeout=timeout)
        if result.returncode:
            raise RuntimeError((result.stderr or result.stdout).strip()[:900])
        return result.stdout, round(time.monotonic() - start, 3)

    def delay(self, seconds):
        end = time.monotonic() + seconds
        while time.monotonic() < end and not self.stop_requested:
            time.sleep(min(1, max(0, end - time.monotonic())))
        if self.stop_requested:
            raise InterruptedError('stop_requested')

    def inspect(self):
        raw, _ = self.bridge('eval', EXTRACT, timeout=20)
        return json.loads(raw)

    def store_record(self, pid, record):
        self.records[pid] = record
        write_json(self.output / 'records' / f'{pid}.json', record)

    def seed_pilot(self):
        pilot = ROOT / '.local-data/cslink/portrait-pilot-2026-10-10/retry/pilot-report.json'
        if not pilot.exists() or self.records.get('3741', {}).get('status') == 'downloaded':
            return
        record = json.loads(pilot.read_text())
        if record['id'] != 'hltv:3741' or record.get('status') != 'downloaded':
            raise ValueError('invalid_pilot_identity')
        raw = Path(record['downloadedFile']).read_bytes()
        info = verify_image(raw)
        if info['sha256'] != record['sha256']:
            raise ValueError('pilot_image_changed')
        target = self.output / 'images' / '3741.png'
        target.write_bytes(raw)
        self.store_record('3741', {**record, **info, 'imageFile': 'images/3741.png', 'seededFromPilot': True})
        self.event('pilot_reused', id='hltv:3741')

    def collect(self, player):
        pid = str(player['hltvId'])
        url = profile_url(player)
        start = time.monotonic()
        page, status, photo = {}, 'profile_unavailable', None
        for attempt in range(self.args.retries + 1):
            if attempt:
                self.phase = 'retry_backoff'
                self.checkpoint()
                self.delay(12 * attempt)
            self.delay(max(0, self.args.interval - (time.monotonic() - self.last_navigation)))
            self.phase = 'opening_profile'
            self.checkpoint()
            self.last_navigation = time.monotonic()
            self.bridge('open', url)
            self.phase = 'reading_profile'
            page = self.inspect()
            status, photo = choose_portrait(page, player)
            if status in ('verification_pending', 'profile_unavailable'):
                self.phase = 'waiting_automatic_verification' if page.get('challenge') else 'waiting_profile'
                self.checkpoint()
                deadline = time.monotonic() + self.args.verification_wait
                while status in ('verification_pending', 'profile_unavailable') and time.monotonic() < deadline:
                    self.delay(min(5, max(0, deadline - time.monotonic())))
                    page = self.inspect()
                    status, photo = choose_portrait(page, player)
            self.event('page_result', id=player['id'], attempt=attempt + 1, status=status)
            if status not in ('verification_pending', 'profile_unavailable'):
                break
        write_json(self.output / 'observations' / f'{pid}.json', page)
        record = {**player, 'profileUrl': url, 'observedAt': now(), 'observedNickname': page.get('nickname'),
                  'fullName': page.get('fullName'), 'status': status,
                  'elapsedSeconds': round(time.monotonic() - start, 3)}
        if status != 'ready':
            return record
        self.phase = 'downloading_portrait'
        self.checkpoint()
        download_start = time.monotonic()
        request = Request(photo['url'], headers={'User-Agent': 'CSLinkPersonalPortraits/1.0', 'Referer': url})
        with urlopen(request, timeout=30) as response:
            raw = response.read(MAX_BYTES + 1)
            content_type = response.headers.get('Content-Type', '')
            if response.status != 200 or not content_type.lower().startswith('image/'):
                raise ValueError('unexpected_download_response')
        info = verify_image(raw)
        target = self.output / 'images' / f'{pid}.{info["extension"]}'
        temp = target.with_suffix('.tmp')
        temp.write_bytes(raw)
        temp.replace(target)
        self.saved += 1
        return {**record, **info, 'status': 'downloaded', 'imageFile': str(target.relative_to(self.output)),
                'sourceImageUrl': photo['url'], 'mimeType': content_type,
                'elapsedSeconds': round(time.monotonic() - start, 3),
                'downloadSeconds': round(time.monotonic() - download_start, 3)}

    def collect_with_recovery(self, player):
        for recovery in range(self.args.verification_recoveries + 1):
            result = self.collect(player)
            if result['status'] != 'verification_pending' or recovery == self.args.verification_recoveries:
                return result
            self.store_record(str(player['hltvId']), result)
            self.phase = 'verification_cooldown'
            self.next_retry_at = datetime.fromtimestamp(
                time.time() + self.args.verification_cooldown, timezone.utc).isoformat(timespec='seconds')
            self.event('verification_cooldown', id=player['id'], recovery=recovery + 1,
                       seconds=self.args.verification_cooldown, nextRetryAt=self.next_retry_at)
            self.checkpoint()
            try:
                self.delay(self.args.verification_cooldown)
            finally:
                self.next_retry_at = None

    def run(self):
        self.seed_pilot()
        self.checkpoint()
        consecutive_failures = 0
        preserve_session = False
        try:
            for player in self.players:
                pid = str(player['hltvId'])
                if self.records.get(pid, {}).get('status') in ('downloaded', 'no_portrait'):
                    continue
                if self.args.limit and self.attempted >= self.args.limit:
                    self.state = 'batch_limit_reached'
                    break
                if self.stop_requested:
                    raise InterruptedError('stop_requested')
                self.current_player = {'id': player['id'], 'nickname': player['nickname']}
                try:
                    result = self.collect_with_recovery(player)
                except (RuntimeError, ValueError, subprocess.TimeoutExpired, OSError) as error:
                    if isinstance(error, InterruptedError):
                        raise
                    result = {**player, 'status': 'request_failed', 'observedAt': now(), 'error': str(error)[:900]}
                    if isinstance(error, HTTPError):
                        result['httpStatus'] = error.code
                self.attempted += 1
                self.store_record(pid, result)
                self.event('player_result', id=player['id'], nickname=player['nickname'],
                           status=result['status'], elapsedSeconds=result.get('elapsedSeconds'))
                self.phase = 'between_players'
                self.checkpoint()
                if result['status'] == 'verification_pending':
                    self.state = 'needs_browser_verification'
                    preserve_session = True
                    break
                consecutive_failures = 0 if result['status'] in ('downloaded', 'no_portrait') else consecutive_failures + 1
                if consecutive_failures >= 3:
                    self.state = 'needs_inspection'
                    preserve_session = True
                    break
            else:
                self.state = 'completed' if all(r['status'] in ('downloaded', 'no_portrait')
                    for r in self.records.values()) else 'completed_with_failures'
        except InterruptedError:
            self.state = 'stopped_resumable'
        except Exception:
            self.state = 'failed_resumable'
            raise
        finally:
            self.phase = 'idle'
            self.checkpoint()
            if not preserve_session:
                try:
                    self.bridge('close', timeout=15)
                except Exception:
                    pass
            self.event('run_end', state=self.state, attempted=self.attempted, downloaded=self.saved)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path, default=DEFAULT_PLAN)
    parser.add_argument('--output', type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument('--interval', type=float, default=8, help='Minimum seconds between profile navigations')
    parser.add_argument('--verification-wait', type=float, default=25)
    parser.add_argument('--retries', type=int, default=1)
    parser.add_argument('--verification-cooldown', type=float, default=300,
                        help='Pause all requests before recovering from persistent automatic verification')
    parser.add_argument('--verification-recoveries', type=int, default=2)
    parser.add_argument('--limit', type=int, default=0, help='Maximum new attempts; 0 means the full queue')
    parser.add_argument('--status', action='store_true')
    args = parser.parse_args()
    if args.status:
        print((args.output / 'status.json').read_text())
        return
    if (args.interval < 0 or args.verification_wait < 0 or args.retries not in range(4) or args.limit < 0
            or args.verification_cooldown < 0 or args.verification_recoveries not in range(4)):
        parser.error('invalid interval, wait, retries, or limit')
    Collector(args).run()


if __name__ == '__main__':
    main()
