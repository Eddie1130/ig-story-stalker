#!/usr/bin/env python3
"""Extract media from an x_archive.py archive and build extract.md.

Input directory example:
    x_archive_someuser/
        someuser_posts.jsonl
        someuser_archive.sqlite

Output:
    x_archive_someuser/
        media/
            20240831_143022_<postid>_p01.jpg
            20240831_143022_<postid>_p02.mp4
            ...
        extract.md
        media_manifest.json

The extractor downloads:
- media attached directly to the archived post
- media embedded in quoted posts
- media embedded in retweeted posts

It chooses the highest-bitrate MP4 video variant available, retries transient
HTTP failures, skips already-downloaded files, and can be rerun safely.
"""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from typing import Any

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/152.0.0.0 Safari/537.36"
)


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Download archived X media and generate extract.md"
    )
    p.add_argument("archive_dir", help="e.g. x_archive_someuser")
    p.add_argument(
        "--jsonl",
        help="Input *_posts.jsonl; auto-detected when omitted",
    )
    p.add_argument("--timeout", type=float, default=45.0)
    p.add_argument("--retries", type=int, default=4)
    p.add_argument("--delay", type=float, default=0.2)
    p.add_argument("--overwrite", action="store_true")
    p.add_argument("--render-only", action="store_true", help="Render Markdown from the existing common media_manifest.json without downloads")
    return p.parse_args()


def detect_jsonl(archive_dir: Path) -> Path:
    files = sorted(archive_dir.glob("*_posts.jsonl"))
    if not files:
        raise SystemExit(f"No *_posts.jsonl found in {archive_dir}")
    if len(files) > 1:
        names = "\n".join(f"  {x}" for x in files)
        raise SystemExit(
            "Multiple *_posts.jsonl files found; use --jsonl:\n" + names
        )
    return files[0]


def load_jsonl(path: Path) -> list[dict]:
    posts: list[dict] = []
    with path.open("r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as e:
                print(f"WARN line {line_no}: invalid JSON: {e}", file=sys.stderr)
                continue
            if isinstance(obj, dict):
                posts.append(obj)
    return posts


def parse_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        if value.endswith("Z"):
            value = value[:-1] + "+00:00"
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def filename_prefix(post: dict) -> str:
    dt = parse_dt(post.get("date"))
    timestamp = dt.strftime("%Y%m%d_%H%M%S") if dt else "unknown_date"
    post_id = re.sub(r"[^0-9A-Za-z_-]+", "_", str(post.get("id") or "unknown"))
    return f"{timestamp}_{post_id}"


def choose_video_url(video: dict) -> str | None:
    if video.get("best_url"):
        return str(video["best_url"])

    variants = []
    for v in video.get("variants") or []:
        if not isinstance(v, dict) or not v.get("url"):
            continue
        ctype = str(v.get("content_type") or "").lower()
        bitrate = v.get("bitrate")
        variants.append(
            (
                1 if "mp4" in ctype else 0,
                bitrate if isinstance(bitrate, int) else -1,
                str(v["url"]),
            )
        )
    if not variants:
        return None
    variants.sort(reverse=True)
    return variants[0][2]


def collect_media_block(media: Any, origin: str, out: list[dict], seen: set[str]) -> None:
    if not isinstance(media, dict):
        return

    for url in media.get("images") or []:
        if url and url not in seen:
            seen.add(url)
            out.append({"url": str(url), "kind": "image", "origin": origin})

    for video in media.get("videos") or []:
        if not isinstance(video, dict):
            continue
        url = choose_video_url(video)
        if url and url not in seen:
            seen.add(url)
            out.append({"url": url, "kind": "video", "origin": origin})

    for gif in media.get("animated_gifs") or []:
        if not isinstance(gif, dict):
            continue
        url = gif.get("video_url")
        if url and url not in seen:
            seen.add(url)
            out.append({"url": str(url), "kind": "gif", "origin": origin})


def collect_post_media(post: dict) -> list[dict]:
    out: list[dict] = []
    seen: set[str] = set()

    collect_media_block(post.get("media"), "post", out, seen)

    quoted = post.get("quoted_tweet")
    if isinstance(quoted, dict):
        collect_media_block(quoted.get("media"), "quoted", out, seen)

    retweeted = post.get("retweeted_tweet")
    if isinstance(retweeted, dict):
        collect_media_block(retweeted.get("media"), "retweeted", out, seen)

    return out


def extension_for(url: str, kind: str) -> str:
    suffix = Path(urllib.parse.urlparse(url).path).suffix.lower()
    known = {
        ".jpg", ".jpeg", ".png", ".webp", ".gif",
        ".mp4", ".mov", ".m4v", ".webm",
    }
    if suffix in known:
        return suffix
    if kind == "image":
        return ".jpg"
    if kind in {"video", "gif"}:
        return ".mp4"
    guessed = mimetypes.guess_extension(mimetypes.guess_type(url)[0] or "")
    return guessed or ".bin"


def download(url: str, dest: Path, timeout: float, retries: int, overwrite: bool) -> tuple[bool, str | None]:
    if dest.exists() and dest.stat().st_size > 0 and not overwrite:
        return True, None

    part = dest.with_name(dest.name + ".part")
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "*/*",
        "Referer": "https://x.com/",
    }

    last_error = None
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as r, part.open("wb") as f:
                while True:
                    chunk = r.read(1024 * 1024)
                    if not chunk:
                        break
                    f.write(chunk)

            if not part.exists() or part.stat().st_size == 0:
                raise OSError("empty response")

            part.replace(dest)
            return True, None
        except (urllib.error.HTTPError, urllib.error.URLError, TimeoutError, OSError) as e:
            last_error = f"{type(e).__name__}: {e}"
            part.unlink(missing_ok=True)
            if attempt < retries:
                wait = min(30.0, 2 ** (attempt - 1))
                print(f"    retry in {wait:.0f}s: {last_error}", file=sys.stderr)
                time.sleep(wait)

    return False, last_error


def rel_link(path: Path, archive_dir: Path) -> str:
    return os.path.relpath(path, archive_dir).replace(os.sep, "/")


def quote_text(lines: list[str], text: str) -> None:
    if not text:
        return
    for line in text.splitlines() or [""]:
        lines.append("> " + line)


def render_embedded(lines: list[str], title: str, item: dict) -> None:
    lines.append(f"### {title}")
    lines.append("")
    user = item.get("username") or "?"
    tid = item.get("id") or "?"
    lines.append(f"@{user} — `{tid}`")
    if item.get("url"):
        lines.append("")
        lines.append(f"<{item['url']}>")
    if item.get("text"):
        lines.append("")
        quote_text(lines, str(item["text"]))
    lines.append("")


def build_markdown(
    posts: list[dict],
    media_map: dict[str, list[dict]],
    archive_dir: Path,
    output: Path,
) -> None:
    downloaded = sum(
        1 for items in media_map.values() for item in items if item.get("path")
    )
    failed = sum(
        1 for items in media_map.values() for item in items if not item.get("path")
    )

    lines = [
        "# X Archive Extract",
        "",
        f"- Posts/replies: **{len(posts):,}**",
        f"- Downloaded media references: **{downloaded:,}**",
        f"- Failed media references: **{failed:,}**",
        "",
        "---",
        "",
    ]

    for post in posts:
        pid = str(post.get("id") or "")
        dt = parse_dt(post.get("date"))
        shown_dt = dt.isoformat(sep=" ", timespec="seconds") if dt else str(post.get("date") or "Unknown date")
        user = post.get("username") or "?"
        post_type = "Reply" if post.get("is_reply") else "Post"

        lines.append(f"## {shown_dt} — @{user} — {post_type} — `{pid}`")
        lines.append("")

        if post.get("url"):
            lines.append(f"**Post URL:** <{post['url']}>")
            lines.append("")

        if post.get("is_reply"):
            target = []
            if post.get("in_reply_to_username"):
                target.append("@" + str(post["in_reply_to_username"]))
            if post.get("in_reply_to_tweet_id"):
                target.append("post `" + str(post["in_reply_to_tweet_id"]) + "`")
            lines.append("**Reply to:** " + (" / ".join(target) if target else "unknown"))
            if post.get("conversation_id"):
                lines.append(f"**Conversation ID:** `{post['conversation_id']}`")
            lines.append("")

        text = str(post.get("text") or "")
        if text:
            lines.append("### Content")
            lines.append("")
            quote_text(lines, text)
            lines.append("")

        quoted = post.get("quoted_tweet")
        if isinstance(quoted, dict):
            render_embedded(lines, "Quoted post", quoted)

        retweeted = post.get("retweeted_tweet")
        if isinstance(retweeted, dict):
            render_embedded(lines, "Retweeted post", retweeted)

        items = media_map.get(pid, [])
        if items:
            lines.append("### Media")
            lines.append("")
            for item in items:
                local = item.get("path")
                label = f"{item['kind']} ({item['origin']})"
                if local:
                    local_path = Path(local)
                    rel = rel_link(local_path, archive_dir)
                    if item["kind"] == "image":
                        lines.append(f"![{label}]({rel})")
                    else:
                        lines.append(f"[{label}: {local_path.name}]({rel})")
                    lines.append("")
                    lines.append(f"Source: <{item['url']}>")
                else:
                    lines.append(f"- **Download failed** — {label}: <{item['url']}>")
                    if item.get("error"):
                        lines.append(f"  - `{item['error']}`")
                lines.append("")

        if post.get("sources"):
            sources = ", ".join(f"`{x}`" for x in post["sources"])
            lines.append(f"**Archive sources:** {sources}")
            lines.append("")

        lines.extend(["---", ""])

    output.write_text("\n".join(lines), encoding="utf-8")


def render_existing(archive_dir: Path, jsonl: Path) -> None:
    """Build the existing Markdown view using media downloaded by the Node worker."""
    manifest_path = archive_dir / "media_manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {"media": {}}
    entries = manifest.get("media")
    if not isinstance(entries, dict):
        raise ValueError("X_MEDIA_MANIFEST_INVALID")
    posts = load_jsonl(jsonl)
    media_map = {}
    root = archive_dir.resolve()
    for post in posts:
        items = []
        for item in collect_post_media(post):
            saved = entries.get(item["url"], {})
            local = saved.get("path")
            if local:
                filename = Path(local)
                filename = filename if filename.is_absolute() else root / filename
                filename = filename.resolve()
                if not filename.is_relative_to(root) or not filename.is_file():
                    local = None
                else:
                    local = str(filename)
            items.append({**item, "path": local, "error": saved.get("error") or (None if local else "X_MEDIA_NOT_DOWNLOADED")})
        media_map[str(post.get("id", ""))] = items
    output = root / "extract.md"
    if output.is_symlink():
        raise ValueError("X_UNSAFE_PATH")
    build_markdown(posts, media_map, root, output)


def main() -> None:
    args = parse_args()
    archive_dir = Path(args.archive_dir).expanduser().resolve()
    if not archive_dir.is_dir():
        raise SystemExit(f"Archive directory not found: {archive_dir}")

    jsonl = Path(args.jsonl).expanduser().resolve() if args.jsonl else detect_jsonl(archive_dir)
    if not jsonl.is_file():
        raise SystemExit(f"JSONL not found: {jsonl}")

    if args.render_only:
        render_existing(archive_dir, jsonl)
        return

    media_dir = archive_dir / "media"
    media_dir.mkdir(parents=True, exist_ok=True)
    md_path = archive_dir / "extract.md"
    manifest_path = archive_dir / "media_manifest.json"

    posts = load_jsonl(jsonl)
    print(f"Input : {jsonl}")
    print(f"Posts : {len(posts):,}")
    print(f"Media : {media_dir}")
    print(f"MD    : {md_path}")
    print()

    # Same media URL may be referenced more than once. Reuse one downloaded file.
    url_cache: dict[str, str] = {}
    media_map: dict[str, list[dict]] = {}
    manifest: dict[str, Any] = {"input": str(jsonl), "media": {}}

    total = sum(len(collect_post_media(p)) for p in posts)
    seq = 0
    ok_count = 0
    reused_count = 0
    failed_count = 0

    for p_index, post in enumerate(posts, 1):
        pid = str(post.get("id") or f"unknown_{p_index}")
        media_map[pid] = []
        prefix = filename_prefix(post)
        items = collect_post_media(post)

        for m_index, item in enumerate(items, 1):
            seq += 1
            url = item["url"]

            if url in url_cache:
                path = url_cache[url]
                media_map[pid].append({**item, "path": path, "reused": True})
                reused_count += 1
                print(f"[{seq}/{total}] reuse {Path(path).name}")
                continue

            origin_code = {"post": "p", "quoted": "q", "retweeted": "r"}.get(item["origin"], "m")
            ext = extension_for(url, item["kind"])
            filename = f"{prefix}_{origin_code}{m_index:02d}{ext}"
            dest = media_dir / filename

            print(f"[{seq}/{total}] {item['kind']:<5} {filename}")
            ok, error = download(
                url,
                dest,
                timeout=args.timeout,
                retries=args.retries,
                overwrite=args.overwrite,
            )

            entry = {**item, "path": str(dest) if ok else None, "error": error, "reused": False}
            media_map[pid].append(entry)

            manifest["media"][url] = {
                "post_id": pid,
                "post_date": post.get("date"),
                "origin": item["origin"],
                "kind": item["kind"],
                "path": str(dest) if ok else None,
                "error": error,
            }

            if ok:
                ok_count += 1
                url_cache[url] = str(dest)
            else:
                failed_count += 1

            # Persist after every item so an interrupted run still has a useful manifest.
            manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

            if args.delay > 0:
                time.sleep(args.delay)

    build_markdown(posts, media_map, archive_dir, md_path)

    manifest["generated_at"] = datetime.now().astimezone().isoformat()
    manifest["summary"] = {
        "posts": len(posts),
        "media_references": total,
        "downloaded": ok_count,
        "reused": reused_count,
        "failed": failed_count,
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    print()
    print("DONE")
    print(f"Downloaded : {ok_count:,}")
    print(f"Reused     : {reused_count:,}")
    print(f"Failed     : {failed_count:,}")
    print(f"Markdown   : {md_path}")
    print(f"Manifest   : {manifest_path}")


if __name__ == "__main__":
    main()
