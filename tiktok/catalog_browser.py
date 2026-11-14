"""Isolated Chromium transport. Never open Story playback or allow write requests."""

import os
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlparse


def cookie_version(cookies):
    return hashlib.sha256(json.dumps(cookies, sort_keys=True).encode()).hexdigest()


class BrowserTransport:
    def __init__(self, name, cookies, manual=False):
        self.engine = None
        self.context = None
        try:
            self.open(name, cookies, manual)
        except Exception:
            self.close()
            raise

    def open(self, name, cookies, manual):
        from playwright.sync_api import sync_playwright

        self.engine = sync_playwright().start()
        profile = Path(os.getenv("TIKTOK_CATALOG_PROFILE", "/data/catalog-profile"))
        profile.mkdir(parents=True, exist_ok=True)
        profile.chmod(0o700)
        self.context = self.engine.chromium.launch_persistent_context(
            str(profile),
            headless=not manual,
            service_workers="allow" if manual else "block",
            args=["--no-sandbox", "--disable-dev-shm-usage"],
            viewport={"width": 1280, "height": 800},
        )
        if not manual:
            self.context.route("**/*", self.guard)
            # A routed socket stays disconnected unless connect_to_server() is called.
            # Do not synchronously close it inside this callback: that can stall the sync driver.
            self.context.route_web_socket("**/*", lambda socket: None)
        version = cookie_version(cookies)
        marker = profile / ".cookie-version"
        if not marker.exists() or marker.read_text() != version:
            self.context.add_cookies(
                [
                    {
                        "name": k,
                        "value": v,
                        "domain": ".tiktok.com",
                        "path": "/",
                        "secure": True,
                    }
                    for k, v in cookies.items()
                ]
            )
            marker.write_text(version)
            marker.chmod(0o600)
        if manual:
            self.page = self.context.new_page()
        else:
            self.prepare_reader_page()
        self.profile_url = (
            "https://www.tiktok.com/login"
            if manual
            else f"https://www.tiktok.com/@{name}"
        )
        try:
            self.navigation = self.page.goto(
                self.profile_url, wait_until="domcontentloaded", timeout=60000
            )
        except Exception:
            if not manual:
                raise
            self.navigation = None
        self.page.wait_for_timeout(5000)

    def prepare_reader_page(self):
        self.page = self.context.new_page()
        # Persistent profiles may restore tabs after a crash or manual login.
        # The reader needs exactly one page; restored pages otherwise run forever.
        for page in list(self.context.pages):
            if page != self.page:
                page.close()
        self.context.on("page", lambda page: page.close() if self.page is not None and page != self.page else None)

    @staticmethod
    def guard(route):
        request = route.request
        if getattr(request, "resource_type", None) in ("image", "media", "font"):
            return route.abort()
        path = urlparse(request.url).path
        api = path.startswith("/api/")
        allowed = (
            "/api/post/item_list/",
            "/api/repost/item_list/",
            "/api/story/item_list/",
            "/api/favorite/item_list/",
            "/api/user/detail/",
        )
        if request.method != "GET" or api and path not in allowed:
            return route.abort()
        if any(
            word in path.lower()
            for word in ("/seen", "/view/", "/mark_read", "/digg", "/follow/")
        ):
            return route.abort()
        return route.continue_()

    def request(self, url):
        if url == self.profile_url:
            body = self.page.locator("body").inner_text(timeout=5000).lower()
            if any(
                text in body
                for text in (
                    "verify to continue",
                    "complete the puzzle",
                    "verify you are human",
                    "drag the slider",
                )
            ):
                raise RuntimeError("TIKTOK_CAPTCHA_REQUIRED")
            if self.navigation and self.navigation.status != 200:
                raise RuntimeError("TIKTOK_BROWSER_HTTP_" + str(self.navigation.status))
            return SimpleNamespace(
                status_code=200, text=self.page.content(), url=url, history=[]
            )
        response = self.page.evaluate(
            """async url => {
          const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 25000);
          try { const r = await fetch(url, {credentials:'include', signal:controller.signal}); return {status:r.status, text:await r.text()}; }
          finally {clearTimeout(timer);}
        }""",
            url,
        )
        return SimpleNamespace(
            status_code=response["status"], text=response["text"], url=url, history=[]
        )

    def close(self):
        try:
            if self.context:
                self.context.close()
        finally:
            if self.engine:
                self.engine.stop()
            self.context = self.engine = None
