"""Persistent regular Chromium with guarded read-only catalog navigation."""

import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
import urllib.request
from urllib.parse import urlparse
from contextlib import suppress

from catalog_browser import BrowserTransport, cookie_version


class RegularBrowserTransport(BrowserTransport):
    def __init__(self, name, cookies):
        self.chrome = self.display = self.remote = self.lifecycle = self.cache = None
        super().__init__(name, cookies)

    def open(self, name, cookies, manual=False):
        from playwright.sync_api import sync_playwright

        profile = Path(os.getenv("TIKTOK_CATALOG_PROFILE", "/data/catalog-profile"))
        profile.mkdir(parents=True, exist_ok=True)
        profile.chmod(0o700)
        # Keep login state persistent, but never reopen an old multi-GB HTTP cache.
        self.cache = tempfile.TemporaryDirectory(prefix="tiktok-catalog-cache-")
        self.engine = sync_playwright().start()
        # No automation/headless switches. CDP is loopback-only and not published.
        self.display = subprocess.Popen(
            ["Xvfb", ":98", "-screen", "0", "1280x800x24"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        time.sleep(0.5)
        self.chrome = subprocess.Popen(
            [
                self.engine.chromium.executable_path,
                "--user-data-dir=" + str(profile),
                "--no-sandbox",
                "--disable-dev-shm-usage",
                "--no-first-run",
                "--no-default-browser-check",
                "--password-store=basic",
                "--disable-extensions",
                "--disable-sync",
                "--disable-background-networking",
                "--autoplay-policy=user-gesture-required",
                "--mute-audio",
                "--disable-features=BackForwardCache",
                "--disk-cache-dir=" + self.cache.name,
                "--disk-cache-size=33554432",
                "--media-cache-size=8388608",
                "--remote-debugging-address=127.0.0.1",
                "--remote-debugging-port=9222",
                "about:blank",
            ],
            env={**os.environ, "DISPLAY": ":98"},
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        for _ in range(40):
            if self.chrome.poll() is not None:
                raise RuntimeError("TIKTOK_BROWSER_START_FAILED")
            try:
                with urllib.request.urlopen(
                    "http://127.0.0.1:9222/json/version", timeout=0.5
                ):
                    break
            except OSError:
                time.sleep(0.25)
        else:
            raise RuntimeError("TIKTOK_BROWSER_CONNECT_TIMEOUT")
        self.remote = self.engine.chromium.connect_over_cdp(
            "http://127.0.0.1:9222", timeout=10000
        )
        # Keep the real persistent login context. Disable existing/future TikTok
        # Service Workers before navigation, then guard every automated request.
        self.context = self.remote.contexts[0]
        self.context.route("**/*", self.guard)
        self.context.route_web_socket("**/*", lambda socket: None)
        marker = profile / ".cookie-version"
        version = cookie_version(cookies)
        if not marker.exists() or marker.read_text() != version:
            self.context.add_cookies(
                [
                    {
                        "name": key,
                        "value": value,
                        "domain": ".tiktok.com",
                        "path": "/",
                        "secure": True,
                    }
                    for key, value in cookies.items()
                ]
            )
            marker.write_text(version)
            marker.chmod(0o600)
        self.prepare_reader_page()
        self.lifecycle = self.context.new_cdp_session(self.page)
        self.guard_workers()
        self.navigate(name)

    def guard_workers(self):
        cdp = self.lifecycle
        cdp.send("Network.enable")
        cdp.send("Network.setBypassServiceWorker", {"bypass": True})
        registrations = []
        cdp.on(
            "ServiceWorker.workerRegistrationUpdated",
            lambda event: registrations.extend(event.get("registrations", [])),
        )
        cdp.send("ServiceWorker.enable")
        cdp.send("ServiceWorker.stopAllWorkers")
        self.page.wait_for_timeout(100)
        for registration in registrations:
            scope = registration.get("scopeURL", "")
            host = urlparse(scope).hostname or ""
            if host == "tiktok.com" or host.endswith(".tiktok.com"):
                cdp.send("ServiceWorker.unregister", {"scopeURL": scope})
        self.context.add_init_script(
            "if (window.ServiceWorkerContainer) { ServiceWorkerContainer.prototype.register = () => Promise.reject(new DOMException('Disabled by read guard', 'NotAllowedError')); }"
        )

    def navigate(self, name):
        self.profile_url = f"https://www.tiktok.com/@{name}"
        self.navigation = self.page.goto(
            self.profile_url, wait_until="domcontentloaded", timeout=60000
        )
        self.page.wait_for_timeout(2000)

    def pause(self):
        if os.getenv("TIKTOK_CATALOG_FREEZE_IDLE", "1") == "1":
            self.lifecycle.send("Emulation.setScriptExecutionDisabled", {"value": True})

    def resume(self):
        if os.getenv("TIKTOK_CATALOG_FREEZE_IDLE", "1") == "1":
            self.lifecycle.send("Emulation.setScriptExecutionDisabled", {"value": False})

    def park(self):
        """Release the TikTok renderer between scheduler ticks, retaining login."""
        old_page = self.page
        # Allow exactly this replacement through the popup guard.
        self.page = None
        try:
            self.page = self.context.new_page()
        finally:
            old_page.close()
        self.lifecycle = self.context.new_cdp_session(self.page)
        self.lifecycle.send("Network.enable")
        self.lifecycle.send("Network.setBypassServiceWorker", {"bypass": True})
        self.profile_url = "about:blank"
        self.navigation = None

    def close(self):
        if self.context:
            with suppress(Exception):
                self.context.close()
        if self.remote:
            with suppress(Exception):
                self.remote.close()
        if self.engine:
            with suppress(Exception):
                self.engine.stop()
        if self.chrome and self.chrome.poll() is None:
            with suppress(ProcessLookupError):
                os.killpg(self.chrome.pid, signal.SIGTERM)
            try:
                self.chrome.wait(timeout=10)
            except subprocess.TimeoutExpired:
                with suppress(ProcessLookupError):
                    os.killpg(self.chrome.pid, signal.SIGKILL)
                self.chrome.wait()
        if self.display and self.display.poll() is None:
            self.display.terminate()
            try:
                self.display.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.display.kill()
                self.display.wait()
        if self.cache:
            self.cache.cleanup()
            self.cache = None
        self.context = self.engine = self.lifecycle = None
