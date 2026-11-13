import html
import json
import os
import re
import time

import requests
from urllib.parse import urlparse

from http_utils.http_client import HttpClient
from utils.enums import StatusCode, TikTokError
from utils.logger_manager import logger
from utils.custom_exceptions import (
    UserLiveError,
    TikTokRecorderError,
    LiveNotFound,
    TikRecUnavailableError,
)


class TikTokAPI:
    ACTIVE_ROOM_STATUSES = {"2", "3"}
    TIKREC_MAX_ATTEMPTS = 3
    TIKREC_BACKOFF_SECONDS = 1

    def __init__(self, proxy, cookies):
        self.BASE_URL = "https://www.tiktok.com"
        self.WEBCAST_URL = "https://webcast.tiktok.com"
        self.API_URL = "https://www.tiktok.com/api-live/user/room/"
        self.TIKREC_API = "https://tikrec.com"

        self.http_client = HttpClient(proxy, cookies).req
        self._http_client_stream = HttpClient(proxy, cookies).req_stream

        self._browser_resolver_url = os.environ.get(
            "TIKTOK_BROWSER_RESOLVER_URL",
            "http://127.0.0.1:8787",
        ).rstrip("/")
        self._browser_stream_headers = {}

    def _is_authenticated(self) -> bool:
        response = self.http_client.get(f"{self.BASE_URL}/foryou")
        response.raise_for_status()

        content = response.text
        return "login-title" not in content

    def is_country_blacklisted(self) -> bool:
        """
        Checks if the user is in a blacklisted country that requires login
        """
        response = self.http_client.get(f"{self.BASE_URL}/live", allow_redirects=False)

        return response.status_code == StatusCode.REDIRECT

    def is_room_alive(self, room_id: str) -> bool:
        """
        Checking whether the user is live.
        """
        if not room_id:
            raise UserLiveError(TikTokError.USER_NOT_CURRENTLY_LIVE)

        alive_data = self.http_client.get(
            f"{self.WEBCAST_URL}/webcast/room/check_alive/"
            f"?aid=1988&region=CH&room_ids={room_id}&user_is_login=true"
        ).json()

        data_list = alive_data.get("data")
        if (not isinstance(data_list, list) or not data_list
                or not isinstance(data_list[0], dict)
                or 'alive' not in data_list[0]):
            raise RuntimeError('TIKTOK_LIVE_STATUS_INVALID')
        if not data_list[0]['alive']:
            return False

        room_info = self.http_client.get(
            f"{self.WEBCAST_URL}/webcast/room/info/?aid=1988&room_id={room_id}"
        ).json()

        status_code = room_info.get("status_code", 0)
        if status_code == 4003110:
            return True

        if status_code != 0:
            raise RuntimeError("TIKTOK_ROOM_INFO_FAILED")

        room_data = room_info.get("data") or {}
        room_status = room_data.get("status")
        if (
            room_status is not None
            and str(room_status) not in self.ACTIVE_ROOM_STATUSES
        ):
            return False

        stream_url = room_data.get("stream_url") or {}
        sdk_stream_data = (
            (stream_url.get("live_core_sdk_data") or {})
            .get("pull_data", {})
            .get("stream_data")
        )

        return bool(
            sdk_stream_data
            or stream_url.get("flv_pull_url")
            or stream_url.get("hls_pull_url")
            or stream_url.get("hls_pull_url_map")
            or stream_url.get("rtmp_pull_url")
        )

    def get_sec_uid(self):
        """
        Returns the sec_uid of the authenticated user.
        """
        response = self.http_client.get(f"{self.BASE_URL}/foryou")

        sec_uid = re.search('"secUid":"(.*?)",', response.text)
        if sec_uid:
            sec_uid = sec_uid.group(1)

        return sec_uid

    def get_user_from_room_id(self, room_id) -> str:
        """
        Given a room_id, I get the username
        """
        data = self.http_client.get(
            f"{self.WEBCAST_URL}/webcast/room/info/?aid=1988&room_id={room_id}"
        ).json()

        if "Follow the creator to watch their LIVE" in json.dumps(data):
            raise UserLiveError(TikTokError.ACCOUNT_PRIVATE_FOLLOW)

        if "This account is private" in data:
            raise UserLiveError(TikTokError.ACCOUNT_PRIVATE)

        display_id = data.get("data", {}).get("owner", {}).get("display_id")
        if display_id is None:
            raise TikTokRecorderError(TikTokError.USERNAME_ERROR)

        return display_id

    def get_room_and_user_from_url(self, live_url: str):
        """
        Given a url, get user and room_id.
        """
        response = self.http_client.get(live_url, allow_redirects=False)
        content = response.text

        if response.status_code == StatusCode.REDIRECT:
            raise UserLiveError(TikTokError.COUNTRY_BLACKLISTED)

        if response.status_code == StatusCode.MOVED:  # MOBILE URL
            matches = re.findall("com/@(.*?)/live", content)
            if len(matches) < 1:
                raise LiveNotFound(TikTokError.INVALID_TIKTOK_LIVE_URL)

            user = matches[0]

        # https://www.tiktok.com/@<username>/live
        match = re.match(r"https?://(?:www\.)?tiktok\.com/@([^/]+)/live", live_url)
        if match:
            user = match.group(1)

        room_id = self.get_room_id_from_user(user)

        return user, room_id

    def _tikrec_get_room_id_signed_url(self, user: str) -> str:
        last_error = None

        for attempt in range(1, self.TIKREC_MAX_ATTEMPTS + 1):
            try:
                response = self.http_client.get(
                    f"{self.TIKREC_API}/tiktok/room/api/sign",
                    params={"unique_id": user},
                    timeout=10,
                )
                response.raise_for_status()
                data = response.json()

                signed_path = data.get("signed_path")
                if not signed_path:
                    raise ValueError("response does not include signed_path")

                return f"{self.BASE_URL}{signed_path}"
            except Exception as error:
                last_error = error
                if attempt == self.TIKREC_MAX_ATTEMPTS:
                    break

                delay = self.TIKREC_BACKOFF_SECONDS * (2 ** (attempt - 1))
                logger.warning(
                    f"TikRec request failed ({attempt}/{self.TIKREC_MAX_ATTEMPTS}). "
                    f"Retrying in {delay} second(s)."
                )
                time.sleep(delay)

        raise TikRecUnavailableError(
            "TikRec could not resolve the RoomID after "
            f"{self.TIKREC_MAX_ATTEMPTS} attempts. Retry later or pass "
            f"-room_id <ROOM_ID>. Last error: {last_error}"
        ) from last_error

    def get_room_id_from_user(self, user: str) -> str | None:
        """
        Native TikTok API first.
        TikRec only as secondary fallback.
        """
        try:
            response = self.http_client.get(
                self.API_URL,
                params={
                    "aid": "1988",
                    "sourceType": "54",
                    "uniqueId": user,
                    "user_is_login": "true",
                },
                timeout=15,
            )

            response.raise_for_status()
            payload = response.json()

            if (
                isinstance(payload, dict)
                and str(payload.get("statusCode")) == "0"
            ):
                data = payload.get("data") or {}
                user_data = data.get("user") or {}
                room_id = user_data.get("roomId")

                if room_id and str(room_id) != "0":
                    return str(room_id)
                if user_data and str(room_id) == "0":
                    raise UserLiveError(TikTokError.USER_NOT_CURRENTLY_LIVE)

            logger.warning(
                f"Native Room ID unavailable for @{user}. "
                "Trying TikRec fallback."
            )

        except UserLiveError:
            raise
        except Exception as error:
            logger.warning(
                f"Native Room ID request failed for @{user}: "
                f"{type(error).__name__}. "
                "Trying TikRec fallback."
            )

        signed_url = self._tikrec_get_room_id_signed_url(user)

        response = self.http_client.get(
            signed_url,
            timeout=15,
        )

        content = response.text

        if not content or "Please wait" in content:
            raise UserLiveError(TikTokError.WAF_BLOCKED)

        data = response.json()

        return (
            (data.get("data") or {})
            .get("user", {})
            .get("roomId")
        )


    def get_followers_list(self, sec_uid) -> list:
        """Followers mode is excluded from this cookie-free portable bundle.

        Explicit multi-user automatic recording is fully supported.
        """
        raise NotImplementedError("Use -user username1,username2 with -mode automatic")


    def _get_stream_urls_from_user_room_api(self, user: str) -> list[str]:
        """
        Fetch authenticated LIVE stream URLs from TikTok's
        /api-live/user/room endpoint.

        Modern TikTok web clients receive streamData from this endpoint.
        Prefer H.264 streams for recorder/Telegram compatibility, then
        fall back to HEVC streams.
        """
        try:
            response = self.http_client.get(
                f"{self.BASE_URL}/api-live/user/room/",
                params={
                    "aid": "1988",
                    "sourceType": "54",
                    "uniqueId": user,
                    "user_is_login": "true",
                },
                headers={
                    "Accept": "*/*",
                    "Referer": f"{self.BASE_URL}/@{user}/live",
                    "Sec-Fetch-Dest": "empty",
                    "Sec-Fetch-Mode": "cors",
                    "Sec-Fetch-Site": "same-origin",
                },
                timeout=15,
            )

            response.raise_for_status()
            payload = response.json()

            status_code = payload.get("statusCode")

            if status_code not in (0, None):
                logger.warning(
                    "Authenticated user-room API returned "
                    f"statusCode={status_code}"
                )
                return []

            data = payload.get("data") or {}
            user_data = data.get("user") or {}
            live_room = data.get("liveRoom") or {}

            if not live_room:
                logger.warning(
                    "Authenticated user-room API returned "
                    "no liveRoom data."
                )
                return []

            room_id = user_data.get("roomId")
            stream_id = live_room.get("streamId")
            room_status = live_room.get("status")

            logger.info(
                "Authenticated user-room API: "
                f"room_id={room_id}, "
                f"stream_id={stream_id}, "
                f"status={room_status}"
            )

            if (
                room_status is not None
                and str(room_status)
                not in self.ACTIVE_ROOM_STATUSES
            ):
                logger.info(
                    "Authenticated user-room API says "
                    "the LIVE is not active."
                )
                return []

            candidates = []

            def extract_streams(block, codec_name):
                if not isinstance(block, dict):
                    return

                raw = (
                    (block.get("pull_data") or {})
                    .get("stream_data")
                )

                if not raw:
                    return

                try:
                    stream_info = (
                        json.loads(raw)
                        if isinstance(raw, str)
                        else raw
                    )
                except Exception as error:
                    logger.warning(
                        f"Unable to decode {codec_name} "
                        f"stream data: {error}"
                    )
                    return

                stream_data = stream_info.get("data") or {}

                # Highest quality first.
                # "ao" is intentionally excluded because it is audio-only.
                quality_order = (
                    "origin",
                    "uhd",
                    "full_hd",
                    "hd",
                    "sd",
                    "ld",
                )

                found_before = len(candidates)

                for quality in quality_order:
                    entry = stream_data.get(quality) or {}
                    main = entry.get("main") or {}

                    # Prefer FLV because the recorder handles it directly.
                    # Keep HLS as a fallback candidate.
                    for protocol in ("flv", "hls", "m3u8"):
                        url = main.get(protocol)

                        if url and url not in candidates:
                            candidates.append(url)

                found = len(candidates) - found_before

                if found:
                    logger.info(
                        f"Authenticated user-room API found "
                        f"{found} {codec_name} stream "
                        f"candidate(s)."
                    )

            # Prefer AVC/H.264 because it has the best compatibility
            # with MP4 and Telegram playback.
            extract_streams(
                live_room.get("streamData"),
                "H.264",
            )

            # Use HEVC/H.265 only if needed / as additional fallbacks.
            extract_streams(
                live_room.get("hevcStreamData"),
                "HEVC",
            )

            if candidates:
                logger.info(
                    "Authenticated user-room fallback found "
                    f"{len(candidates)} total stream "
                    "candidate(s)."
                )
            else:
                logger.warning(
                    "Authenticated user-room API returned "
                    "LIVE data but no usable FLV/HLS URLs."
                )

            return candidates

        except Exception as error:
            logger.warning(
                "Authenticated user-room fallback failed: "
                f"{error}"
            )
            return []

    def _get_stream_urls_from_browser(
        self,
        user: str,
    ) -> list[str]:
        """Resolve fresh LIVE URLs via local headless Chromium."""
        try:
            response = requests.get(
                f"{self._browser_resolver_url}/resolve",
                params={"user": user},
                timeout=80,
            )

            response.raise_for_status()
            payload = response.json()

            urls = []

            for item in payload.get("urls") or []:
                if isinstance(item, dict):
                    url = item.get("url")
                else:
                    url = item

                if (
                    isinstance(url, str)
                    and url.startswith(("http://", "https://"))
                    and url not in urls
                ):
                    urls.append(url)

            resolver_headers = payload.get("headers") or {}

            self._browser_stream_headers = {
                key: value
                for key, value in resolver_headers.items()
                if key in ("User-Agent", "Referer")
                and value
            }

            if urls:
                logger.info(
                    "Headless browser resolver found "
                    f"{len(urls)} stream candidate(s) "
                    f"via {payload.get('source')}."
                )

            return urls

        except Exception as error:
            logger.warning(
                "Headless browser resolver failed: "
                f"{type(error).__name__}: {error}"
            )
            return []

    def _get_stream_url_from_page(self, user: str) -> str | None:
        """
        Fallback: fetch the live page HTML and extract the stream URL directly.
        Used when the webcast API returns status code 4003110 (WAF/access restriction).
        """
        try:
            live_page_url = f"{self.BASE_URL}/@{user}/live"
            response = self.http_client.get(live_page_url)
            content = response.text

            flv_matches = re.findall(r'https?://[^\s"\'<>]+\.flv[^\s"\'<>]*', content)
            if flv_matches:
                # Prefer original (_or4) or SD quality
                for url in flv_matches:
                    url = html.unescape(url.rstrip("\\"))
                    if "_or4" in url or "_sd" in url:
                        logger.info(f"Found stream URL from page: {url[:80]}...")
                        return url
                return html.unescape(flv_matches[0].rstrip("\\"))

            hls_matches = re.findall(r'https?://[^\s"\'<>]+\.m3u8[^\s"\'<>]*', content)
            if hls_matches:
                return html.unescape(hls_matches[0].rstrip("\\"))

            return None
        except Exception as e:
            logger.warning(f"Failed to extract stream URL from page: {e}")
            return None

    def _add_live_url_candidate(self, candidates: list[str], url: str | None) -> None:
        if url and url not in candidates:
            candidates.append(url)

    def get_live_urls(self, room_id: str, user: str = None) -> list[str]:
        """
        Return candidate CDN URLs (flv or m3u8) for the streaming.
        If the API returns status code 4003110 and a username is provided,
        falls back to scraping the live page directly.
        """
        data = self.http_client.get(
            f"{self.WEBCAST_URL}/webcast/room/info/?aid=1988&room_id={room_id}"
        ).json()

        if "This account is private" in data:
            raise UserLiveError(TikTokError.ACCOUNT_PRIVATE)

        status_code = data.get("status_code", 0)

        if status_code == 4003110:
            if user:
                logger.info(
                    "API blocked by WAF (4003110). "
                    "Trying headless browser resolver..."
                )

                browser_urls = (
                    self._get_stream_urls_from_browser(
                        user
                    )
                )

                if browser_urls:
                    return browser_urls

                logger.info(
                    "Browser resolver returned no stream URL. "
                    "Trying HTML fallback..."
                )

                fallback_url = (
                    self._get_stream_url_from_page(
                        user
                    )
                )

                if fallback_url:
                    return [fallback_url]

            raise UserLiveError(
                TikTokError.LIVE_RESTRICTION
            )

        room_data = data.get("data") or {}
        room_status = room_data.get("status")
        if (
            room_status is not None
            and str(room_status) not in self.ACTIVE_ROOM_STATUSES
        ):
            raise UserLiveError(TikTokError.USER_NOT_CURRENTLY_LIVE)

        stream_url = room_data.get("stream_url", {})

        sdk_data_str = (
            stream_url.get("live_core_sdk_data", {})
            .get("pull_data", {})
            .get("stream_data")
        )
        candidates = []
        if not sdk_data_str:
            logger.warning(
                "No SDK stream data found. Falling back to legacy URLs. Consider contacting the developer to update the code."
            )
            flv_pull_url = stream_url.get("flv_pull_url", {})
            for key in ("FULL_HD1", "HD1", "SD2", "SD1"):
                self._add_live_url_candidate(candidates, flv_pull_url.get(key))
            self._add_live_url_candidate(candidates, stream_url.get("hls_pull_url"))
            self._add_live_url_candidate(candidates, stream_url.get("rtmp_pull_url"))
            return candidates

        # Extract stream options
        sdk_data = json.loads(sdk_data_str).get("data", {})
        qualities = (
            stream_url.get("live_core_sdk_data", {})
            .get("pull_data", {})
            .get("options", {})
            .get("qualities", [])
        )
        if not qualities:
            logger.warning("No qualities found in the stream data. Returning None.")
            return candidates
        level_map = {q["sdk_key"]: q["level"] for q in qualities}

        ordered_sdk_keys = sorted(
            sdk_data.keys(), key=lambda key: level_map.get(key, -1), reverse=True
        )
        for sdk_key in ordered_sdk_keys:
            entry = sdk_data[sdk_key]
            stream_main = entry.get("main", {})
            self._add_live_url_candidate(candidates, stream_main.get("flv"))
            self._add_live_url_candidate(
                candidates, stream_main.get("hls") or stream_main.get("m3u8")
            )

        flv_pull_url = stream_url.get("flv_pull_url", {})
        for key in ("FULL_HD1", "HD1", "SD2", "SD1"):
            self._add_live_url_candidate(candidates, flv_pull_url.get(key))
        self._add_live_url_candidate(candidates, stream_url.get("hls_pull_url"))
        self._add_live_url_candidate(candidates, stream_url.get("rtmp_pull_url"))

        return candidates

    def get_live_url(self, room_id: str, user: str = None) -> str | None:
        """Return the first candidate CDN URL for the streaming."""
        live_urls = self.get_live_urls(room_id, user=user)
        if live_urls:
            return live_urls[0]
        return None

    def get_live_url_candidates(self, room_id: str, user: str = None) -> list[str]:
        """Return candidate CDN URLs for the streaming."""
        return self.get_live_urls(room_id, user=user)

    @staticmethod
    def is_hls_url(live_url: str) -> bool:
        """Return whether a stream URL points to an HLS playlist."""
        return urlparse(live_url).path.lower().endswith((".m3u8", ".m3u"))

    def get_stream_headers(self) -> dict[str, str]:
        """Return HTTP headers used for direct stream requests."""
        session_headers = self._http_client_stream.headers
        headers = {
            name: session_headers[name]
            for name in ("User-Agent", "Referer", "Origin", "Accept-Language")
            if name in session_headers
        }
        cookie_header = "; ".join(
            f"{cookie.name}={cookie.value}"
            for cookie in self._http_client_stream.cookies
        )
        if cookie_header:
            headers["Cookie"] = cookie_header
        if self._browser_stream_headers:
            headers.update(
                self._browser_stream_headers
            )

        return headers

    def download_flv_stream(self, live_url: str):
        """Yield FLV stream bytes from a direct HTTP response."""
        request_headers = (
            self._browser_stream_headers
            or None
        )

        with self._http_client_stream.get(
            live_url,
            stream=True,
            timeout=(10, 30),
            headers=request_headers,
        ) as stream:
            stream.raise_for_status()
            for chunk in stream.iter_content(chunk_size=4096):
                if chunk:
                    yield chunk

    def download_live_stream(self, live_url: str):
        """Backward-compatible alias for FLV stream downloads."""
        yield from self.download_flv_stream(live_url)
