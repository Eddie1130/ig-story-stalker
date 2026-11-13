#!/usr/bin/env python3
"""Metadata-only historical worker used by the native X monitor.

The Node worker owns the durable queue and all media downloads. This process owns
only twscrape calls and the per-account SQLite checkpoints / JSONL exports.
"""
from __future__ import annotations

import argparse
import asyncio
import contextlib
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sqlite3
import sys


def pool_status(db_path: Path | str, *, now: datetime | None = None) -> dict:
    """Read counts without opening sessions, returning identities, or creating DBs."""
    path = Path(db_path).expanduser().absolute()
    counts = {"total": 0, "active": 0, "inactive": 0, "locked": 0, "available": 0}
    if not path.exists():
        return {"status": "missing", **counts}
    if path.is_symlink() or not path.is_file():
        raise ValueError("X_ACCOUNTS_DB_INVALID")
    try:
        connection = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=5)
        try:
            rows = connection.execute("SELECT active, locks FROM accounts").fetchall()
        finally:
            connection.close()
        now = now or datetime.now(timezone.utc)
        ready_times = []
        for active, locks_json in rows:
            counts["total"] += 1
            if not active:
                counts["inactive"] += 1
                continue
            counts["active"] += 1
            locks = json.loads(locks_json) if locks_json else {}
            if not isinstance(locks, dict):
                raise ValueError("X_ACCOUNTS_DB_INVALID")
            locked = False
            ready_at = now
            for value in locks.values():
                until = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
                if until.tzinfo is None:
                    until = until.replace(tzinfo=timezone.utc)
                locked = locked or until > now
                ready_at = max(ready_at, until)
            counts["locked"] += int(locked)
            ready_times.append(ready_at)
        counts["available"] = counts["active"] - counts["locked"]
        next_available = int(min(ready_times).timestamp() * 1000) if ready_times and not counts["available"] else None
        return {"status": "ready" if counts["active"] else "unavailable", **counts, "nextAvailableAt": next_available}
    except (sqlite3.Error, TypeError, ValueError) as error:
        raise ValueError("X_ACCOUNTS_DB_INVALID") from error


def parser() -> argparse.ArgumentParser:
    cli = argparse.ArgumentParser(description=__doc__)
    commands = cli.add_subparsers(dest="command", required=True)
    status = commands.add_parser("status", help="Print credential-free account pool counts")
    status.add_argument("--accounts-db", required=True)
    history = commands.add_parser("history", help="Resume date-windowed historical metadata scraping")
    history.add_argument("--username", required=True)
    history.add_argument("--accounts-db", required=True)
    history.add_argument("--out", required=True)
    history.add_argument("--progress", required=True)
    history.add_argument("--start")
    history.add_argument("--end", required=True, help="Exclusive UTC end date, fixed by the queue")
    return cli


def run_history(args) -> int:
    # Library logging can contain account names and upstream response bodies.
    # The parent receives only the allowlisted progress JSON and this summary.
    os.environ["TWS_LOG_LEVEL"] = "CRITICAL"
    os.environ["TWS_TELEMETRY"] = "0"
    import x_archive

    cli_args = [args.username, "--accounts-db", args.accounts_db, "--out", args.out,
                "--progress", args.progress, "--end", args.end]
    if args.start:
        cli_args.extend(["--start", args.start])
    archive_args = x_archive.make_parser().parse_args(cli_args)
    try:
        pool = pool_status(args.accounts_db)
        if not pool["active"]:
            raise ValueError("X_NO_ACCOUNT_AVAILABLE")
        with open(os.devnull, "w") as quiet, contextlib.redirect_stdout(quiet), contextlib.redirect_stderr(quiet):
            summary = asyncio.run(x_archive.async_main(archive_args))
        result = {"status": summary["status"], "posts": summary["posts"],
                  "window_status_counts": summary["window_status_counts"]}
        print(json.dumps(result))
        return 2 if summary["status"] == "partial" else 0
    except KeyboardInterrupt:
        reason = "X_HISTORY_INTERRUPTED"
        x_archive.write_progress(args.progress, {"status": "interrupted", "stage": "stopped", "username": args.username, "reason": reason})
        print(json.dumps({"status": "interrupted", "reason": reason}))
        return 130
    except Exception as error:
        reason = x_archive.failure_reason(error)
        status = "needs_start" if reason == "X_START_DATE_REQUIRED" else "failed"
        previous = {}
        try:
            previous = json.loads(Path(args.progress).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pass
        x_archive.write_progress(args.progress, {**previous, "status": status, "stage": "stopped", "username": args.username, "end": args.end, "reason": reason})
        print(json.dumps({"status": status, "reason": reason}))
        return 1


def main() -> int:
    args = parser().parse_args()
    if args.command == "history":
        return run_history(args)
    try:
        print(json.dumps(pool_status(args.accounts_db)))
        return 0
    except ValueError:
        print(json.dumps({"status": "failed", "reason": "X_ACCOUNTS_DB_INVALID"}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
