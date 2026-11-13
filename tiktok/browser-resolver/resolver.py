#!/usr/bin/env python3

import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import (
    sync_playwright,
    TimeoutError as PlaywrightTimeoutError,
)


COOKIE_FILE = Path(
    os.environ.get(
        "TIKTOK_COOKIE_FILE",
        "/app/cookies.json",
    )
)

PROFILE_DIR = os.environ.get(
    "BROWSER_PROFILE_DIR",
    "/data/profile",
)

BIND = os.environ.get(
    "RESOLVER_BIND",
    "127.0.0.1",
)

PORT = int(
    os.environ.get(
        "RESOLVER_PORT",
        "8787",
    )
)

RESOLVE_LOCK = threading.Lock()


def load_cookies():
    if not COOKIE_FILE.exists():
        raise RuntimeError("cookies.json not found")

    raw = json.loads(
        COOKIE_FILE.read_text()
    )

    cookies = []

    for name, value in raw.items():
        if isinstance(value, dict):
            value = value.get("value")

        if value is None:
            continue

        value = str(value)

        if not value:
            continue

        cookies.append({
            "name": str(name),
            "value": value,
            "domain": ".tiktok.com",
            "path": "/",
            "secure": True,
        })

    return cookies


def add_candidate(
    candidates,
    seen,
    url,
    quality,
):
    if not isinstance(url, str):
        return

    if not url.startswith(
        ("http://", "https://")
    ):
        return

    parsed = urlparse(url)

    if not parsed.hostname:
        return

    path = parsed.path.lower()

    if not path.endswith(
        (".flv", ".m3u8")
    ):
        return

    if url in seen:
        return

    seen.add(url)

    candidates.append({
        "url": url,
        "quality": quality,
    })


def extract_streams_from_room_enter(payload):
    candidates = []
    seen = set()

    if not isinstance(payload, dict):
        return candidates

    data = payload.get("data") or {}

    if not isinstance(data, dict):
        return candidates

    stream_url = (
        data.get("stream_url")
        or {}
    )

    if not isinstance(stream_url, dict):
        return candidates

    core = (
        stream_url
        .get("live_core_sdk_data")
        or {}
    )

    pull_data = (
        core.get("pull_data")
        or {}
    )

    raw_stream_data = (
        pull_data.get("stream_data")
    )

    stream_data = None

    if isinstance(raw_stream_data, str):
        try:
            stream_data = json.loads(
                raw_stream_data
            )
        except Exception:
            stream_data = None

    elif isinstance(
        raw_stream_data,
        dict,
    ):
        stream_data = raw_stream_data

    if isinstance(stream_data, dict):
        qualities = (
            stream_data.get("data")
            or {}
        )

        # Highest quality first.
        quality_order = (
            "origin",
            "uhd",
            "uhd_60",
            "full_hd",
            "hd",
            "hd_60",
            "sd",
            "ld",
        )

        handled = set()

        for quality in quality_order:
            entry = qualities.get(
                quality
            )

            if not isinstance(
                entry,
                dict,
            ):
                continue

            handled.add(quality)

            main = (
                entry.get("main")
                or {}
            )

            add_candidate(
                candidates,
                seen,
                main.get("flv"),
                quality,
            )

            add_candidate(
                candidates,
                seen,
                (
                    main.get("hls")
                    or main.get("m3u8")
                ),
                quality,
            )

        # Future/unknown quality names.
        for quality, entry in (
            qualities.items()
        ):
            if quality in handled:
                continue

            if not isinstance(
                entry,
                dict,
            ):
                continue

            main = (
                entry.get("main")
                or {}
            )

            add_candidate(
                candidates,
                seen,
                main.get("flv"),
                quality,
            )

            add_candidate(
                candidates,
                seen,
                (
                    main.get("hls")
                    or main.get("m3u8")
                ),
                quality,
            )

    # Legacy FLV URLs.
    flv_pull = (
        stream_url.get("flv_pull_url")
        or {}
    )

    if isinstance(flv_pull, dict):
        for quality in (
            "FULL_HD1",
            "HD1",
            "SD2",
            "SD1",
        ):
            add_candidate(
                candidates,
                seen,
                flv_pull.get(quality),
                quality,
            )

        for quality, url in (
            flv_pull.items()
        ):
            add_candidate(
                candidates,
                seen,
                url,
                quality,
            )

    add_candidate(
        candidates,
        seen,
        stream_url.get(
            "hls_pull_url"
        ),
        "hls",
    )

    return candidates


def resolve_live(user):
    live_url = (
        f"https://www.tiktok.com/"
        f"@{user}/live"
    )

    with RESOLVE_LOCK:
        with sync_playwright() as p:
            context = (
                p.chromium
                .launch_persistent_context(
                    PROFILE_DIR,
                    headless=True,
                    viewport={
                        "width": 1280,
                        "height": 720,
                    },
                    locale="ja-JP",
                    timezone_id="Asia/Tokyo",
                    args=[
                        "--no-sandbox",
                        "--disable-dev-shm-usage",
                        (
                            "--autoplay-policy="
                            "no-user-gesture-required"
                        ),
                    ],
                )
            )

            try:
                cookies = load_cookies()

                if cookies:
                    context.add_cookies(
                        cookies
                    )

                page = (
                    context.pages[0]
                    if context.pages
                    else context.new_page()
                )

                room_enter = []
                media_requests = []

                def response_seen(response):
                    try:
                        if (
                            "/webcast/room/enter/"
                            in response.url
                            and
                            response.request.method
                            == "POST"
                        ):
                            room_enter.append(
                                response
                            )
                    except Exception:
                        pass

                def request_seen(request):
                    try:
                        parsed = urlparse(
                            request.url
                        )

                        host = (
                            parsed.hostname
                            or ""
                        ).lower()

                        path = (
                            parsed.path
                            or ""
                        ).lower()

                        if (
                            host.endswith(
                                ".tiktokcdn.com"
                            )
                            and
                            path.endswith(
                                (
                                    ".flv",
                                    ".m3u8",
                                )
                            )
                        ):
                            if (
                                request.url
                                not in media_requests
                            ):
                                media_requests.append(
                                    request.url
                                )
                    except Exception:
                        pass

                page.on(
                    "response",
                    response_seen,
                )

                page.on(
                    "request",
                    request_seen,
                )

                try:
                    page.goto(
                        live_url,
                        wait_until=(
                            "domcontentloaded"
                        ),
                        timeout=35000,
                    )
                except PlaywrightTimeoutError:
                    # TikTok can keep the page
                    # loading while LIVE networking
                    # already works.
                    pass

                deadline = (
                    time.monotonic()
                    + 30
                )

                while (
                    time.monotonic()
                    < deadline
                ):
                    if room_enter:
                        break

                    if media_requests:
                        break

                    page.wait_for_timeout(
                        500
                    )

                candidates = []
                source = None
                room_enter_status = None

                if room_enter:
                    response = (
                        room_enter[-1]
                    )

                    room_enter_status = (
                        response.status
                    )

                    try:
                        payload = (
                            response.json()
                        )

                        candidates = (
                            extract_streams_from_room_enter(
                                payload
                            )
                        )

                        if candidates:
                            source = (
                                "room_enter"
                            )
                    except Exception:
                        pass

                # If structured room/enter
                # parsing failed, let the
                # player itself request media
                # and capture that URL.
                if not candidates:
                    extra_deadline = (
                        time.monotonic()
                        + 12
                    )

                    while (
                        time.monotonic()
                        < extra_deadline
                        and
                        not media_requests
                    ):
                        page.wait_for_timeout(
                            500
                        )

                    seen = set()

                    for url in media_requests:
                        add_candidate(
                            candidates,
                            seen,
                            url,
                            "browser-selected",
                        )

                    if candidates:
                        source = (
                            "network_request"
                        )

                try:
                    user_agent = (
                        page.evaluate(
                            "navigator.userAgent"
                        )
                    )
                except Exception:
                    user_agent = ""

                return {
                    "ok": bool(candidates),
                    "user": user,
                    "source": source,
                    "room_enter_seen": (
                        bool(room_enter)
                    ),
                    "room_enter_status": (
                        room_enter_status
                    ),
                    "count": len(
                        candidates
                    ),
                    "urls": candidates,
                    "headers": {
                        "User-Agent":
                            user_agent,
                        "Referer":
                            "https://www.tiktok.com/",
                    },
                }

            finally:
                context.close()


class Handler(BaseHTTPRequestHandler):
    def log_message(
        self,
        format,
        *args,
    ):
        # Disable default HTTP log so
        # query parameters never leak.
        return

    def send_json(
        self,
        status,
        payload,
    ):
        raw = json.dumps(
            payload,
            separators=(",", ":"),
        ).encode()

        self.send_response(status)

        self.send_header(
            "Content-Type",
            "application/json",
        )

        self.send_header(
            "Content-Length",
            str(len(raw)),
        )

        self.send_header(
            "Cache-Control",
            "no-store",
        )

        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        parsed = urlparse(
            self.path
        )

        if parsed.path == "/health":
            self.send_json(
                200,
                {
                    "ok": True,
                    "service":
                        "tiktok-browser-resolver",
                },
            )
            return

        if parsed.path != "/resolve":
            self.send_json(
                404,
                {
                    "ok": False,
                    "error": "not_found",
                },
            )
            return

        query = parse_qs(
            parsed.query
        )

        user = (
            query.get("user", [""])[0]
            .strip()
            .lstrip("@")
        )

        if (
            not user
            or len(user) > 64
            or not all(
                c.isalnum()
                or c in "._"
                for c in user
            )
        ):
            self.send_json(
                400,
                {
                    "ok": False,
                    "error":
                        "invalid_username",
                },
            )
            return

        print(
            f"[resolver] Resolving "
            f"@{user}...",
            flush=True,
        )

        try:
            result = resolve_live(
                user
            )

            if not result["ok"]:
                print(
                    f"[resolver] @{user}: "
                    f"no stream URL found; "
                    f"room_enter_seen="
                    f"{result['room_enter_seen']}, "
                    f"room_enter_status="
                    f"{result['room_enter_status']}",
                    flush=True,
                )

                self.send_json(
                    502,
                    result,
                )

                return

            print(
                f"[resolver] @{user}: "
                f"found "
                f"{result['count']} "
                f"stream candidate(s) "
                f"via "
                f"{result['source']}.",
                flush=True,
            )

            self.send_json(
                200,
                result,
            )

        except Exception as error:
            print(
                f"[resolver] @{user}: "
                f"failed "
                f"({type(error).__name__})",
                flush=True,
            )

            self.send_json(
                502,
                {
                    "ok": False,
                    "user": user,
                    "error":
                        type(error).__name__,
                },
            )


if __name__ == "__main__":
    print(
        f"[resolver] Listening on "
        f"{BIND}:{PORT}",
        flush=True,
    )

    server = ThreadingHTTPServer(
        (BIND, PORT),
        Handler,
    )

    server.serve_forever()
