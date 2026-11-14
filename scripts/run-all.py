import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import httpx

ENGINE_DIR = Path(__file__).resolve().parents[1] / "engine"

SERVICES = [
    # (name, uvicorn target, port, extra uvicorn flags, extra env, readiness path)
    ("engine", "app.main:app", 8000, [], {}, "/attestation"),
    (
        "coordinator",
        "app.coordinator:app_from_env",
        8001,
        ["--factory"],
        {"ENGINE_URL": "http://127.0.0.1:8000"},
        "/attestation",
    ),
    (
        "demo server",
        "app.demo_server:app_from_env",
        8002,
        ["--factory"],
        {"COORDINATOR_URL": "http://127.0.0.1:8001"},
        "/demo/state",
    ),
]


def wait_until_up(name: str, port: int, path: str, process: subprocess.Popen) -> None:
    for _ in range(60):
        if process.poll() is not None:
            sys.exit(f"{name} stopped while starting (exit code {process.returncode}); see its output above")
        try:
            if httpx.get(f"http://127.0.0.1:{port}{path}", timeout=2).status_code == 200:
                return
        except httpx.TransportError:
            pass
        time.sleep(0.5)
    sys.exit(f"{name} did not come up on port {port}")


def main() -> None:
    children: list[subprocess.Popen] = []

    def stop(*_: object) -> None:
        for child in children:
            if child.poll() is None:
                child.terminate()
        for child in children:
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()

    signal.signal(signal.SIGINT, lambda *_: (stop(), sys.exit(0)))
    signal.signal(signal.SIGTERM, lambda *_: (stop(), sys.exit(0)))

    try:
        for name, target, port, flags, extra_env, ready in SERVICES:
            command = [sys.executable, "-m", "uvicorn", target, "--port", str(port), "--log-level", "warning", *flags]
            child = subprocess.Popen(command, cwd=ENGINE_DIR, env={**os.environ, **extra_env})
            children.append(child)
            wait_until_up(name, port, ready, child)
            print(f"  {name:<12} running on http://127.0.0.1:{port}")
    except BaseException:
        stop()
        raise

    print("\nBack end is ready. In another terminal:  cd dashboard && npm run dev\nCtrl-C stops everything.")
    try:
        while all(c.poll() is None for c in children):
            time.sleep(1)
        print("A service stopped unexpectedly; shutting down.")
    finally:
        stop()


if __name__ == "__main__":
    main()