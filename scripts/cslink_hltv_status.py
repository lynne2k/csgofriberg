#!/usr/bin/env python3
"""Show live coverage and failures for the local HLTV capture queue."""

import argparse
from collections import Counter
import json
from pathlib import Path
import subprocess

from cslink_roster_pilot import validate_capture


ROOT = Path(__file__).resolve().parents[1]
PLAN = ROOT / 'data/cslink/as-tier-event-cover-2026-10-03/selected-series.jsonl'
CAPTURES = ROOT / '.local-data/cslink/hltv-capture'


def status(plan_path, captures_dir):
    rows = [json.loads(line) for line in plan_path.read_text().splitlines() if line.strip()]
    valid = 0
    invalid = []
    for row in rows:
        map_id = row['selected_mapstatsid']
        path = captures_dir / f'{map_id}.json'
        if not path.is_file():
            continue
        try:
            validate_capture(json.loads(path.read_bytes()), map_id)
            valid += 1
        except (ValueError, TypeError, json.JSONDecodeError) as exc:
            invalid.append({'mapstatsid': map_id, 'reason': str(exc)[:200]})
    attempts_path = captures_dir / 'attempts.jsonl'
    attempts = [json.loads(line) for line in attempts_path.read_text().splitlines() if line.strip()] if attempts_path.is_file() else []
    pid_path = captures_dir / 'full-batch.pid'
    pid = int(pid_path.read_text()) if pid_path.is_file() else None
    running = False
    if pid:
        result = subprocess.run(['/bin/ps', '-p', str(pid), '-o', 'stat='], capture_output=True, text=True)
        running = result.returncode == 0 and bool(result.stdout.strip()) and not result.stdout.strip().startswith('Z')
    final_path = captures_dir / 'full-batch-final.json'
    final = json.loads(final_path.read_text()) if final_path.is_file() else None
    return {'planned_maps': len(rows), 'captured_valid_maps': valid,
            'remaining_maps': len(rows) - valid - len(invalid),
            'invalid_captures': invalid, 'attempt_status_counts': dict(Counter(x['status'] for x in attempts)),
            'last_attempt': attempts[-1] if attempts else None,
            'full_batch_pid': pid, 'full_batch_running': running,
            'final_status': final['status'] if final else None}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--plan', type=Path, default=PLAN)
    parser.add_argument('--captures', type=Path, default=CAPTURES)
    args = parser.parse_args()
    print(json.dumps(status(args.plan, args.captures), ensure_ascii=False, indent=2))
