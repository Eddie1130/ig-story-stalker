"""Produce bounded upload copies without changing the archived original."""

import subprocess


def delivery_parts(file, limit=1_900_000_000):
    if file.suffix != ".mp4" or file.stat().st_size <= limit:
        return [file]
    duration = float(
        subprocess.check_output(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "csv=p=0",
                str(file),
            ],
            stderr=subprocess.DEVNULL,
            timeout=60,
        )
    )
    seconds = max(1, int(duration * limit / file.stat().st_size * 0.8))
    folder = file.parent / (file.stem + "_parts")
    folder.mkdir(exist_ok=True)
    while True:
        for part in folder.glob("*.mp4"):
            part.unlink()
        subprocess.run(
            [
                "ffmpeg",
                "-nostdin",
                "-y",
                "-i",
                str(file),
                "-map",
                "0:v?",
                "-map",
                "0:a?",
                "-c",
                "copy",
                "-f",
                "segment",
                "-segment_time",
                str(seconds),
                "-reset_timestamps",
                "1",
                str(folder / "%04d.mp4"),
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=1800,
        )
        parts = sorted(folder.glob("*.mp4"))
        if parts and all(12 <= p.stat().st_size <= limit for p in parts):
            return parts
        if seconds <= 1:
            raise RuntimeError("TIKTOK_SPLIT_FAILED")
        seconds = max(1, seconds // 2)
