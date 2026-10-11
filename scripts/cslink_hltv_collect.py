#!/usr/bin/env python3
"""Collect selected HLTV map rosters through an already connected OpenCLI browser.

Sequential, resumable, bounded retries. Outputs remain local and unreviewed.
The operator is responsible for the permitted scope of use.
"""

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import subprocess
import time
from urllib.parse import urlsplit

from cslink_roster_pilot import validate_capture


ROOT = Path(__file__).resolve().parents[1]
PLAN = ROOT / 'data/cslink/as-tier-event-cover-2026-10-03/pilot-sample.jsonl'
OUTPUT = ROOT / '.local-data/cslink/hltv-capture'
OPENCLI = ROOT / '.local-tools/opencli/node_modules/.bin/opencli'
TRACE_ROOT = Path.home() / '.opencli/profiles/default/traces'


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds')


def append_jsonl(path, row):
    with path.open('a', encoding='utf-8') as handle:
        handle.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + '\n')
        handle.flush()


def cached_capture(path, row):
    if not path.is_file():
        return None
    raw = path.read_bytes()
    data = json.loads(raw)
    validate_capture(data, row['selected_mapstatsid'])
    expected = {'source_url': row['hltv_map_url'], 'event_url': row['event_url'],
                'hltv_series_id_from_liquipedia': row['hltv_series_id'],
                'source_revision_sha256': row['source_revision_sha256']}
    if any(data.get(key) != value for key, value in expected.items()):
        raise ValueError('Cached capture provenance disagrees with plan')
    return hashlib.sha256(raw).hexdigest()


def trace_rejected_target(output, source_url, trace_root=TRACE_ROOT):
    """Read only the target request status from an OpenCLI failure trace."""
    match = re.search(r'(?m)^\s*traceId:\s*([A-Za-z0-9-]+)\s*$', output)
    if not match:
        return False
    network = trace_root / match.group(1) / 'network.jsonl'
    if not network.is_file():
        return False
    with network.open(encoding='utf-8') as handle:
        for line in handle:
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(row, dict) or row.get('url') != source_url:
                continue
            raw_headers = row.get('responseHeaders')
            headers = {str(key).lower(): str(value).lower()
                       for key, value in raw_headers.items()} if isinstance(raw_headers, dict) else {}
            if row.get('status') in (403, 429) or headers.get('cf-mitigated') == 'challenge':
                return True
    return False


def classify_failure(returncode, stderr, stdout, source_url=None):
    text = (stderr + '\n' + stdout).lower()
    if source_url and trace_rejected_target(stderr + '\n' + stdout, source_url):
        return 'source_access_rejected'
    if 'navigation rejected' in text or 'browser_connect' in text:
        return 'browser_navigation'
    if any(term in text for term in ('403', '429', 'captcha', 'access denied', 'verify you are human',
                                    'unusual traffic', 'too many requests')):
        return 'source_access_rejected'
    if returncode == -1 or ('timed out' in text and returncode == 75):
        return 'command_timeout'
    return 'command_error'


def validate_source_url(url, map_id):
    """Accept only a direct HLTV map route for the selected numeric map ID."""
    parts = urlsplit(url)
    if (parts.scheme != 'https' or parts.netloc != 'www.hltv.org' or
            not re.fullmatch(rf'/stats/matches/mapstatsid/{map_id}/[a-z0-9-]+', parts.path) or
            parts.query or parts.fragment):
        raise ValueError(f'Unexpected source URL in queue: {url}')


def collect(plan_path, output_dir, opencli, limit, interval, retries, timeout,
            max_consecutive_failures=3):
    if not opencli.is_file():
        raise FileNotFoundError(f'OpenCLI binary not found: {opencli}')
    plan_raw = plan_path.read_bytes()
    rows = [json.loads(line) for line in plan_raw.splitlines() if line.strip()]
    ids = [row['selected_mapstatsid'] for row in rows]
    if len(ids) != len(set(ids)):
        raise ValueError('Duplicate selected map ID in queue')
    if limit is not None:
        rows = rows[:limit]
    output_dir.mkdir(parents=True, exist_ok=True)
    log_path = output_dir / 'attempts.jsonl'
    counts = {'planned': len(rows), 'cached': 0, 'captured': 0, 'failed': 0, 'stopped': False}
    last_started = None
    consecutive_failures = 0
    for row in rows:
        map_id = row['selected_mapstatsid']
        url = row['hltv_map_url']
        validate_source_url(url, map_id)
        target = output_dir / f'{map_id}.json'
        try:
            existing_sha = cached_capture(target, row)
        except (ValueError, json.JSONDecodeError) as exc:
            entry = {'at_utc': utc_now(), 'mapstatsid': map_id,
                     'hltv_series_id': row['hltv_series_id'], 'attempt': 0,
                     'elapsed_seconds': 0, 'returncode': None,
                     'source_url': url, 'status': 'cached_provenance_conflict',
                     'error': str(exc)[:350]}
            append_jsonl(log_path, entry)
            counts['failed'] += 1
            print(json.dumps(entry, ensure_ascii=False), flush=True)
            continue
        if existing_sha:
            counts['cached'] += 1
            consecutive_failures = 0
            continue
        for attempt in range(1, retries + 2):
            if last_started is not None:
                time.sleep(max(0, interval - (time.monotonic() - last_started)))
            command = [str(opencli), 'hltv', 'match-map', url, '-f', 'json',
                       '--trace', 'retain-on-failure', '--window', 'background']
            last_started = time.monotonic()
            start = last_started
            try:
                result = subprocess.run(command, capture_output=True, text=True, timeout=timeout)
                returncode, stdout, stderr = result.returncode, result.stdout, result.stderr
            except subprocess.TimeoutExpired as exc:
                returncode = -1
                stdout = exc.stdout.decode(errors='replace') if isinstance(exc.stdout, bytes) else (exc.stdout or '')
                stderr = exc.stderr.decode(errors='replace') if isinstance(exc.stderr, bytes) else (exc.stderr or '')
            elapsed = round(time.monotonic() - start, 3)
            entry = {'at_utc': utc_now(), 'mapstatsid': map_id,
                     'hltv_series_id': row['hltv_series_id'], 'attempt': attempt,
                     'elapsed_seconds': elapsed, 'returncode': returncode,
                     'source_url': url}
            if returncode == 0:
                try:
                    parsed = json.loads(stdout)
                    data = {'source_url': url, 'rows': parsed,
                            'captured_at_utc': entry['at_utc'],
                            'event_url': row['event_url'],
                            'hltv_series_id_from_liquipedia': row['hltv_series_id'],
                            'source_revision_sha256': row['source_revision_sha256'],
                            'roster_status': 'unreviewed',
                            'authorization_status': 'user_reported_admin_permission_personal_project',
                            'eligible_for_questions': False}
                    validate_capture(data, map_id)
                except (ValueError, TypeError, json.JSONDecodeError) as exc:
                    (output_dir / f'{map_id}.invalid.stdout').write_text(stdout)
                    (output_dir / f'{map_id}.invalid.stderr').write_text(stderr)
                    entry.update({'status': 'validation_failed', 'error': str(exc)[:350]})
                    append_jsonl(log_path, entry)
                    counts['failed'] += 1
                    break
                raw = (json.dumps(data, ensure_ascii=False, sort_keys=True, indent=2) + '\n').encode()
                temp = output_dir / f'.{map_id}.tmp'
                temp.write_bytes(raw)
                temp.replace(target)
                entry.update({'status': 'captured', 'capture_sha256': hashlib.sha256(raw).hexdigest(),
                              'player_rows': len(parsed)})
                append_jsonl(log_path, entry)
                counts['captured'] += 1
                consecutive_failures = 0
                print(json.dumps(entry, ensure_ascii=False), flush=True)
                break
            failure = classify_failure(returncode, stderr, stdout, url)
            entry.update({'status': failure, 'error': (stderr or stdout).strip()[:350]})
            append_jsonl(log_path, entry)
            print(json.dumps(entry, ensure_ascii=False), flush=True)
            if failure == 'source_access_rejected':
                counts['failed'] += 1
                counts['stopped'] = True
                break
            if attempt == retries + 1:
                counts['failed'] += 1
        if counts['stopped']:
            break
        if not target.exists():
            consecutive_failures += 1
            if consecutive_failures >= max_consecutive_failures:
                counts['stopped'] = True
                print(f'Stopping after {consecutive_failures} consecutive failed maps', flush=True)
                break
    report = {**counts, 'plan_path': str(plan_path),
              'plan_sha256': hashlib.sha256(plan_raw).hexdigest(),
              'output_dir': str(output_dir), 'at_utc': utc_now(),
              'authorization_status': 'user_reported_admin_permission_personal_project',
              'question_eligibility': False}
    (output_dir / 'report.json').write_text(json.dumps(report, ensure_ascii=False, sort_keys=True, indent=2) + '\n')
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path, default=PLAN)
    parser.add_argument('--output', type=Path, default=OUTPUT)
    parser.add_argument('--opencli', type=Path, default=OPENCLI)
    parser.add_argument('--limit', type=int)
    parser.add_argument('--interval', type=float, default=10.0, help='Minimum seconds between request starts')
    parser.add_argument('--retries', type=int, default=1, help='Extra tries for non-access failures')
    parser.add_argument('--timeout', type=float, default=70.0)
    parser.add_argument('--max-consecutive-failures', type=int, default=3)
    args = parser.parse_args()
    if (args.interval < 0 or args.retries < 0 or args.timeout <= 0 or args.max_consecutive_failures < 1 or
            (args.limit is not None and args.limit < 0)):
        parser.error('Interval, retries, limit and timeout must be nonnegative')
    print(json.dumps(collect(args.plan, args.output, args.opencli, args.limit,
                             args.interval, args.retries, args.timeout,
                             args.max_consecutive_failures), ensure_ascii=False, indent=2))
