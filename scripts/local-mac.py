#!/usr/bin/env python3
"""Project-local macOS runtime and service launcher (Python 3.12+)."""
import hashlib
import json
import os
from pathlib import Path
import platform
import signal
import socket
import subprocess
import sys
import tarfile
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
TOOLS, DATA, LOGS = (ROOT / name for name in ('.local-tools', '.local-data', '.local-logs'))
NODE_VERSION = (ROOT / '.node-version').read_text().strip().removeprefix('v')
ARCH = 'arm64' if platform.machine() == 'arm64' else 'x64'
NODE_DIR = TOOLS / f'node-v{NODE_VERSION}-darwin-{ARCH}'
NODE = NODE_DIR / 'bin/node'
PNPM = TOOLS / 'pnpm/node_modules/pnpm/bin/pnpm.cjs'
REDIS_VERSION = '7.4.7'
REDIS = TOOLS / f'redis-{REDIS_VERSION}/src/redis-server'
REDIS_PORT = 16379


def run(args, *, env=None, cwd=ROOT):
    subprocess.run([str(x) for x in args], cwd=cwd, env=env, check=True)


def environment():
    env = os.environ.copy()
    env['PATH'] = f'{NODE_DIR / "bin"}:{TOOLS / "pnpm/node_modules/.bin"}:{env["PATH"]}'
    secret = DATA / 'jwt-secret.txt'
    if not secret.exists():
        with secret.open('x') as handle:
            os.chmod(secret, 0o600)
            handle.write(os.urandom(48).hex())
    env.update({
        'NODE_ENV': 'development', 'DB_CLIENT': 'sqlite',
        'DB_URL': str(DATA / 'development.sqlite3'),
        'REDIS_URL': f'redis://127.0.0.1:{REDIS_PORT}',
        'REDIS_PREFIX': 'csgofriberg-mac:', 'REDIS_REQUIRED': 'true',
        'PORT': '3000', 'JWT_SECRET': secret.read_text().strip(),
        'CORS_ORIGINS': 'http://localhost:5173,http://127.0.0.1:5173,http://localhost:3000,http://127.0.0.1:3000',
        'UMAMI_WEBSITE_ID': '',
    })
    # 通过 Cloudflare Tunnel 分享时，放行公网来源并信任一层代理的 X-Forwarded-For
    public_origin = os.environ.get('CSLINK_PUBLIC_ORIGIN', '').strip().rstrip('/')
    if public_origin:
        if not public_origin.startswith('https://'):
            raise RuntimeError('CSLINK_PUBLIC_ORIGIN must start with https://')
        env['CORS_ORIGINS'] += ',' + public_origin
        env['TRUST_PROXY'] = 'true'
    review_config = ROOT / 'data/cslink/local-review.json'
    if review_config.exists():
        version = json.loads(review_config.read_text())['version']
        if len(version) != 20 or any(c not in '0123456789abcdef' for c in version):
            raise RuntimeError('Invalid CS Link review version')
        env['CSLINK_REVIEW_VERSION_DIR'] = str(DATA / 'cslink/versions' / version)
    candidate_dir = DATA / 'cslink/candidate-library-v1'
    if (candidate_dir / 'manifest.json').exists():
        env['CSLINK_CANDIDATE_VERSION_DIR'] = str(candidate_dir)
    play_dir = DATA / 'cslink/as-tier-local-play-v1'
    if (play_dir / 'manifest.json').exists():
        env['CSLINK_PLAY_PROJECTION_DIR'] = str(play_dir)
    legacy_dir = DATA / 'cslink/legacy-relations-v1'
    if (legacy_dir / 'graph.json').exists():
        env['CSLINK_LEGACY_RELATIONS_DIR'] = str(legacy_dir)
    portrait_dir = DATA / 'cslink/player-portraits-v1/images'
    env.setdefault('SOCKET_MAX_CONNECTIONS_PER_IDENTITY', '32')
    if portrait_dir.is_dir():
        env['CSLINK_PORTRAIT_DIR'] = str(portrait_dir)
    active_ids = ROOT / 'client/public/cslink/data/active-ids.json'
    if active_ids.is_file():
        env['CSLINK_ACTIVE_IDS_FILE'] = str(active_ids)
    for historical_base in (DATA / 'cslink/historical-as-batch-v1/current',
                            DATA / 'cslink/historical-as-v1'):
        # Resolve a moving `current` symlink once so both inputs come from the
        # same immutable snapshot if a new batch is published during startup.
        historical_base = historical_base.resolve()
        historical_candidate_dir = historical_base / 'library'
        historical_play_dir = historical_base / 'play'
        if ((historical_candidate_dir / 'manifest.json').exists() and
                (historical_play_dir / 'manifest.json').exists()):
            env['CSLINK_HISTORICAL_CANDIDATE_DIR'] = str(historical_candidate_dir)
            env['CSLINK_HISTORICAL_PLAY_PROJECTION_DIR'] = str(historical_play_dir)
            break
    return env


def pnpm(args, env):
    run([NODE, PNPM, *args], env=env)


def setup(env):
    downloads = TOOLS / 'downloads'
    downloads.mkdir(exist_ok=True)
    if not NODE.exists():
        name = f'node-v{NODE_VERSION}-darwin-{ARCH}.tar.gz'
        base = f'https://nodejs.org/dist/v{NODE_VERSION}/'
        archive = downloads / name
        urllib.request.urlretrieve(base + name, archive)
        checksums = urllib.request.urlopen(base + 'SHASUMS256.txt', timeout=30).read().decode()
        expected = next(line.split()[0] for line in checksums.splitlines() if line.split()[-1] == name)
        if hashlib.sha256(archive.read_bytes()).hexdigest() != expected:
            raise RuntimeError('Node archive checksum mismatch')
        with tarfile.open(archive) as bundle:
            bundle.extractall(TOOLS, filter='data')
    if not PNPM.exists():
        version = json.loads((ROOT / 'package.json').read_text())['packageManager'].split('@')[1]
        run([NODE_DIR / 'bin/npm', 'install', '--prefix', TOOLS / 'pnpm', f'pnpm@{version}',
             '--ignore-scripts', '--no-audit', '--no-fund'], env=env)
    if not REDIS.exists():
        archive = downloads / f'redis-{REDIS_VERSION}.tar.gz'
        urllib.request.urlretrieve(f'https://download.redis.io/releases/{archive.name}', archive)
        with tarfile.open(archive) as bundle:
            bundle.extractall(TOOLS, filter='data')
        run(['make', '-C', REDIS.parents[1], '-j4', 'BUILD_TLS=no'], env=env)
    pnpm(['install', '--frozen-lockfile'], env)
    run([NODE, '-e', "const D=require('./server/node_modules/better-sqlite3');const d=new D(':memory:');console.log(d.prepare('select 1 as sqliteReady').get());d.close()"], env=env)


def owned_process(name):
    record = DATA / f'mac-{name}.json'
    if not record.exists():
        return None
    saved = json.loads(record.read_text())
    result = subprocess.run(['ps', '-p', str(saved['pid']), '-o', 'command='], capture_output=True, text=True)
    if result.returncode == 0 and result.stdout.strip().startswith(saved['executable']):
        return saved['pid']
    return None


def start_process(name, args, cwd, env, port):
    if owned_process(name):
        return
    with socket.socket() as probe:
        if probe.connect_ex(('127.0.0.1', port)) == 0:
            raise RuntimeError(f'Port {port} is occupied by a process not managed by this launcher')
    with (LOGS / f'{name}.log').open('ab') as log:
        process = subprocess.Popen([str(x) for x in args], cwd=cwd, env=env,
                                   stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
    (DATA / f'mac-{name}.json').write_text(json.dumps({'pid': process.pid, 'executable': str(args[0])}))


def start_redis(env):
    start_process('redis', [REDIS, '--bind', '127.0.0.1', '--port', str(REDIS_PORT),
                           '--dir', DATA, '--appendonly', 'yes', '--save', '60 1'], ROOT, env, REDIS_PORT)
    for _ in range(50):
        result = subprocess.run([str(REDIS.with_name('redis-cli')), '-p', str(REDIS_PORT), 'ping'],
                                capture_output=True, text=True)
        if result.stdout.strip() == 'PONG':
            return
        time.sleep(0.1)
    raise RuntimeError('Redis did not become ready; inspect .local-logs/redis.log')


def status():
    for name in ('redis', 'server', 'client'):
        print(f'{name}: {owned_process(name) or "stopped"}')
    try:
        health = json.load(urllib.request.urlopen('http://127.0.0.1:3000/api/health', timeout=2))
        print(f'API: ok={health.get("ok")}, redis={health.get("redis")}')
    except (OSError, ValueError):
        print('API: unavailable')


def main():
    if sys.platform != 'darwin':
        raise RuntimeError('This launcher is for macOS')
    for directory in (TOOLS, DATA, LOGS):
        directory.mkdir(exist_ok=True)
    action = sys.argv[1] if len(sys.argv) > 1 else 'start'
    if action == 'status':
        return status()
    if action == 'stop':
        for name in ('client', 'server', 'redis'):
            pid = owned_process(name)
            if pid:
                os.kill(pid, signal.SIGTERM)
                for _ in range(100):
                    if not owned_process(name):
                        break
                    time.sleep(0.1)
                else:
                    raise RuntimeError(f'{name} did not stop; retained its process record')
            (DATA / f'mac-{name}.json').unlink(missing_ok=True)
        print('Local services stopped')
        return
    env = environment()
    if action == 'setup':
        return setup(env)
    if not all(path.exists() for path in (NODE, PNPM, REDIS)):
        raise RuntimeError('Run python3 scripts/local-mac.py setup first')
    if action == 'build':
        return pnpm(['build'], env)
    if action == 'questions':
        return run([NODE, '--import', 'tsx', 'src/scripts/exportCsLinkQuestions.ts'], cwd=ROOT / 'server', env=env)
    if action in ('test', 'backend-test'):
        start_redis(env)
        test_id = uuid.uuid4().hex
        env.update({'NODE_ENV': 'test', 'REDIS_REQUIRED': 'false',
                    'DB_URL': str(DATA / f'test-{test_id}.sqlite3'),
                    'REDIS_PREFIX': f'csgofriberg-test-{test_id}:'})
        return pnpm(['test'] if action == 'test' else ['--filter', 'server', 'test'], env)
    if action != 'start':
        raise RuntimeError('Usage: local-mac.py [setup|start|stop|status|test|backend-test|build|questions]')
    start_redis(env)
    pnpm(['migrate'], env)
    start_process('server', [NODE, '--import', 'tsx', 'src/index.ts'], ROOT / 'server', env, 3000)
    start_process('client', [NODE, 'node_modules/vite/bin/vite.js', '--host', '127.0.0.1',
                             '--port', '5173', '--strictPort'], ROOT / 'client', env, 5173)
    for _ in range(60):
        try:
            health = json.load(urllib.request.urlopen('http://127.0.0.1:3000/api/health', timeout=1))
            page = urllib.request.urlopen('http://127.0.0.1:5173', timeout=1)
            if health.get('ok') and health.get('redis') == 'up' and page.status == 200:
                print('Ready: http://localhost:5173 | second identity: http://127.0.0.1:5173')
                return
        except (OSError, ValueError):
            pass
        time.sleep(0.25)
    raise RuntimeError('Services did not become ready; inspect .local-logs')


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
