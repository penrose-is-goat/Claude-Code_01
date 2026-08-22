"""Start and verify a temporary Cloudflare link for Side Tools."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


APP_DIR = Path(__file__).resolve().parent
STATUS_PATH = APP_DIR / ".cache" / "public-url.json"
CLOUDFLARED = APP_DIR / "tools" / "cloudflared.exe"
URL_PATTERN = re.compile(r"https://(?!api\.)[a-z0-9-]+\.trycloudflare\.com", re.I)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def fetch_health(url: str, timeout: int = 5) -> dict:
    request = urllib.request.Request(
        url.rstrip("/") + "/api/health",
        headers={"User-Agent": "Portfolio Analyzer Side Tools link verifier"},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        payload = json.loads(response.read().decode("utf-8"))
    if response.status != 200 or not payload.get("ok"):
        raise RuntimeError("health response was not successful")
    return payload


def write_status(payload: dict) -> None:
    STATUS_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = STATUS_PATH.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    temporary.replace(STATUS_PATH)


def show_status() -> int:
    try:
        status = json.loads(STATUS_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        print("No public link has been recorded yet. Run share-side-tools.bat.")
        return 1
    url = str(status.get("url") or "")
    reachable = False
    error = None
    if url:
        try:
            fetch_health(url)
            reachable = True
        except Exception as exc:  # noqa: BLE001
            error = str(exc)
    print(f"Last URL: {url or 'none'}")
    print(f"Recorded active: {bool(status.get('active'))}")
    print(f"Reachable now: {reachable}")
    print(f"Started: {status.get('startedAt') or 'unknown'}")
    if error:
        print(f"Check failed: {error}")
    return 0 if reachable else 1


def run(port: int) -> int:
    local_url = f"http://127.0.0.1:{port}"
    try:
        fetch_health(local_url, timeout=4)
    except Exception as exc:  # noqa: BLE001
        print(f"Side Tools is not responding at {local_url}: {exc}")
        print("Start it first with: python .\\serve.py --no-open")
        return 1
    if not CLOUDFLARED.exists():
        print(f"Cloudflare connector is missing: {CLOUDFLARED}")
        print("Run share-side-tools.bat once to download the verified portable connector.")
        return 1

    command = [
        str(CLOUDFLARED),
        "tunnel",
        "--no-autoupdate",
        "--edge-ip-version",
        "4",
        "--url",
        local_url,
    ]
    process = subprocess.Popen(
        command,
        cwd=APP_DIR,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        bufsize=1,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    status = {
        "active": False,
        "url": None,
        "startedAt": utc_now(),
        "verifiedAt": None,
        "closedAt": None,
        "pid": process.pid,
        "port": port,
        "type": "cloudflare-quick-tunnel",
    }
    write_status(status)
    print("Creating a fresh temporary public testing link...")
    print("Keep this window and the Side Tools server window open.")
    try:
        assert process.stdout is not None
        for line in process.stdout:
            match = URL_PATTERN.search(line)
            if not match:
                if "ERR" in line or "failed" in line.lower():
                    print(line.rstrip())
                continue
            url = match.group(0)
            verified = False
            last_error = "verification timed out"
            for _ in range(15):
                try:
                    fetch_health(url, timeout=6)
                    verified = True
                    break
                except Exception as exc:  # noqa: BLE001
                    last_error = str(exc)
                    time.sleep(1)
            if not verified:
                raise RuntimeError(f"Cloudflare issued {url}, but public health verification failed: {last_error}")
            status.update({"active": True, "url": url, "verifiedAt": utc_now()})
            write_status(status)
            print("")
            print("CURRENT SHAREABLE LINK")
            print(url)
            print("")
            print("This temporary URL changes whenever this tunnel restarts. Press Ctrl+C to close it.")
        return_code = process.wait()
        if return_code:
            print(f"Cloudflare Tunnel exited with code {return_code}.")
        return return_code
    except KeyboardInterrupt:
        print("\nClosing the temporary public link...")
        process.terminate()
        try:
            process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            process.kill()
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"Sharing failed: {exc}")
        process.terminate()
        return 1
    finally:
        status.update({"active": False, "closedAt": utc_now()})
        write_status(status)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8017)
    parser.add_argument("--status", action="store_true")
    args = parser.parse_args()
    return show_status() if args.status else run(args.port)


if __name__ == "__main__":
    raise SystemExit(main())
