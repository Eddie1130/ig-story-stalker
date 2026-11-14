"""Version-pinned gallery-dl bridge. stdout is a private JSON protocol, never a log."""

import contextlib
import copy
import json
import logging
import re
import sys
from urllib.parse import urlparse


class ProviderError(RuntimeError):
    pass


def identifier(value):
    value = str(value or "")
    if not re.fullmatch(r"\d{1,30}", value):
        raise ProviderError("TIKTOK_ID_INVALID")
    return value


def media_url(value):
    if isinstance(value, dict):
        value = next(iter(value.get("urlList") or value.get("url_list") or []), None)
    if not isinstance(value, str):
        raise ProviderError("TIKTOK_MEDIA_URL_MISSING")
    parsed = urlparse(value)
    host = (parsed.hostname or "").lower()
    if (
        parsed.scheme != "https"
        or parsed.username
        or parsed.password
        or not any(
            host == d or host.endswith("." + d)
            for d in (
                "tiktok.com",
                "tiktokcdn.com",
                "tiktokcdn-us.com",
                "tiktokcdn-eu.com",
                "tiktokv.com",
                "tiktokv.us",
                "byteoversea.com",
                "ibytedtos.com",
                "ibyteimg.com",
                "muscdn.com",
                "byteimg.com",
            )
        )
    ):
        raise ProviderError("TIKTOK_MEDIA_HOST_REJECTED")
    return value


def normalize(item, extractor):
    item = copy.deepcopy(item)
    author = item.get("author") or {}
    if not isinstance(author, dict):
        raise ProviderError("TIKTOK_AUTHOR_INVALID")
    result = {
        "id": identifier(item.get("id")),
        "authorId": identifier(author.get("id")),
        "author": str(author.get("uniqueId") or ""),
        "caption": str(item.get("desc") or ""),
        "publishedAt": int(item.get("createTime") or 0) * 1000,
        "assets": [],
    }
    images = (item.get("imagePost") or {}).get("images")
    if images:
        for image in images:
            result["assets"].append(
                {"url": media_url(image.get("imageURL")), "type": "photo"}
            )
    elif item.get("video"):
        urls = extractor._extract_video_urls(item["video"])
        if not urls:
            raise ProviderError("TIKTOK_VIDEO_URL_MISSING")
        candidates = []
        for url in urls:
            try:
                checked = media_url(url)
            except ProviderError:
                continue
            if checked not in candidates:
                candidates.append(checked)
        if not candidates:
            raise ProviderError("TIKTOK_VIDEO_URL_MISSING")
        result["assets"].append(
            {"url": candidates[0], "urls": candidates, "type": "video"}
        )
    else:
        raise ProviderError("TIKTOK_ITEM_UNSUPPORTED")
    if len(result["assets"]) > 100:
        raise ProviderError("TIKTOK_ASSET_COUNT_INVALID")
    for asset in result["assets"]:
        if getattr(extractor, "catalog_headers", None):
            asset["headers"] = extractor.catalog_headers
    return result


def normalize_page(rows, extractor):
    """A bad media descriptor must not discard its identifiable neighbours."""
    result = []
    for row in rows:
        iid = identifier(row.get("id"))
        try:
            item = normalize(row, extractor)
        except (
            ProviderError,
            KeyError,
            TypeError,
            ValueError,
            AttributeError,
        ) as error:
            reason = (
                str(error)
                if isinstance(error, ProviderError)
                else "TIKTOK_ITEM_PARSE_FAILED"
            )
            author = row.get("author") if isinstance(row.get("author"), dict) else {}
            item = {
                "id": iid,
                "authorId": str(author.get("id") or ""),
                "author": str(author.get("uniqueId") or ""),
                "caption": row.get("desc") if isinstance(row.get("desc"), str) else "",
                "publishedAt": 0,
                "assets": [],
                "unresolvedReason": reason,
                # Private recovery state only; never written to the public archive/Telegram.
                "raw": copy.deepcopy(row),
            }
        result.append(item)
    return result


def checked_page(data, kind, cursor):
    if not isinstance(data, dict) or (
        "statusCode" not in data and "status_code" not in data
    ):
        raise ProviderError("TIKTOK_RESPONSE_INVALID")
    if str(data.get("statusCode", data.get("status_code"))) != "0":
        raise ProviderError("TIKTOK_RESPONSE_REJECTED")
    key = "HasMoreAfter" if kind == "story" else "hasMore"
    if (
        key not in data
        or not isinstance(data[key], (bool, int))
        or data[key] not in (0, 1)
    ):
        raise ProviderError("TIKTOK_PAGINATION_INVALID")
    rows = data.get("itemList")
    # Observed TikTok empty-Story contract: no itemList, explicit zero count,
    # successful status and neither forward nor backward pagination.
    if (
        kind == "story"
        and "itemList" not in data
        and str(data.get("TotalCount")) == "0"
        and data.get("HasMoreAfter") is False
        and data.get("HasMoreBefore") is False
        and str(data.get("statusCode")) == "0"
        and str(data.get("status_code")) == "0"
    ):
        rows = []
    if not isinstance(rows, list) or any(not isinstance(row, dict) for row in rows):
        raise ProviderError("TIKTOK_ITEMS_INVALID")
    more = bool(data[key])
    next_cursor = data.get("MaxCursor" if kind == "story" else "cursor")
    if kind == "repost":
        next_cursor = int(cursor or 0) + len(rows)
    if more and (
        not rows or next_cursor is None or str(next_cursor) == str(cursor or 0)
    ):
        raise ProviderError("TIKTOK_PAGINATION_STALLED")
    return rows, str(next_cursor or 0), more


def fetch_page(request, transport=None):
    from gallery_dl import config, extractor
    from gallery_dl.extractor import tiktok

    name, kind = request["username"], request["kind"]
    if (
        not re.fullmatch(r"[a-z0-9_][a-z0-9_.]{0,23}", name)
        or name.endswith(".")
        or kind not in ("post", "repost", "story", "profile", "like")
    ):
        raise ProviderError("TIKTOK_REQUEST_INVALID")
    config.clear()
    config.set(("extractor", "tiktok"), "cookies", request["cookies"])
    config.set(("extractor",), "cookies-update", False)
    config.set(("extractor",), "timeout", 20)
    config.set(("extractor",), "retries", 1)
    ex = extractor.find(f"https://www.tiktok.com/@{name}/posts")
    ex.initialize()
    ex.rehydration_data_cache = {}
    original = ex.request
    user_agent = (
        transport.page.evaluate("navigator.userAgent")
        if transport
        else ex.session.headers.get("User-Agent", "Mozilla/5.0")
    )
    ex.catalog_headers = {
        "User-Agent": user_agent,
        "Referer": "https://www.tiktok.com/",
    }

    def readonly(url, *args, **kwargs):
        parsed = urlparse(url)
        if (
            parsed.scheme != "https"
            or parsed.hostname != "www.tiktok.com"
            or kwargs.get("method", "GET").upper() != "GET"
        ):
            raise ProviderError("TIKTOK_READ_GUARD_REJECTED")
        if not (
            parsed.path.startswith("/@")
            or parsed.path
            in (
                "/api/post/item_list/",
                "/api/repost/item_list/",
                "/api/story/item_list/",
                "/api/favorite/item_list/",
            )
        ):
            raise ProviderError("TIKTOK_READ_GUARD_REJECTED")
        kwargs["allow_redirects"] = False
        response = (
            transport.request(url) if transport else original(url, *args, **kwargs)
        )
        if response.status_code != 200:
            raise ProviderError("TIKTOK_HTTP_REJECTED")
        return response

    ex.request = readonly
    if request.get("itemId"):
        iid = identifier(request["itemId"])
        detail = ex._extract_rehydration_data(
            f"https://www.tiktok.com/@{name}/video/{iid}"
        )["webapp.video-detail"]
        if str(detail.get("statusCode")) != "0":
            raise ProviderError("TIKTOK_ITEM_UNAVAILABLE")
        item = normalize(detail["itemInfo"]["itemStruct"], ex)
        if item["id"] != iid:
            raise ProviderError("TIKTOK_ITEM_IDENTITY_INVALID")
        return {"version": 1, "items": [item]}
    detail = ex._extract_rehydration_data_user(f"https://www.tiktok.com/@{name}")
    profile = detail["userInfo"]["user"]
    uid = identifier(profile.get("id"))
    sec_uid = profile.get("secUid")
    if not isinstance(sec_uid, str) or not sec_uid:
        raise ProviderError("TIKTOK_SECUID_MISSING")
    result = {
        "version": 1,
        "userId": uid,
        "username": name,
        "kind": kind,
        "items": [],
        "cursor": "0",
        "hasMore": False,
    }
    if kind == "profile":
        avatar = media_url(
            profile.get("avatarLarger")
            or profile.get("avatarMedium")
            or profile.get("avatarThumb")
        )
        result["profile"] = {
            "id": uid,
            "username": profile.get("uniqueId", name),
            "nickname": str(profile.get("nickname") or ""),
            "bio": str(profile.get("signature") or ""),
            "avatarKey": urlparse(avatar).path,
        }
        result["avatar"] = avatar
        return result
    classes = {
        "post": tiktok.TiktokPostItemListRequest,
        "repost": tiktok.TiktokRepostItemListRequest,
        "story": tiktok.TiktokStoryItemListRequest,
        "like": tiktok.TiktokFavoriteItemListRequest,
    }
    req = classes[kind]() if kind == "story" else classes[kind](None)
    query = {"count": "20"}
    if kind == "story":
        query.update(authorId=uid, loadBackward="false")
    else:
        query.update(
            secUid=sec_uid, post_item_list_request_type="0", needPinnedItemIds="false"
        )
    cursor_type = req.cursor_type(query)
    cursor = cursor_type()
    raw_cursor = request.get("cursor") or "0"
    if not re.fullmatch(r"\d{1,30}", raw_cursor):
        raise ProviderError("TIKTOK_CURSOR_INVALID")
    cursor.cursor = int(raw_cursor)
    data, _ = req._request_data(ex, cursor, query)
    rows, next_cursor, more = checked_page(data, kind, raw_cursor)
    result.update(items=normalize_page(rows, ex), cursor=next_cursor, hasMore=more)
    return result


def main():
    logging.disable(logging.CRITICAL)
    try:
        request = json.load(sys.stdin)
        with contextlib.redirect_stdout(sys.stderr):
            if request.get("browser"):
                from catalog_browser import BrowserTransport

                transport = BrowserTransport(request["username"], request["cookies"])
                try:
                    result = fetch_page(request, transport)
                finally:
                    transport.close()
            else:
                result = fetch_page(request)
        json.dump(result, sys.stdout)
    except Exception as error:
        reason = (
            str(error)
            if re.fullmatch(r"TIKTOK_[A-Z0-9_]+", str(error))
            else "TIKTOK_PROVIDER_FAILED"
        )
        json.dump({"error": reason}, sys.stdout)
        sys.exit(1)


if __name__ == "__main__":
    main()
