"""Normal interactive Chromium login, independent of the automated reader."""

import os
from pathlib import Path
import signal
import subprocess
import threading

from catalog_browser import cookie_version


def browser_command(executable, profile):
    return [
        str(executable),
        "--user-data-dir=" + str(profile),
        "--no-sandbox",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-default-browser-check",
        "--password-store=basic",
        "https://www.tiktok.com/login",
    ]


def prepare_profile(profile, cookie_map):
    profile.mkdir(parents=True, exist_ok=True)
    profile.chmod(0o700)
    # Mark the source version without injecting its cookies over a manual session.
    marker = profile / ".cookie-version"
    marker.write_text(cookie_version(cookie_map))
    marker.chmod(0o600)


def main():
    from playwright.sync_api import sync_playwright

    profile = Path(os.getenv("TIKTOK_CATALOG_PROFILE", "/data/catalog-profile"))
    from worker import cookies

    prepare_profile(profile, cookies())
    # Playwright locates the installed binary; it does not launch/control this browser.
    with sync_playwright() as engine:
        executable = engine.chromium.executable_path
    stop = threading.Event()
    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, lambda *_: stop.set())
    process = subprocess.Popen(
        browser_command(executable, profile),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    try:
        if stop.wait(1) or process.poll() is not None:
            if process.poll() not in (None, 0):
                raise RuntimeError("TIKTOK_LOGIN_BROWSER_START_FAILED")
        else:
            print("TIKTOK_LOGIN_READY", flush=True)
        while process.poll() is None and not stop.wait(1):
            pass
        if not stop.is_set() and process.returncode not in (None, 0):
            raise RuntimeError("TIKTOK_LOGIN_BROWSER_EXIT_FAILED")
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()


if __name__ == "__main__":
    main()
