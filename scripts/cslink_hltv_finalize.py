#!/usr/bin/env python3
"""Wait for a detached HLTV collection run, then rebuild its local review stage."""

import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import time

from cslink_hltv_stage import stage


ROOT = Path(__file__).resolve().parents[1]
PLAN = ROOT / 'data/cslink/as-tier-event-cover-2026-10-03/selected-series.jsonl'
CAPTURES = ROOT / '.local-data/cslink/hltv-capture'
OUTPUT = ROOT / '.local-data/cslink/hltv-stage'


def process_running(pid):
    result = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'stat='],
                            capture_output=True, text=True)
    return result.returncode == 0 and result.stdout.strip() and not result.stdout.strip().startswith('Z')


def finalize(pid, plan_path, captures_dir, stage_dir, poll_seconds):
    while pid is not None and process_running(pid):
        time.sleep(poll_seconds)
    staged = stage(plan_path, captures_dir, stage_dir)
    collector_report_path = captures_dir / 'report.json'
    collector = json.loads(collector_report_path.read_text()) if collector_report_path.is_file() else None
    full_plan_sha = hashlib.sha256(plan_path.read_bytes()).hexdigest()
    collector_current = bool(collector and collector.get('plan_sha256') == full_plan_sha)
    result = {'finished_at_utc': datetime.now(timezone.utc).isoformat(timespec='seconds'),
              'collector_report_current': collector_current,
              'collector_report': collector if collector_current else None,
              'staging_report': staged,
              'status': ('complete' if collector_current and not collector['stopped'] and
                         staged['missing_maps'] == 0 and staged['invalid_captures'] == 0
                         else 'partial_or_failed')}
    (captures_dir / 'full-batch-final.json').write_text(
        json.dumps(result, ensure_ascii=False, sort_keys=True, indent=2) + '\n')
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pid-file', type=Path, default=CAPTURES / 'full-batch.pid')
    parser.add_argument('--plan', type=Path, default=PLAN)
    parser.add_argument('--captures', type=Path, default=CAPTURES)
    parser.add_argument('--stage-output', type=Path, default=OUTPUT)
    parser.add_argument('--poll-seconds', type=float, default=30.0)
    parser.add_argument('--no-wait', action='store_true',
                        help='Finalize an already finished collection without a PID file')
    args = parser.parse_args()
    if args.poll_seconds <= 0:
        parser.error('--poll-seconds must be positive')
    pid = None if args.no_wait else int(args.pid_file.read_text().strip())
    print(json.dumps(finalize(pid, args.plan, args.captures, args.stage_output,
                              args.poll_seconds), ensure_ascii=False, indent=2))
