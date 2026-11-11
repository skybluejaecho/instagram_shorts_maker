"""Verify the narration-only 100-to-120 HyperFrames smoke test (ffmpeg and ffprobe on PATH)."""

import argparse
import json
import math
import statistics
import subprocess
import sys
import wave
from array import array
from fractions import Fraction
from pathlib import Path


FPS = 30
WIDTH = 800
INITIAL = WIDTH * 100 / 120


def run(tool, *args):
    result = subprocess.run([tool, "-v", "error", *args], capture_output=True)
    if result.returncode != 0:
        raise ValueError(result.stderr.decode(errors="replace").strip())
    return result.stdout


def require(condition, message):
    if not condition:
        raise ValueError(message)


def inspect_video(video, wav_duration):
    fields = "format=duration:stream=codec_type,width,height,avg_frame_rate:frame=media_type,best_effort_timestamp_time"
    info = json.loads(run("ffprobe", "-show_entries", fields, "-of", "json", video))
    streams = info["streams"]
    picture = next((s for s in streams if s["codec_type"] == "video"), None)
    require(picture is not None and (picture["width"], picture["height"]) == (1080, 1920),
            "Expected a 1080x1920 video stream.")
    require(Fraction(picture["avg_frame_rate"]) == FPS, "Expected 30 fps.")
    require(any(s["codec_type"] == "audio" for s in streams), "No audio stream.")
    times = [float(f["best_effort_timestamp_time"]) for f in info["frames"] if f["media_type"] == "video"]
    require(times and all(abs(t - i / FPS) <= 0.001 for i, t in enumerate(times)),
            "Video frames must start at zero and advance at 30 fps.")
    duration = float(info["format"]["duration"])
    require(duration >= wav_duration - 1 / FPS and abs(duration - len(times) / FPS) <= 1 / FPS,
            "Video runtime disagrees with frame count or cuts off the narration.")
    return times, duration


def check_bar(video, times, start, end):
    # One decoded RGB scanline across the rendered track. Dark tick lines are ignored.
    scan = run("ffmpeg", "-i", video, "-map", "0:v:0", "-vf",
               "format=rgb24,crop=w=800:h=1:x=120:y=1170", "-f", "rawvideo", "pipe:1")
    require(len(scan) == len(times) * WIDTH * 3, "Unexpected decoded scanline count.")
    widths = []

    def expected(at):
        progress = min(1, max(0, (at - start) / (end - start)))
        return INITIAL + (WIDTH - INITIAL) * progress

    for i, t in enumerate(times):
        row = scan[i * WIDTH * 3 : (i + 1) * WIDTH * 3]
        width = max((j // 3 + 1 for j in range(0, len(row), 3)
                     if row[j + 1] > 87 and row[j + 1] - row[j] > 50), default=0)
        widths.append(width)
        # A bookmark can fall between frames; the three-pixel tick at 100 can hide the moving edge.
        require(expected(t - 1 / FPS) - 4 <= width <= expected(t + 1 / FPS) + 4,
                f"Bar at frame {i}: measured width {width}, expected about {expected(t):.1f}.")
    require(abs(widths[0] - INITIAL) <= 4 and abs(widths[-1] - WIDTH) <= 2, "Wrong bar endpoints.")
    # Fit the moving edge, ignoring endpoint holds, to estimate the start and arrival independently.
    moving = [(t, w) for t, w in zip(times, widths) if INITIAL + 6 < w < WIDTH - 3]
    require(len(moving) >= 2, "Not enough moving frames to measure the two anchors.")
    mt, mw = map(statistics.mean, zip(*moving))
    slope = sum((t - mt) * (w - mw) for t, w in moving) / sum((t - mt) ** 2 for t, _ in moving)
    require(slope > 0, "Bar must grow towards 120.")
    measured = [mt + (edge - mw) / slope for edge in (INITIAL, WIDTH)]
    require(max(abs(measured[0] - start), abs(measured[1] - end)) <= 1 / FPS,
            f"Rendered anchors {measured} differ from animation targets {[start, end]} by more than one frame.")
    return [round(v, 4) for v in measured]


def audio_envelope(media):
    pcm = array("h")
    pcm.frombytes(run("ffmpeg", "-copyts", "-i", media, "-map", "0:a:0", "-ac", "1",
                      "-af", "aresample=8000:first_pts=0", "-f", "s16le", "pipe:1"))
    if sys.byteorder != "little":
        pcm.byteswap()
    # Five-millisecond RMS blocks make the comparison insensitive to AAC sample differences.
    return [math.sqrt(sum(n * n for n in pcm[i:i+40]) / 40) for i in range(0, len(pcm) - 39, 40)]


def check_audio(video, narration):
    source, actual = audio_envelope(narration), audio_envelope(video)
    require(source and actual and min(max(source), max(actual)) > 32, "Missing audible narration.")
    require(len(actual) >= len(source) - 6, "Encoded audio is shorter than the narration.")
    # Compare the same interior of the utterance at offsets of up to 150 ms.
    n = min(len(source), len(actual))
    require(n > 100, "Narration too short for this smoke test.")
    reference = source[30:n-30]
    scores = [(statistics.correlation(reference, actual[30+k:n-30+k]), k) for k in range(-30, 31)]
    score, lag = max(scores)
    require(score >= 0.90 and abs(lag * 0.005) <= 1 / FPS,
            f"Narration energy mismatch: correlation={score:.3f}, lag={lag * 5} ms.")
    return {"correlation": round(score, 3), "estimatedLagMs": lag * 5}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("mp4", "timing", "wav"):
        parser.add_argument(name, type=Path)
    args = parser.parse_args()
    timing = json.loads(args.timing.read_text(encoding="utf-8-sig"))
    start, end, wav_duration = (float(timing[k]) for k in ("startSeconds", "endSeconds", "durationSeconds"))
    with wave.open(str(args.wav), "rb") as wav:
        measured_duration = wav.getnframes() / wav.getframerate()
        require(abs(wav_duration - measured_duration) < 0.001, "WAV duration differs from the timing file.")
    require(0 <= start < end <= wav_duration, "Bookmarks must be ordered and inside the narration.")
    times, duration = inspect_video(args.mp4, wav_duration)
    measured = check_bar(args.mp4, times, start, end)
    audio = check_audio(args.mp4, args.wav)
    marks = timing.get("marks", {"rise-start": start, "rise-end": end})
    print(json.dumps({"frames": len(times), "durationSeconds": duration,
                      "bookmarksSeconds": [marks["rise-start"], marks["rise-end"]],
                      "animationTargetsSeconds": [start, end],
                      "measuredBarSeconds": measured, "audio": audio}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, KeyError, wave.Error, EOFError) as error:
        sys.exit(f"Verification failed: {error}")
