"""Offline Chromium resource smoke test; run inside the catalog image.

Mount this file read-only and set PYTHONPATH=/app. No TikTok credentials or
external network are used; this exercises the actual regular browser transport.
"""
import os
import tempfile
import time
from unittest.mock import patch

from catalog_regular_browser import RegularBrowserTransport


def navigate_local(browser, _name):
    browser.profile_url = "data:text/html,<html><body>offline reader</body></html>"
    browser.navigation = browser.page.goto(browser.profile_url)


with tempfile.TemporaryDirectory() as profile, patch.dict(
    os.environ, {"TIKTOK_CATALOG_PROFILE": profile, "TIKTOK_CATALOG_FREEZE_IDLE": "1"}
), patch.object(RegularBrowserTransport, "navigate", navigate_local):
    browser = RegularBrowserTransport("offline", {})
    cache = browser.cache.name
    try:
        assert len(browser.context.pages) == 1
        assert "--disk-cache-size=33554432" in browser.chrome.args
        assert "--media-cache-size=8388608" in browser.chrome.args
        assert not cache.startswith(profile + os.sep)
        browser.page.evaluate("window.ticks=0; window.timer=setInterval(()=>ticks++,10)")
        browser.page.wait_for_timeout(250)
        before = browser.page.evaluate("ticks")
        browser.pause()
        time.sleep(0.5)
        browser.resume()
        after = browser.page.evaluate("ticks")
        assert after - before <= 3, (before, after)
        browser.page.wait_for_timeout(250)
        assert browser.page.evaluate("ticks") > after + 5
        for _ in range(3):
            old_page = browser.page
            browser.park()
            assert old_page.is_closed()
            assert len(browser.context.pages) == 1
            browser.resume()
            browser.navigate("offline")
            assert browser.page.evaluate("document.body.textContent") == "offline reader"
            browser.pause()
            browser.resume()
    finally:
        browser.close()
    assert not os.path.exists(cache), "temporary cache must be reclaimed on close"

print("Catalog real Chromium: one page, bounded temporary cache, freeze/resume, navigation and cleanup passed")
