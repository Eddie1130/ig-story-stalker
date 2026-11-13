#!/usr/bin/env python3
"""
x_archive.py

Long-running X/Twitter account archiver using twscrape.

Goals:
- Include the target account's own posts AND its reply-posts.
- Keep text, reply/conversation relationships, image URLs, video URLs/variants,
  quote/retweet media, and the full parsed twscrape object.
- Work around the ~3200 user-timeline ceiling by combining timelines with
  date-windowed SearchTimeline passes.
- Let twscrape handle per-account/per-endpoint rate limits and account rotation.
- Resume safely after Ctrl-C/network failure using SQLite checkpoints.
- Deduplicate by tweet/post ID.
- Use multiple differently aligned/search-filtered passes in --mode deep to
  maximize coverage.

This does NOT fetch every other user's replies underneath each target post.
It archives posts/replies AUTHORED BY the target account.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import uuid
import random
import sqlite3
import sys
import time
from contextlib import aclosing, asynccontextmanager, suppress
from dataclasses import asdict, is_dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from time import monotonic
from typing import Any, AsyncIterator

try:
    from twscrape import API
except ImportError:
    API = None


def write_progress(path: Path | str | None, payload: dict) -> None:
    """Only expose stable non-secret job fields to the Telegram controller."""
    if not path:
        return
    allowed = {"status", "stage", "username", "start", "end", "posts", "completedWindows",
               "partialWindows", "failedWindows", "reason", "at", "timelineFailures",
               "totalWindows", "remainingWindows", "passes", "currentPass",
               "windowStart", "windowEnd", "lastWorkStage"}
    record = {key: value for key, value in payload.items() if key in allowed}
    record["at"] = int(time.time() * 1000)
    target = Path(path).expanduser().absolute()
    if target.is_symlink():
        raise ValueError("X_UNSAFE_PATH")
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with temporary.open("x", encoding="utf-8") as stream:
            os.chmod(temporary, 0o600)
            json.dump(record, stream, ensure_ascii=False)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)


def resolve_start(start: date | None, target: Any, end: date) -> date:
    if start is None:
        created = getattr(target, "created", None)
        if not isinstance(created, datetime) or created.tzinfo is None:
            raise ValueError("X_START_DATE_REQUIRED")
        start = created.astimezone(timezone.utc).date()
        if start < date(2006, 3, 21) or start > datetime.now(timezone.utc).date():
            raise ValueError("X_START_DATE_REQUIRED")
    if start >= end:
        raise ValueError("X_INVALID_DATE_RANGE")
    return start


def failure_reason(error: BaseException) -> str:
    if type(error).__name__ == "NoAccountError":
        return "X_NO_ACCOUNT_AVAILABLE"
    if isinstance(error, ValueError) and re.fullmatch(r"X_[A-Z_]+", str(error)):
        return str(error)
    if isinstance(error, (TimeoutError, asyncio.TimeoutError)):
        return "X_HISTORY_TIMEOUT"
    if isinstance(error, ImportError):
        return "X_TWSCRAPE_NOT_INSTALLED"
    if isinstance(error, OSError):
        return "X_HISTORY_STORAGE_ERROR"
    return "X_HISTORY_FAILED"


# ------------------------- JSON / model helpers -------------------------


def json_default(obj: Any):
    if isinstance(obj, (datetime, date)):
        return obj.isoformat()
    if is_dataclass(obj):
        return asdict(obj)
    if hasattr(obj, "dict"):
        return obj.dict()
    if hasattr(obj, "__dict__"):
        return obj.__dict__
    return str(obj)


def model_dict(obj: Any) -> dict:
    if obj is None:
        return {}
    try:
        value = obj.dict()
        if isinstance(value, dict):
            return value
    except Exception:
        pass
    if is_dataclass(obj):
        return asdict(obj)
    return dict(getattr(obj, "__dict__", {}))


def safe_username(user: Any) -> str | None:
    return getattr(user, "username", None) if user is not None else None


def media_from_tweet(tweet: Any) -> dict:
    media = getattr(tweet, "media", None)
    if media is None:
        return {"images": [], "videos": [], "animated_gifs": []}

    images = []
    for p in getattr(media, "photos", []) or []:
        url = getattr(p, "url", None)
        if url:
            images.append(url)

    videos = []
    for v in getattr(media, "videos", []) or []:
        variants = []
        for x in getattr(v, "variants", []) or []:
            url = getattr(x, "url", None)
            if not url:
                continue
            variants.append(
                {
                    "url": url,
                    "bitrate": getattr(x, "bitrate", None),
                    "content_type": getattr(x, "contentType", None),
                }
            )

        variants.sort(
            key=lambda x: (x["bitrate"] is not None, x["bitrate"] or -1),
            reverse=True,
        )

        videos.append(
            {
                "thumbnail_url": getattr(v, "thumbnailUrl", None),
                "duration_ms": getattr(v, "duration", None),
                "views": getattr(v, "views", None),
                "best_url": variants[0]["url"] if variants else None,
                "variants": variants,
            }
        )

    animated = []
    for g in getattr(media, "animated", []) or []:
        animated.append(
            {
                "thumbnail_url": getattr(g, "thumbnailUrl", None),
                "video_url": getattr(g, "videoUrl", None),
            }
        )

    return {
        "images": list(dict.fromkeys(images)),
        "videos": videos,
        "animated_gifs": animated,
    }


def compact_embedded_tweet(tweet: Any) -> dict | None:
    if tweet is None:
        return None
    user = getattr(tweet, "user", None)
    return {
        "id": str(getattr(tweet, "id", "")),
        "url": getattr(tweet, "url", None),
        "date": getattr(tweet, "date", None).isoformat()
        if getattr(tweet, "date", None)
        else None,
        "username": safe_username(user),
        "text": getattr(tweet, "rawContent", None),
        "media": media_from_tweet(tweet),
    }


def normalize_tweet(tweet: Any, source: str) -> dict:
    user = getattr(tweet, "user", None)
    reply_user = getattr(tweet, "inReplyToUser", None)
    media = media_from_tweet(tweet)
    raw = model_dict(tweet)

    return {
        "id": str(getattr(tweet, "id", "")),
        "url": getattr(tweet, "url", None),
        "date": getattr(tweet, "date", None).isoformat()
        if getattr(tweet, "date", None)
        else None,
        "user_id": str(getattr(user, "id", "")) if user is not None else None,
        "username": safe_username(user),
        "text": getattr(tweet, "rawContent", ""),
        "lang": getattr(tweet, "lang", None),
        "is_reply": getattr(tweet, "inReplyToTweetId", None) is not None,
        "in_reply_to_tweet_id": (
            str(getattr(tweet, "inReplyToTweetId", ""))
            if getattr(tweet, "inReplyToTweetId", None) is not None
            else None
        ),
        "in_reply_to_username": (
            safe_username(reply_user)
            or getattr(tweet, "inReplyToScreenName", None)
        ),
        "conversation_id": (
            str(getattr(tweet, "conversationId", ""))
            if getattr(tweet, "conversationId", None) is not None
            else None
        ),
        "reply_count": getattr(tweet, "replyCount", None),
        "retweet_count": getattr(tweet, "retweetCount", None),
        "like_count": getattr(tweet, "likeCount", None),
        "quote_count": getattr(tweet, "quoteCount", None),
        "view_count": getattr(tweet, "viewCount", None),
        "hashtags": list(getattr(tweet, "hashtags", []) or []),
        "media": media,
        "quoted_tweet": compact_embedded_tweet(
            getattr(tweet, "quotedTweet", None)
        ),
        "retweeted_tweet": compact_embedded_tweet(
            getattr(tweet, "retweetedTweet", None)
        ),
        "source": source,
        "raw_twscrape": raw,
    }


# ------------------------- SQLite archive -------------------------


class ArchiveDB:
    def __init__(self, path: Path):
        self.path = path
        self.conn = sqlite3.connect(path)
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA synchronous=NORMAL")
        self._pending = 0
        self.progress = None
        self.search_plan = None
        self.progress_context = {"stage": "resolve", "lastWorkStage": "resolve",
                                 "currentPass": None, "windowStart": None, "windowEnd": None}
        self.timeline_failures = []
        self.failure = None
        self.job_scoped = False
        self._init_schema()

    def _init_schema(self):
        self.conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS tweets (
                id TEXT PRIMARY KEY,
                date TEXT,
                username TEXT,
                url TEXT,
                text TEXT,
                is_reply INTEGER NOT NULL DEFAULT 0,
                in_reply_to_tweet_id TEXT,
                in_reply_to_username TEXT,
                conversation_id TEXT,
                media_json TEXT NOT NULL,
                quoted_json TEXT,
                retweeted_json TEXT,
                raw_json TEXT NOT NULL,
                sources_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_tweets_date
                ON tweets(date);
            CREATE INDEX IF NOT EXISTS idx_tweets_reply
                ON tweets(is_reply);

            CREATE TABLE IF NOT EXISTS windows (
                window_key TEXT PRIMARY KEY,
                pass_name TEXT NOT NULL,
                start_date TEXT NOT NULL,
                end_date TEXT NOT NULL,
                query TEXT NOT NULL,
                status TEXT NOT NULL,
                fetched INTEGER NOT NULL DEFAULT 0,
                kept INTEGER NOT NULL DEFAULT 0,
                duplicates INTEGER NOT NULL DEFAULT 0,
                wrong_author INTEGER NOT NULL DEFAULT 0,
                attempts INTEGER NOT NULL DEFAULT 0,
                note TEXT,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            """
        )
        self.conn.commit()

    def close(self):
        self.conn.commit()
        self.conn.close()

    def begin_job(self):
        # Checkpoints persist across jobs, but completion describes this invocation.
        self.conn.execute("CREATE TEMP TABLE IF NOT EXISTS job_windows (window_key TEXT PRIMARY KEY)")
        self.conn.execute("DELETE FROM job_windows")
        self.job_scoped = True

    def track_window(self, key: str):
        if self.job_scoped:
            self.conn.execute("INSERT OR IGNORE INTO job_windows(window_key) VALUES(?)", (key,))

    def window_counts(self) -> dict:
        join = " JOIN job_windows USING(window_key)" if self.job_scoped else ""
        return dict(self.conn.execute("SELECT status, COUNT(*) FROM windows" + join + " GROUP BY status").fetchall())

    def report_work(self, stage: str, pass_name: str | None = None,
                    start: date | None = None, end: date | None = None):
        self.progress_context.update({"stage": stage, "lastWorkStage": stage,
                                      "currentPass": pass_name,
                                      "windowStart": start.isoformat() if start else None,
                                      "windowEnd": end.isoformat() if end else None})
        if self.progress:
            self.progress()

    def set_meta(self, key: str, value: Any):
        if not isinstance(value, str):
            value = json.dumps(value, ensure_ascii=False, default=json_default)
        self.conn.execute(
            """
            INSERT INTO meta(key, value) VALUES(?, ?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value
            """,
            (key, value),
        )
        self.conn.commit()

    def window_status(self, key: str) -> str | None:
        row = self.conn.execute(
            "SELECT status FROM windows WHERE window_key=?", (key,)
        ).fetchone()
        return row[0] if row else None

    def mark_window(
        self,
        key: str,
        pass_name: str,
        start: date,
        end: date,
        query: str,
        status: str,
        fetched: int = 0,
        kept: int = 0,
        duplicates: int = 0,
        wrong_author: int = 0,
        attempts: int = 0,
        note: str | None = None,
    ):
        now = datetime.now(timezone.utc).isoformat()
        self.conn.execute(
            """
            INSERT INTO windows(
                window_key, pass_name, start_date, end_date, query,
                status, fetched, kept, duplicates, wrong_author,
                attempts, note, updated_at
            )
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(window_key) DO UPDATE SET
                status=excluded.status,
                fetched=excluded.fetched,
                kept=excluded.kept,
                duplicates=excluded.duplicates,
                wrong_author=excluded.wrong_author,
                attempts=excluded.attempts,
                note=excluded.note,
                updated_at=excluded.updated_at
            """,
            (
                key,
                pass_name,
                start.isoformat(),
                end.isoformat(),
                query,
                status,
                fetched,
                kept,
                duplicates,
                wrong_author,
                attempts,
                note,
                now,
            ),
        )
        self.conn.commit()
        if self.progress:
            self.progress()

    def upsert_tweet(self, record: dict, source: str) -> bool:
        tweet_id = record["id"]
        if not tweet_id:
            return False

        row = self.conn.execute(
            "SELECT sources_json FROM tweets WHERE id=?", (tweet_id,)
        ).fetchone()

        if row:
            try:
                sources = set(json.loads(row[0]))
            except Exception:
                sources = set()
            is_new = False
        else:
            sources = set()
            is_new = True

        sources.add(source)
        now = datetime.now(timezone.utc).isoformat()

        self.conn.execute(
            """
            INSERT INTO tweets(
                id, date, username, url, text, is_reply,
                in_reply_to_tweet_id, in_reply_to_username, conversation_id,
                media_json, quoted_json, retweeted_json, raw_json,
                sources_json, updated_at
            )
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET
                date=excluded.date,
                username=excluded.username,
                url=excluded.url,
                text=excluded.text,
                is_reply=excluded.is_reply,
                in_reply_to_tweet_id=excluded.in_reply_to_tweet_id,
                in_reply_to_username=excluded.in_reply_to_username,
                conversation_id=excluded.conversation_id,
                media_json=excluded.media_json,
                quoted_json=excluded.quoted_json,
                retweeted_json=excluded.retweeted_json,
                raw_json=excluded.raw_json,
                sources_json=excluded.sources_json,
                updated_at=excluded.updated_at
            """,
            (
                tweet_id,
                record["date"],
                record["username"],
                record["url"],
                record["text"],
                1 if record["is_reply"] else 0,
                record["in_reply_to_tweet_id"],
                record["in_reply_to_username"],
                record["conversation_id"],
                json.dumps(record["media"], ensure_ascii=False, default=json_default),
                json.dumps(
                    record["quoted_tweet"],
                    ensure_ascii=False,
                    default=json_default,
                )
                if record["quoted_tweet"] is not None
                else None,
                json.dumps(
                    record["retweeted_tweet"],
                    ensure_ascii=False,
                    default=json_default,
                )
                if record["retweeted_tweet"] is not None
                else None,
                json.dumps(
                    record["raw_twscrape"],
                    ensure_ascii=False,
                    default=json_default,
                ),
                json.dumps(sorted(sources), ensure_ascii=False),
                now,
            ),
        )

        self._pending += 1
        if self._pending >= 25:
            self.conn.commit()
            self._pending = 0

        return is_new

    def commit(self):
        self.conn.commit()
        self._pending = 0

    def count(self) -> int:
        return self.conn.execute("SELECT COUNT(*) FROM tweets").fetchone()[0]

    def export(self, out_dir: Path, username: str):
        self.commit()

        jsonl_path = out_dir / f"{username}_posts.jsonl"
        media_path = out_dir / f"{username}_media_urls.txt"
        summary_path = out_dir / f"{username}_summary.json"

        media_urls: set[str] = set()
        total = 0
        replies = 0
        with_media = 0
        oldest = None
        newest = None

        rows = self.conn.execute(
            """
            SELECT
                id, date, username, url, text, is_reply,
                in_reply_to_tweet_id, in_reply_to_username, conversation_id,
                media_json, quoted_json, retweeted_json,
                raw_json, sources_json
            FROM tweets
            ORDER BY date ASC, id ASC
            """
        )

        with jsonl_path.open("w", encoding="utf-8") as f:
            for row in rows:
                (
                    tid,
                    dt,
                    uname,
                    url,
                    text,
                    is_reply,
                    reply_to_id,
                    reply_to_username,
                    conversation_id,
                    media_json,
                    quoted_json,
                    retweeted_json,
                    raw_json,
                    sources_json,
                ) = row

                media = json.loads(media_json)
                quoted = json.loads(quoted_json) if quoted_json else None
                retweeted = json.loads(retweeted_json) if retweeted_json else None

                record = {
                    "id": tid,
                    "url": url,
                    "date": dt,
                    "username": uname,
                    "text": text,
                    "is_reply": bool(is_reply),
                    "in_reply_to_tweet_id": reply_to_id,
                    "in_reply_to_username": reply_to_username,
                    "conversation_id": conversation_id,
                    "media": media,
                    "quoted_tweet": quoted,
                    "retweeted_tweet": retweeted,
                    "sources": json.loads(sources_json),
                    "raw_twscrape": json.loads(raw_json),
                }

                f.write(
                    json.dumps(
                        record,
                        ensure_ascii=False,
                        default=json_default,
                    )
                    + "\n"
                )

                total += 1
                replies += int(bool(is_reply))
                if (
                    media.get("images")
                    or media.get("videos")
                    or media.get("animated_gifs")
                ):
                    with_media += 1

                if dt:
                    oldest = dt if oldest is None else min(oldest, dt)
                    newest = dt if newest is None else max(newest, dt)

                collect_media_urls(media_urls, media)
                if quoted:
                    collect_media_urls(media_urls, quoted.get("media", {}))
                if retweeted:
                    collect_media_urls(media_urls, retweeted.get("media", {}))

        media_path.write_text(
            "\n".join(sorted(media_urls)) + ("\n" if media_urls else ""),
            encoding="utf-8",
        )

        status_counts = self.window_counts()
        unfinished_plan = self.search_plan is not None and search_progress(self, *self.search_plan)["remainingWindows"] > 0

        summary = {
            "username": username,
            "posts": total,
            "reply_posts": replies,
            "posts_with_own_media": with_media,
            "unique_media_urls_including_embedded_quotes_retweets": len(media_urls),
            "oldest_date": oldest,
            "newest_date": newest,
            "window_status_counts": status_counts,
            "timeline_failures": list(self.timeline_failures),
            "status": "failed" if self.failure else "partial" if self.timeline_failures or unfinished_plan or any(status_counts.get(state, 0) for state in ("partial", "failed", "working")) else "complete",
            "reason": self.failure,
            "generated_at": datetime.now(timezone.utc).isoformat(),
            "files": {
                "jsonl": str(jsonl_path),
                "media_urls": str(media_path),
                "sqlite": str(self.path),
            },
        }
        summary_path.write_text(
            json.dumps(summary, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )

        return jsonl_path, media_path, summary_path, summary


def collect_media_urls(dest: set[str], media: dict):
    for url in media.get("images", []) or []:
        if url:
            dest.add(url)
    for video in media.get("videos", []) or []:
        if video.get("thumbnail_url"):
            dest.add(video["thumbnail_url"])
        for variant in video.get("variants", []) or []:
            if variant.get("url"):
                dest.add(variant["url"])
    for gif in media.get("animated_gifs", []) or []:
        if gif.get("thumbnail_url"):
            dest.add(gif["thumbnail_url"])
        if gif.get("video_url"):
            dest.add(gif["video_url"])


# ------------------------- Scraping -------------------------


def window_key(pass_name: str, start: date, end: date) -> str:
    return f"{pass_name}:{start.isoformat()}:{end.isoformat()}"


def iter_windows(
    start: date,
    end: date,
    days: int,
    offset_days: int = 0,
):
    """
    end is exclusive.

    offset_days changes the grouping boundaries for a verification pass.
    Example: main pass uses 7-day windows starting Jan 1; verify can use
    7-day windows starting Jan 4 so the same posts are searched under
    differently aligned windows.
    """
    if start >= end:
        return

    cursor = start

    if offset_days > 0:
        head_end = min(start + timedelta(days=offset_days), end)
        if cursor < head_end:
            yield cursor, head_end
        cursor = head_end

    while cursor < end:
        nxt = min(cursor + timedelta(days=days), end)
        yield cursor, nxt
        cursor = nxt


def split_midpoint(start: date, end: date) -> date:
    span = (end - start).days
    return start + timedelta(days=max(1, span // 2))


def search_progress(db: ArchiveDB, start: date, end: date, mode: str = "deep",
                    window_days: int = 7, special_window_days: int = 28) -> dict:
    """Count planned root windows; recursive split work never changes the total.

    A root split is complete only when every deterministic descendant is done.
    Partial/failed counts describe roots, and remaining includes both categories.
    Only exact root keys for this range/mode participate, including on resume.
    """
    if mode not in {"fast", "balanced", "deep"} or window_days < 1 or special_window_days < 1:
        raise ValueError("X_INVALID_SEARCH_PLAN")
    passes = [("search_main", window_days, 0)]
    if mode in {"balanced", "deep"}:
        passes.extend([("search_replies", special_window_days, 0),
                       ("search_media", special_window_days, 0)])
    if mode == "deep":
        passes.append(("search_verify", window_days, max(1, window_days // 2)))
    states = dict(db.conn.execute("SELECT window_key, status FROM windows").fetchall())
    resolved = {}

    def root_state(name, left, right):
        key = window_key(name, left, right)
        if key in resolved:
            return resolved[key]
        state = states.get(key)
        if state == "split":
            if (right - left).days <= 1:
                state = "partial"
            else:
                mid = split_midpoint(left, right)
                children = (root_state(name, left, mid), root_state(name, mid, right))
                state = ("done" if all(child == "done" for child in children) else
                         "failed" if "failed" in children else
                         "partial" if "partial" in children else None)
        resolved[key] = state
        return state

    totals = []
    for name, days, offset in passes:
        roots = [root_state(name, left, right) for left, right in iter_windows(start, end, days, offset)]
        totals.append({"name": name, "total": len(roots), "completed": roots.count("done"),
                       "partial": roots.count("partial"), "failed": roots.count("failed")})
    total = sum(item["total"] for item in totals)
    completed = sum(item["completed"] for item in totals)
    return {"totalWindows": total, "completedWindows": completed,
            "remainingWindows": total - completed,
            "partialWindows": sum(item["partial"] for item in totals),
            "failedWindows": sum(item["failed"] for item in totals), "passes": totals}


@asynccontextmanager
async def activity_progress(db: ArchiveDB, interval: float = 5.0, min_interval: float = 1.0):
    """Publish bounded heartbeats while an upstream iterator is waiting on I/O."""
    last_report = monotonic()

    def pulse():
        nonlocal last_report
        now = monotonic()
        if db.progress and now - last_report >= min_interval:
            db.progress()
            last_report = now

    async def heartbeat():
        while True:
            await asyncio.sleep(interval)
            pulse()

    task = asyncio.create_task(heartbeat()) if db.progress else None
    try:
        yield pulse
    finally:
        if task:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task


async def consume_timeline(
    gen: AsyncIterator,
    db: ArchiveDB,
    target_user_id: int,
    source: str,
) -> tuple[int, int]:
    fetched = 0
    new = 0

    async with activity_progress(db) as pulse, aclosing(gen) as stream:
        async for tw in stream:
            fetched += 1
            user = getattr(tw, "user", None)
            if user is not None and int(getattr(user, "id", -1)) == int(target_user_id):
                rec = normalize_tweet(tw, source)
                if db.upsert_tweet(rec, source):
                    new += 1
            if fetched % 100 == 0:
                pulse()

    db.commit()
    return fetched, new


async def run_timeline_passes(
    api: API,
    db: ArchiveDB,
    target_user_id: int,
    timeline_limit: int,
):
    failures = []
    db.timeline_failures = failures
    db.report_work("timeline_posts")
    print("\n[1/5] Recent user_tweets_and_replies timeline")
    try:
        fetched, new = await consume_timeline(
            api.user_tweets_and_replies(target_user_id, limit=timeline_limit),
            db,
            target_user_id,
            "user_tweets_and_replies",
        )
        print(f"  fetched={fetched:,}  new={new:,}  archive={db.count():,}")
    except Exception as e:
        if type(e).__name__ == "NoAccountError":
            raise
        failures.append("user_tweets_and_replies")
        print(f"  timeline warning: {failure_reason(e)}", file=sys.stderr)

    db.report_work("timeline_media")
    print("\n[2/5] Recent user_media timeline")
    try:
        fetched, new = await consume_timeline(
            api.user_media(target_user_id, limit=timeline_limit),
            db,
            target_user_id,
            "user_media",
        )
        print(f"  fetched={fetched:,}  new={new:,}  archive={db.count():,}")
    except Exception as e:
        if type(e).__name__ == "NoAccountError":
            raise
        failures.append("user_media")
        print(f"  media timeline warning: {failure_reason(e)}", file=sys.stderr)
    return failures


async def search_window_once(
    api: API,
    db: ArchiveDB,
    username: str,
    target_user_id: int,
    pass_name: str,
    start: date,
    end: date,
    suffix: str,
    search_limit: int,
):
    parts = [
        f"from:{username}",
        f"since:{start.isoformat()}",
        f"until:{end.isoformat()}",
    ]
    if suffix.strip():
        parts.append(suffix.strip())
    query = " ".join(parts)

    local_ids: set[str] = set()
    fetched = 0
    kept = 0
    duplicates = 0
    wrong_author = 0
    outside_window = 0

    gen = api.search(query, limit=search_limit)

    async with activity_progress(db), aclosing(gen) as stream:
        async for tw in stream:
            fetched += 1
            tid = str(getattr(tw, "id", ""))

            if tid in local_ids:
                duplicates += 1
                continue
            local_ids.add(tid)

            # SearchTimeline has had bugs where quoted tweets from another
            # author appear as top-level results. Never trust the query alone.
            user = getattr(tw, "user", None)
            uid = getattr(user, "id", None)
            if uid is None or int(uid) != int(target_user_id):
                wrong_author += 1
                continue

            tw_dt = getattr(tw, "date", None)
            if tw_dt is not None:
                d = tw_dt.date()
                if not (start <= d < end):
                    outside_window += 1
                    continue

            rec = normalize_tweet(tw, pass_name)
            db.upsert_tweet(rec, pass_name)
            kept += 1

    db.commit()

    suspicious = False
    reasons = []

    # Search pagination has historically repeated pages/cursors. Current
    # twscrape detects repeated cursors/pages too, but this is a second guard.
    if fetched >= 40 and duplicates / max(fetched, 1) >= 0.50:
        suspicious = True
        reasons.append(f"duplicate_ratio={duplicates/fetched:.2f}")

    if fetched >= int(search_limit * 0.90):
        suspicious = True
        reasons.append("near_search_limit")

    if wrong_author >= 20 and kept == 0:
        suspicious = True
        reasons.append("many_wrong_author_results")

    if outside_window:
        reasons.append(f"outside_window={outside_window}")

    return {
        "query": query,
        "fetched": fetched,
        "kept": kept,
        "duplicates": duplicates,
        "wrong_author": wrong_author,
        "suspicious": suspicious,
        "note": ", ".join(reasons) if reasons else None,
    }


async def process_search_window(
    api: API,
    db: ArchiveDB,
    username: str,
    target_user_id: int,
    pass_name: str,
    start: date,
    end: date,
    suffix: str,
    search_limit: int,
    max_retries: int,
    jitter_min: float,
    jitter_max: float,
):
    key = window_key(pass_name, start, end)
    db.track_window(key)
    status = db.window_status(key)

    if status == "done":
        return

    db.report_work("search", pass_name, start, end)

    # If this parent was split on an earlier run, deterministically descend
    # again so failed/interrupted child windows are not lost.
    if status == "split":
        if (end - start).days <= 1:
            return
        mid = split_midpoint(start, end)
        await process_search_window(
            api, db, username, target_user_id, pass_name,
            start, mid, suffix, search_limit, max_retries,
            jitter_min, jitter_max,
        )
        await process_search_window(
            api, db, username, target_user_id, pass_name,
            mid, end, suffix, search_limit, max_retries,
            jitter_min, jitter_max,
        )
        return

    query = " ".join(
        x for x in [
            f"from:{username}",
            f"since:{start.isoformat()}",
            f"until:{end.isoformat()}",
            suffix.strip(),
        ] if x
    )

    last_error = None

    for attempt in range(1, max_retries + 1):
        try:
            result = await search_window_once(
                api=api,
                db=db,
                username=username,
                target_user_id=target_user_id,
                pass_name=pass_name,
                start=start,
                end=end,
                suffix=suffix,
                search_limit=search_limit,
            )

            print(
                f"  {pass_name:<16} {start} -> {end}  "
                f"fetched={result['fetched']:<5} "
                f"kept={result['kept']:<5} "
                f"dup={result['duplicates']:<4} "
                f"wrong={result['wrong_author']:<4}"
                + (f"  [{result['note']}]" if result["note"] else "")
            )

            if result["suspicious"] and (end - start).days > 1:
                db.mark_window(
                    key, pass_name, start, end, result["query"],
                    "split",
                    result["fetched"],
                    result["kept"],
                    result["duplicates"],
                    result["wrong_author"],
                    attempt,
                    "Suspicious result; split into smaller date windows. "
                    + (result["note"] or ""),
                )
                mid = split_midpoint(start, end)
                await process_search_window(
                    api, db, username, target_user_id, pass_name,
                    start, mid, suffix, search_limit, max_retries,
                    jitter_min, jitter_max,
                )
                await process_search_window(
                    api, db, username, target_user_id, pass_name,
                    mid, end, suffix, search_limit, max_retries,
                    jitter_min, jitter_max,
                )
                return

            final_status = "partial" if result["suspicious"] else "done"
            db.mark_window(
                key, pass_name, start, end, result["query"],
                final_status,
                result["fetched"],
                result["kept"],
                result["duplicates"],
                result["wrong_author"],
                attempt,
                result["note"],
            )

            if jitter_max > 0:
                await asyncio.sleep(random.uniform(jitter_min, jitter_max))
            return

        except asyncio.CancelledError:
            raise
        except KeyboardInterrupt:
            raise
        except Exception as e:
            if type(e).__name__ == "NoAccountError":
                raise
            last_error = failure_reason(e)
            db.mark_window(
                key,
                pass_name,
                start,
                end,
                query,
                "failed",
                attempts=attempt,
                note=last_error,
            )
            print(
                f"  ERROR {pass_name} {start}->{end} "
                f"attempt {attempt}/{max_retries}: {last_error}",
                file=sys.stderr,
            )

            if attempt < max_retries:
                # Rate-limit waiting normally happens INSIDE twscrape.
                # This backoff is only for exceptions such as transient
                # network/GraphQL failures.
                await asyncio.sleep(min(60, 5 * (3 ** (attempt - 1))))

    # Persistent error: smaller date window often avoids problematic
    # SearchTimeline pages. Split until one-day granularity.
    if (end - start).days > 1:
        db.mark_window(
            key,
            pass_name,
            start,
            end,
            query,
            "split",
            attempts=max_retries,
            note=f"Persistent error; split after: {last_error}",
        )
        mid = split_midpoint(start, end)
        await process_search_window(
            api, db, username, target_user_id, pass_name,
            start, mid, suffix, search_limit, max_retries,
            jitter_min, jitter_max,
        )
        await process_search_window(
            api, db, username, target_user_id, pass_name,
            mid, end, suffix, search_limit, max_retries,
            jitter_min, jitter_max,
        )


async def run_search_pass(
    api: API,
    db: ArchiveDB,
    username: str,
    target_user_id: int,
    pass_name: str,
    start: date,
    end: date,
    days: int,
    suffix: str,
    search_limit: int,
    max_retries: int,
    jitter_min: float,
    jitter_max: float,
    offset_days: int = 0,
):
    print(
        f"\n[{pass_name}] days={days}, offset={offset_days}, "
        f"filter={suffix or '(none)'}"
    )

    for ws, we in iter_windows(start, end, days, offset_days=offset_days):
        await process_search_window(
            api=api,
            db=db,
            username=username,
            target_user_id=target_user_id,
            pass_name=pass_name,
            start=ws,
            end=we,
            suffix=suffix,
            search_limit=search_limit,
            max_retries=max_retries,
            jitter_min=jitter_min,
            jitter_max=jitter_max,
        )


# ------------------------- CLI / main -------------------------


def parse_iso_date(value: str) -> date:
    try:
        return date.fromisoformat(value)
    except ValueError as e:
        raise argparse.ArgumentTypeError(
            f"Invalid date {value!r}; expected YYYY-MM-DD"
        ) from e


def make_parser():
    p = argparse.ArgumentParser(
        description=(
            "Archive as many posts/replies/media URLs as possible from one "
            "X/Twitter account using twscrape."
        )
    )
    p.add_argument("username", help="X handle, with or without @")
    p.add_argument(
        "--start",
        type=parse_iso_date,
        default=None,
        help="Earliest date to search; defaults to the account creation date",
    )
    p.add_argument(
        "--end",
        type=parse_iso_date,
        default=None,
        help=(
            "Exclusive end date. Default: tomorrow in UTC, so today's posts "
            "are included."
        ),
    )
    p.add_argument(
        "--accounts-db",
        default="accounts.db",
        help="twscrape account DB (default: ./accounts.db)",
    )
    p.add_argument(
        "--out",
        default=None,
        help="Output directory (default: ./x_archive_<username>)",
    )
    p.add_argument(
        "--mode",
        choices=["fast", "balanced", "deep"],
        default="deep",
        help=(
            "deep = main + shifted verification + reply + media passes; "
            "balanced = main + reply + media; fast = main only. "
            "Default: deep."
        ),
    )
    p.add_argument(
        "--window-days",
        type=int,
        default=7,
        help="Main search window size (default: 7 days)",
    )
    p.add_argument(
        "--special-window-days",
        type=int,
        default=28,
        help="Reply/media supplement window size (default: 28 days)",
    )
    p.add_argument(
        "--timeline-limit",
        type=int,
        default=5000,
        help=(
            "Requested timeline limit. X itself caps user timelines around "
            "3200; default 5000 intentionally asks for the maximum available."
        ),
    )
    p.add_argument(
        "--search-limit",
        type=int,
        default=5000,
        help="Per-date-window search safety limit (default: 5000)",
    )
    p.add_argument(
        "--max-retries",
        type=int,
        default=3,
        help="Retries for thrown errors, not rate-limit waits (default: 3)",
    )
    p.add_argument(
        "--jitter-min",
        type=float,
        default=0.4,
        help="Minimum polite delay between completed search windows",
    )
    p.add_argument(
        "--jitter-max",
        type=float,
        default=1.2,
        help="Maximum polite delay between completed search windows",
    )
    p.add_argument(
        "--export-only",
        action="store_true",
        help="Do not scrape; export current SQLite archive to JSONL/text",
    )
    p.add_argument("--progress", help="Atomic, sanitized JSON progress file")
    return p


async def async_main(args):
    username = args.username.removeprefix("@").lower()
    if not re.fullmatch(r"[a-z0-9_]{1,15}", username):
        raise ValueError("X_INVALID_USERNAME")
    end = args.end or (datetime.now(timezone.utc).date() + timedelta(days=1))

    if args.start is not None and args.start >= end:
        raise ValueError("X_INVALID_DATE_RANGE")

    if args.window_days < 1 or args.special_window_days < 1:
        raise SystemExit("Window sizes must be >= 1 day")

    out_dir = Path(args.out or f"x_archive_{username}").expanduser().absolute()
    if out_dir.is_symlink():
        raise ValueError("X_UNSAFE_PATH")
    out_dir.mkdir(parents=True, exist_ok=True)
    for suffix in ("_archive.sqlite", "_archive.sqlite-wal", "_archive.sqlite-shm", "_posts.jsonl", "_media_urls.txt", "_summary.json"):
        if (out_dir / (username + suffix)).is_symlink():
            raise ValueError("X_UNSAFE_PATH")

    archive_db_path = out_dir / f"{username}_archive.sqlite"
    db = ArchiveDB(archive_db_path)

    def progress(status="working", stage=None, reason=None):
        if stage:
            db.progress_context["stage"] = stage
            if stage != "stopped":
                db.progress_context["lastWorkStage"] = stage
        snapshot = search_progress(db, *db.search_plan) if db.search_plan else {
            "totalWindows": 0, "completedWindows": 0, "remainingWindows": 0,
            "partialWindows": 0, "failedWindows": 0, "passes": [],
        }
        display_start = db.search_plan[0] if db.search_plan else args.start
        write_progress(getattr(args, "progress", None), {
            "username": username, "status": status, **db.progress_context, **snapshot,
            "start": display_start.isoformat() if display_start else None, "end": end.isoformat(),
            "posts": db.count(), "timelineFailures": len(db.timeline_failures), "reason": reason,
        })
    db.progress = progress
    try:
        if not args.export_only:
            # Restore a display-only plan before profile lookup can fail. Never
            # assign the cached date to args.start or use it for actual scraping.
            display_start = args.start
            if display_start is None:
                cached = db.conn.execute("SELECT value FROM meta WHERE key='requested_start'").fetchone()
                if cached:
                    try:
                        candidate = date.fromisoformat(cached[0])
                    except (TypeError, ValueError):
                        pass
                    else:
                        if candidate < end:
                            display_start = candidate
            if display_start is not None:
                db.search_plan = (display_start, end, args.mode, args.window_days, args.special_window_days)
        progress(stage="resolve")
        if args.export_only:
            _, _, _, summary = db.export(out_dir, username)
            print(json.dumps(summary, ensure_ascii=False, indent=2))
            progress(summary["status"], "export")
            return summary

        db.begin_job()

        print(f"Target: @{username}")
        print(f"Range : {args.start} -> {end} (end exclusive)")
        print(f"Mode  : {args.mode}")
        print(f"Data  : {archive_db_path}")
        print(f"Pool  : {Path(args.accounts_db).expanduser().resolve()}")

        # Bound pool waits so missing/locked sessions become observable failures.
        if API is None:
            raise ImportError("X_TWSCRAPE_NOT_INSTALLED")
        api = API(
            str(Path(args.accounts_db).expanduser()),
            raise_when_no_account=True,
            wait_timeout=30,
            wait_interval=5.0,
        )

        print("\nResolving target account...")
        target = await api.user_by_login(username)
        if target is None:
            raise RuntimeError(
                f"Could not resolve @{username}. Check the handle and your "
                "twscrape account sessions."
            )

        args.start = resolve_start(args.start, target, end)
        db.search_plan = (args.start, end, args.mode, args.window_days, args.special_window_days)
        progress(stage="timeline_posts")
        target_user_id = int(target.id)
        print(
            f"Resolved: @{target.username}  id={target_user_id}  "
            f"reported_statuses={getattr(target, 'statusesCount', 'unknown')}"
        )

        db.set_meta("username", username)
        db.set_meta("target_user_id", str(target_user_id))
        db.set_meta("requested_start", args.start.isoformat())
        db.set_meta("requested_end_exclusive", end.isoformat())
        db.set_meta("mode", args.mode)

        db.timeline_failures = await run_timeline_passes(
            api, db, target_user_id, args.timeline_limit
        )
        progress()

        # Main historical pass: includes authored replies in normal search.
        await run_search_pass(
            api, db, username, target_user_id,
            "search_main",
            args.start, end,
            args.window_days,
            "",
            args.search_limit,
            args.max_retries,
            args.jitter_min,
            args.jitter_max,
        )

        if args.mode in ("balanced", "deep"):
            # Dedicated reply pass: helps recover reply-posts that a general
            # SearchTimeline pass omitted.
            await run_search_pass(
                api, db, username, target_user_id,
                "search_replies",
                args.start, end,
                args.special_window_days,
                "filter:replies",
                args.search_limit,
                args.max_retries,
                args.jitter_min,
                args.jitter_max,
            )

            # Dedicated media pass: helps recover image/video posts omitted
            # by the general search.
            await run_search_pass(
                api, db, username, target_user_id,
                "search_media",
                args.start, end,
                args.special_window_days,
                "filter:media",
                args.search_limit,
                args.max_retries,
                args.jitter_min,
                args.jitter_max,
            )

        if args.mode == "deep":
            # Search the whole history again, but shift window boundaries by
            # roughly half a main window. This deliberately overlaps the
            # information source without using identical queries.
            offset = max(1, args.window_days // 2)
            await run_search_pass(
                api, db, username, target_user_id,
                "search_verify",
                args.start, end,
                args.window_days,
                "",
                args.search_limit,
                args.max_retries,
                args.jitter_min,
                args.jitter_max,
                offset_days=offset,
            )

        progress(stage="export")
        print("\nExporting...")
        jsonl_path, media_path, summary_path, summary = db.export(
            out_dir, username
        )

        print("\n" + summary["status"].upper())
        print(f"Unique posts/replies : {summary['posts']:,}")
        print(f"Reply-posts          : {summary['reply_posts']:,}")
        print(f"Posts with own media : {summary['posts_with_own_media']:,}")
        print(f"Unique media URLs    : {summary['unique_media_urls_including_embedded_quotes_retweets']:,}")
        print(f"Oldest               : {summary['oldest_date']}")
        print(f"Newest               : {summary['newest_date']}")
        print(f"JSONL                : {jsonl_path}")
        print(f"Media URL list       : {media_path}")
        print(f"Summary              : {summary_path}")
        print(f"SQLite/checkpoints   : {archive_db_path}")
        progress(summary["status"], "export")
        return summary

    except BaseException as error:
        if not isinstance(error, (KeyboardInterrupt, asyncio.CancelledError)):
            # Preserve everything collected before a pool/network failure.
            db.failure = failure_reason(error)
            db.export(out_dir, username)
            progress("needs_start" if db.failure == "X_START_DATE_REQUIRED" else "failed", "stopped", db.failure)
        else:
            progress("interrupted", "stopped", "X_HISTORY_INTERRUPTED")
        raise
    finally:
        db.close()


def main():
    parser = make_parser()
    args = parser.parse_args()

    if args.jitter_min < 0 or args.jitter_max < args.jitter_min:
        parser.error("Require 0 <= --jitter-min <= --jitter-max")

    try:
        summary = asyncio.run(async_main(args))
        if summary and summary.get("status") == "partial":
            raise SystemExit(2)
    except KeyboardInterrupt:
        print(
            "\nInterrupted. Progress is already checkpointed in SQLite. "
            "Run the same command again to resume.",
            file=sys.stderr,
        )
        raise SystemExit(130)


if __name__ == "__main__":
    main()
