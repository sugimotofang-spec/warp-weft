"""Render 經緯 Warp & Weft (film.html) to a 30 s 1080p MP4 with a synthesized soundtrack.

    python render_film.py                 # full render → 經緯_WarpWeft_30s.mp4
    python render_film.py --stills 1,5,9  # single frames for checking composition

Frames are drawn deterministically by window.renderAt(t) in headless Chrome
(real GPU via ANGLE/D3D11), captured one by one, then muxed with ffmpeg.
"""
import argparse, json, shutil, subprocess, sys, tempfile, time
from pathlib import Path
from playwright.sync_api import sync_playwright

HERE = Path(__file__).resolve().parent
FPS, DUR, W, H = 30, 30, 1920, 1080
CHROME_ARGS = ["--enable-gpu", "--use-angle=d3d11", "--ignore-gpu-blocklist", "--allow-file-access-from-files"]


def open_film(p):
    browser = p.chromium.launch(channel="chrome", headless=True, args=CHROME_ARGS)
    page = browser.new_page(viewport={"width": W, "height": H}, device_scale_factor=1)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
    page.goto((HERE / "film.html").as_uri() + "?capture=1")
    page.wait_for_function("window.FILM_READY === true", timeout=60000)
    page.wait_for_timeout(500)
    return browser, page, errors


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stills", help="comma-separated times in seconds")
    ap.add_argument("--out", default=str(HERE / "經緯_WarpWeft_30s.mp4"))
    ap.add_argument("--frames", default=None, help="directory for intermediate PNG frames")
    ap.add_argument("--still-dir", default=None)
    a = ap.parse_args()

    with sync_playwright() as p:
        browser, page, errors = open_film(p)
        cues = page.evaluate("window.CUES")
        (HERE / "cues.json").write_text(json.dumps(cues, ensure_ascii=False, indent=1), encoding="utf-8")

        if a.stills:
            sd = Path(a.still_dir or tempfile.gettempdir())
            sd.mkdir(parents=True, exist_ok=True)
            for s in a.stills.split(","):
                t = float(s)
                page.evaluate(f"window.renderAt({t})")
                out = sd / f"still_{t:05.2f}.png"
                page.screenshot(path=str(out))
                print("still", t, "->", out)
            print("errors:", errors[:5])
            browser.close()
            return

        frames = Path(a.frames or tempfile.mkdtemp(prefix="warpweft_"))
        frames.mkdir(parents=True, exist_ok=True)
        n = FPS * DUR
        t0 = time.time()
        for i in range(n):
            page.evaluate(f"window.renderAt({i / FPS})")
            page.screenshot(path=str(frames / f"f{i:04d}.png"))
            if i % 60 == 0:
                el = time.time() - t0
                print(f"frame {i}/{n}  {el:.0f}s elapsed  ~{el / max(i, 1) * (n - i):.0f}s left", flush=True)
        print("errors:", errors[:5])
        browser.close()

    # soundtrack from the same cue sheet
    subprocess.run([sys.executable, str(HERE / "soundtrack.py"), str(HERE / "cues.json"), str(frames / "soundtrack.wav")], check=True)

    ffmpeg = shutil.which("ffmpeg") or "ffmpeg"
    cmd = [ffmpeg, "-y", "-framerate", str(FPS), "-i", str(frames / "f%04d.png"), "-i", str(frames / "soundtrack.wav"),
           "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-pix_fmt", "yuv420p", "-profile:v", "high",
           "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", "-shortest", a.out]
    subprocess.run(cmd, check=True)
    print("wrote", a.out)


if __name__ == "__main__":
    main()
