from __future__ import annotations

import argparse
import os
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path


EXCLUDED_DIRS = {
    '.git',
    '.venv',
    '__pycache__',
    '.mypy_cache',
    '.pytest_cache',
    '.ruff_cache',
}
EXCLUDED_FILES = {'.env'}


def _is_excluded(path: Path) -> bool:
    for part in path.parts:
        if part in EXCLUDED_DIRS:
            return True
    if path.name in EXCLUDED_FILES:
        return True
    if path.name.startswith('.env.'):
        return True
    if path.suffix == '.pyc':
        return True
    return False


def _run(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True)


def _package_source(source_dir: Path) -> Path:
    fd, temp_path = tempfile.mkstemp(prefix='remote-proxy-', suffix='.tar.gz')
    os.close(fd)
    tar_path = Path(temp_path)

    with tarfile.open(tar_path, mode='w:gz') as archive:
        for file_path in source_dir.rglob('*'):
            rel = file_path.relative_to(source_dir)
            if _is_excluded(rel):
                continue
            archive.add(file_path, arcname=rel)

    return tar_path


def deploy(host: str, remote_dir: str, service: str, skip_verify: bool) -> None:
    package_root = Path(__file__).resolve().parents[2]
    if not package_root.exists():
        raise RuntimeError(f'Package root not found: {package_root}')

    print(f'[deploy] packaging {package_root}')
    tar_path = _package_source(package_root)
    remote_tar = f'/tmp/{tar_path.name}'

    try:
        print(f'[deploy] uploading to {host}:{remote_tar}')
        _run(['scp', str(tar_path), f'{host}:{remote_tar}'])

        print(f'[deploy] extracting into {remote_dir}')
        _run([
            'ssh',
            host,
            (
                f"mkdir -p {remote_dir} && "
                f"tar -xzf {remote_tar} -C {remote_dir} && "
                f"rm -f {remote_tar}"
            ),
        ])

        print('[deploy] syncing dependencies and restarting service')
        _run([
            'ssh',
            host,
            (
                f'cd {remote_dir} && '
                '/home/ubuntu/.local/bin/uv sync && '
                f'sudo systemctl restart {service}'
            ),
        ])

        if not skip_verify:
            print('[deploy] verifying service')
            _run([
                'ssh',
                host,
                (
                    f'sudo systemctl --no-pager --full status {service} | sed -n "1,18p" && '
                    'curl -s -o /dev/null -w "%{http_code}\\n" http://127.0.0.1:8000/healthz'
                ),
            ])

        print('[deploy] done')
    finally:
        try:
            tar_path.unlink(missing_ok=True)
        except Exception:
            pass


def run() -> None:
    parser = argparse.ArgumentParser(description='Deploy remote-proxy package to EC2 host')
    parser.add_argument('--host', default='nexus', help='SSH host alias (default: nexus)')
    parser.add_argument('--remote-dir', default='/home/ubuntu/remote-proxy', help='Remote project directory')
    parser.add_argument('--service', default='remote-proxy', help='Systemd service name')
    parser.add_argument('--skip-verify', action='store_true', help='Skip post-deploy health checks')
    args = parser.parse_args()

    try:
        deploy(args.host, args.remote_dir, args.service, args.skip_verify)
    except subprocess.CalledProcessError as exc:
        print(f'[deploy] failed at command: {exc.cmd}', file=sys.stderr)
        sys.exit(exc.returncode)
    except Exception as exc:
        print(f'[deploy] error: {exc}', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    run()
