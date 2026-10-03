"""Synthesize the 30 s soundtrack for 經緯 Warp & Weft from the film's cue sheet.

    python soundtrack.py cues.json soundtrack.wav

Every sound is generated here (numpy only): Karplus-Strong plucks for yarn,
loom clacks panned with the shuttle, bells on each weave change, a die-cut
impact, and a slow pad underneath. Timings come from film.html's window.CUES.
"""
import json, sys, wave
import numpy as np

SR = 48000
rng = np.random.default_rng(7)
cues = json.load(open(sys.argv[1], encoding="utf-8"))
DUR = cues["duration"]
N = int(SR * DUR)
dry = np.zeros((2, N))
send = np.zeros((2, N))


def hz(note):
    names = {"C": -9, "C#": -8, "D": -7, "D#": -6, "E": -5, "F": -4, "F#": -3, "G": -2, "G#": -1, "A": 0, "A#": 1, "B": 2}
    n, o = note[:-1], int(note[-1])
    return 440.0 * 2 ** ((names[n] + (o - 4) * 12) / 12)


def place(sig, t0, gain=1.0, pan=0.0, rev=0.25):
    i0 = int(round(t0 * SR))
    if i0 >= N:
        return
    s = sig
    if i0 < 0:
        s, i0 = s[-i0:], 0
    n = min(len(s), N - i0)
    l, r = np.cos((pan + 1) * np.pi / 4), np.sin((pan + 1) * np.pi / 4)
    for ch, g in ((0, l), (1, r)):
        dry[ch, i0:i0 + n] += s[:n] * gain * g
        send[ch, i0:i0 + n] += s[:n] * gain * g * rev


def tt(dur):
    return np.arange(int(dur * SR)) / SR


def smooth(x, k):
    if k <= 1:
        return x
    ker = np.ones(k) / k
    return np.convolve(x, ker, mode="same")


def pluck(freq, dur, damp=0.996, bright=3):
    P = max(2, int(round(SR / freq)))
    n = int(dur * SR)
    y = np.zeros(n + P + 1)
    burst = rng.uniform(-1, 1, P + 1)
    y[: P + 1] = smooth(burst, bright)
    for start in range(P + 1, n + P + 1, P):
        end = min(start + P, n + P + 1)
        y[start:end] = damp * 0.5 * (y[start - P:end - P] + y[start - P - 1:end - P - 1])
    y = y[: n]
    fade = np.ones(n)
    k = int(0.05 * SR)
    fade[-k:] = np.linspace(1, 0, k)
    return y * fade / (np.max(np.abs(y)) + 1e-9)


def bell(freq, dur=2.2, bright=1.0):
    t = tt(dur)
    parts = [(1, 1, 1.0), (2.0, 0.42, 0.7), (2.76, 0.32 * bright, 0.5), (5.4, 0.16 * bright, 0.3), (8.93, 0.07 * bright, 0.18)]
    s = sum(a * np.sin(2 * np.pi * freq * r * t) * np.exp(-t / (dur * d)) for r, a, d in parts)
    att = np.minimum(1, t / 0.004)
    return s * att / 2.0


def click(freq=1400, dur=0.03, noise=0.6):
    t = tt(dur)
    n = rng.uniform(-1, 1, len(t))
    n = n - np.concatenate([[0], n[:-1]]) * 0.6
    s = (np.sin(2 * np.pi * freq * t) * (1 - noise) + n * noise) * np.exp(-t / (dur / 5))
    return s


def thud(f0=140, f1=70, dur=0.16):
    t = tt(dur)
    f = f1 + (f0 - f1) * np.exp(-t / 0.03)
    ph = 2 * np.pi * np.cumsum(f) / SR
    return np.sin(ph) * np.exp(-t / (dur / 4))


def noise_sweep(dur, f_lo, f_hi, curve=2.0):
    """band-ish noise whose brightness rises; returns signal with rising envelope"""
    n = int(dur * SR)
    x = rng.uniform(-1, 1, n)
    out = np.zeros(n)
    blocks = 40
    for b in range(blocks):
        i0, i1 = b * n // blocks, (b + 1) * n // blocks
        k = b / (blocks - 1)
        f = f_lo + (f_hi - f_lo) * k ** curve
        win = max(1, int(SR / f / 2))
        seg = x[max(0, i0 - win):i1]
        hp = seg - smooth(seg, win * 4)
        lp = smooth(hp, win)
        out[i0:i1] = lp[-(i1 - i0):]
    env = (np.arange(n) / n) ** 1.6
    return out * env / (np.max(np.abs(out)) + 1e-9)


# ------------------------------------------------------------------ pad (chords)
def pad_note(freq, dur, bright=4.0, detune=0.003):
    t = tt(dur)
    s = np.zeros_like(t)
    for d in (-detune, detune):
        for h in range(1, 9):
            s += np.sin(2 * np.pi * freq * (1 + d) * h * t + h * 1.3) / h * np.exp(-h / bright)
    return s


CHORDS = [
    (0.0, 6.5, ["D2", "A2", "D3"], 2.5),
    (6.3, 11.2, ["D2", "A2", "D3", "F#3", "A3"], 3.2),
    (11.0, 16.2, ["B1", "F#2", "B2", "D3", "A3"], 3.6),
    (16.0, 19.7, ["G1", "D2", "G2", "B2", "F#3"], 3.8),
    (19.5, 21.1, ["A1", "E2", "A2", "D3", "E3"], 4.5),
    (21.0, 25.2, ["D2", "A2", "D3", "F#3", "A3"], 3.4),
    (25.0, 30.0, ["D2", "A2", "E3", "F#3", "A3", "D4"], 3.0),
]
for a, b, notes, br in CHORDS:
    dur = b - a
    s = sum(pad_note(hz(n), dur, br) / (1 + 0.15 * i) for i, n in enumerate(notes))
    t = tt(dur)
    att = 1.6 if a == 0 else 0.45
    env = np.minimum(1, t / att) * np.minimum(1, (dur - t) / 0.45)
    s = s * env
    s /= np.max(np.abs(s)) + 1e-9
    g = 0.11 if a < 6 else 0.13
    if a >= 25:
        g = 0.16
    place(s, a, g, pan=-0.15, rev=0.5)
    place(s * 0.9, a + 0.011, g, pan=0.15, rev=0.5)

# ------------------------------------------------------------------ 0–2.5 s: one yarn
place(pluck(hz("D3"), 3.2, damp=0.998, bright=2), 0.18, 0.42, pan=0.0, rev=0.45)
place(pluck(hz("A3"), 2.6, damp=0.997, bright=3), 0.95, 0.16, pan=0.1, rev=0.5)
air = noise_sweep(2.4, 2000, 7000, 1.0)
place(air * np.linspace(0.2, 1, len(air)) * np.linspace(1, 0.2, len(air)), 0.0, 0.035, pan=0, rev=0.6)

# ------------------------------------------------------------------ 2.5–6.5 s: warps spread out (strings fanning)
scale = ["D4", "E4", "F#4", "A4", "B4", "D5", "E5", "F#5", "A5", "B5", "D6", "E6", "F#6"]
n_pl = 26
for i in range(n_pl):
    x = i / (n_pl - 1)
    t0 = 2.62 + 3.55 * (1 - (1 - x) ** 1.8) * 0.98
    note = scale[min(len(scale) - 1, int(x * (len(scale) - 1) + (i % 2) * 0.6))]
    pan = (1 if i % 2 else -1) * (0.1 + 0.8 * x)
    place(pluck(hz(note), 1.8, damp=0.995, bright=2 + i % 3), t0, 0.2 * (1 - 0.45 * x), pan=pan, rev=0.45)

# ------------------------------------------------------------------ 6.5–11 s: the loom
last = -1.0
picks = cues["picks"]
for k, (t0, d) in enumerate(picks):
    gap = t0 - last
    if gap < 0.045:
        continue
    rate = 1 / max(gap, 1e-3)
    g = 0.46 / (1 + rate / 14)
    place(click(1100 + (k % 3) * 90, 0.035, 0.55), t0, g, pan=0.65 * d, rev=0.18)
    place(thud(180, 110, 0.07), t0, g * 0.55, pan=0.3 * d, rev=0.1)
    last = t0
rattle = noise_sweep(1.55, 400, 5000, 1.4)
place(rattle, 9.45, 0.2, pan=0.0, rev=0.3)

# ------------------------------------------------------------------ 11–16 s: weave changes
pulse_t = np.arange(11.0, 16.0, 0.5)
for i, t0 in enumerate(pulse_t):
    place(thud(95, 48, 0.32), t0, 0.32 if i % 2 == 0 else 0.2, pan=0, rev=0.08)
    place(click(5200, 0.02, 0.9), t0 + 0.25, 0.05, pan=0.3 * (1 if i % 2 else -1), rev=0.2)
bells = {11.0: "B4", 12.0: "D5", 13.0: "F#5", 14.0: "A5"}
for t0, n in bells.items():
    place(bell(hz(n), 2.4), t0, 0.26, pan=-0.2 + 0.13 * (t0 - 11), rev=0.55)
place(noise_sweep(0.85, 300, 6000, 1.6), 15.15, 0.16, pan=0, rev=0.35)

# ------------------------------------------------------------------ 16–19.5 s: jacquard
place(bell(hz("D6"), 3.4, 0.8), 16.0, 0.22, pan=-0.1, rev=0.6)
place(bell(hz("A5"), 3.4, 0.8), 16.02, 0.18, pan=0.12, rev=0.6)
place(thud(80, 40, 0.6), 16.0, 0.4, pan=0, rev=0.1)
for t0 in cues["spec"]:
    place(click(2600, 0.012, 0.8), t0, 0.06, pan=rng.uniform(-0.2, 0.2), rev=0.1)
place(noise_sweep(1.1, 200, 4000, 1.5), 18.45, 0.15, pan=0, rev=0.4)

# ------------------------------------------------------------------ 19.5–25 s: die-cut and assembly
place(bell(hz("E5"), 1.8, 0.6), 19.5, 0.16, pan=0, rev=0.5)
d0, imp = cues["dieStart"], cues["impact"]
dd = imp - d0
t = tt(dd)
f = 160 + 900 * (t / dd) ** 2.4
rise = np.sin(2 * np.pi * np.cumsum(f) / SR) * (t / dd) ** 2.2
place(rise, d0, 0.12, pan=0, rev=0.3)
place(noise_sweep(dd, 300, 9000, 2.6), d0, 0.22, pan=0, rev=0.25)
boom = thud(110, 34, 1.1)
place(boom, imp, 0.6, pan=0, rev=0.15)
crack = click(900, 0.06, 0.95)
place(crack, imp, 0.38, pan=0, rev=0.35)
tm = tt(1.4)
ring = sum(a * np.sin(2 * np.pi * 410 * r * tm) * np.exp(-tm / dcy) for r, a, dcy in [(1, 1, 0.5), (2.41, 0.6, 0.35), (3.77, 0.4, 0.25), (5.3, 0.25, 0.18)])
place(ring / 2.2, imp, 0.22, pan=0.05, rev=0.6)
for i, t0 in enumerate(cues["lands"]):
    pan = [0, 0, -0.6, 0.6, -0.45, -0.55, 0.0, 0.1, 0.4][i % 9]
    place(thud(150, 85, 0.12), t0, 0.32, pan=pan, rev=0.15)
    place(click(3200, 0.015, 0.7), t0, 0.08, pan=pan, rev=0.2)
la, lb = cues["laces"]
for i, t0 in enumerate(np.linspace(la, lb, 34)):
    place(click(1800 + i * 40, 0.01, 0.85), t0, 0.07, pan=-0.3 + 0.6 * i / 33, rev=0.15)

# ------------------------------------------------------------------ 25–30 s: shoe, steps, quote
sw = noise_sweep(1.6, 3000, 11000, 1.0)
sw = sw * np.hanning(len(sw))
place(sw, cues["sweep"], 0.06, pan=-0.5, rev=0.5)
place(sw, cues["sweep"] + 0.4, 0.06, pan=0.5, rev=0.5)
for i, t0 in enumerate(cues["count"]):
    place(click(3800 + i * 25, 0.008, 0.6), t0, 0.07, pan=0.0, rev=0.1)
q = cues["quote"]
for i, n in enumerate(["D5", "F#5", "A5", "E6"]):
    place(bell(hz(n), 4.0, 0.5), q + i * 0.07, 0.15, pan=-0.3 + 0.2 * i, rev=0.7)
place(pluck(hz("D3"), 3.0, damp=0.998, bright=2), q, 0.3, pan=0, rev=0.5)

# ------------------------------------------------------------------ reverb + master
ir_len = int(2.4 * SR)
ti = np.arange(ir_len) / SR
mix = np.zeros((2, N))
for ch in range(2):
    ir = rng.standard_normal(ir_len) * np.exp(-ti / 0.55)
    ir = smooth(ir, 3 + ch)
    ir[: int(0.012 * SR)] *= np.linspace(0, 1, int(0.012 * SR))
    ir /= np.sqrt(np.sum(ir ** 2))
    L = 1 << int(np.ceil(np.log2(N + ir_len)))
    wet = np.fft.irfft(np.fft.rfft(send[ch], L) * np.fft.rfft(ir, L), L)[:N]
    mix[ch] = dry[ch] + wet * 0.55

tg = np.arange(N) / SR
master = np.minimum(1, tg / 0.08) * np.clip((DUR - tg) / 0.75, 0, 1) ** 1.5
mix *= master
# loudness first (≈ -17 dB RMS over the body of the film), then a soft limiter
body = mix[:, int(0.5 * SR):int((DUR - 1) * SR)]
mix *= 10 ** (-17 / 20) / (np.sqrt(np.mean(body ** 2)) + 1e-9)
mix = np.tanh(mix * 1.15) / 1.15
peak = np.max(np.abs(mix))
if peak > 0.89:
    mix *= 0.89 / peak

pcm = (mix.T * 32767).astype(np.int16)
with wave.open(sys.argv[2], "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm.tobytes())
print("wrote", sys.argv[2], f"{N / SR:.2f}s peak-normalised")
