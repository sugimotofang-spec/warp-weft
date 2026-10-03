/* 經緯 Warp & Weft · fabric-core.js
 * Shared engine for the interactive lab (index.html) and the film renderer (film.html).
 *   - weave library and jacquard (satin damask) generator
 *   - fabric physics from yarn denier and thread density
 *   - WebGL2 yarn-level renderer: crimp, twisted filaments, Kajiya-Kay sheen
 *   - running-shoe part geometry (viewBox units, toe pointing right)
 */
(function (global) {
  'use strict';

  const mod = (a, n) => ((a % n) + n) % n;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // ---------------------------------------------------------------- weaves
  // cells[y * w + x] = 1 → warp end x floats over pick y（經組織點）
  function make(w, h, fn) {
    const cells = new Uint8Array(w * h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) cells[y * w + x] = fn(x, y) ? 1 : 0;
    return { w, h, cells };
  }

  const WEAVES = {
    plain:       { zh: '平紋',     en: 'Plain',        build: () => make(2, 2, (x, y) => (x + y) % 2 === 0) },
    basket:      { zh: '方平',     en: 'Basket 2/2',   build: () => make(4, 4, (x, y) => ((x >> 1) + (y >> 1)) % 2 === 0) },
    twill21:     { zh: '2/1 斜紋', en: 'Twill 2/1',    build: () => make(3, 3, (x, y) => mod(x - y, 3) < 2) },
    twill22:     { zh: '2/2 斜紋', en: 'Twill 2/2',    build: () => make(4, 4, (x, y) => mod(x - y, 4) < 2) },
    twill31:     { zh: '3/1 斜紋', en: 'Twill 3/1',    build: () => make(4, 4, (x, y) => mod(x - y, 4) < 3) },
    satin5:      { zh: '五枚緞',   en: '5-end Satin',  build: () => make(5, 5, (x, y) => x !== mod(2 * y, 5)) },
    satin8:      { zh: '八枚緞',   en: '8-end Satin',  build: () => make(8, 8, (x, y) => x !== mod(3 * y, 8)) },
    herringbone: { zh: '人字紋',   en: 'Herringbone',  build: () => make(8, 4, (x, y) => (x < 4 ? mod(x - y, 4) < 2 : mod(x + y + 1, 4) < 2)) },
    houndstooth: { zh: '千鳥格',   en: 'Houndstooth',  build: () => make(4, 4, (x, y) => mod(x - y + 1, 4) < 2) },
    ripstop:     { zh: '格子防裂', en: 'Ripstop',      build: () => make(11, 11, (x, y) => { const a = x === 10 ? 9 : x, b = y === 10 ? 9 : y; return (a + b) % 2 === 0; }) },
  };

  function weave(id) { return WEAVES[id].build(); }

  function invert(p) {
    const cells = new Uint8Array(p.cells.length);
    for (let i = 0; i < cells.length; i++) cells[i] = p.cells[i] ? 0 : 1;
    return { w: p.w, h: p.h, cells };
  }

  function resize(p, w, h) {
    return make(w, h, (x, y) => p.cells[mod(y, p.h) * p.w + mod(x, p.w)] === 1);
  }

  // Satin damask: figure = warp-faced 5-end satin, ground = weft-faced 5-end satin.
  function jacquard(text, w, h, opts) {
    opts = opts || {};
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const family = opts.font || '"Noto Sans TC", "Microsoft JhengHei", "PingFang TC", sans-serif';
    const weight = opts.weight || 900;
    let size = h * (opts.fill || 0.62);
    ctx.font = weight + ' ' + size + 'px ' + family;
    const mw = ctx.measureText(text).width;
    const maxW = w * (opts.maxW || 0.88);
    if (mw > maxW) { size *= maxW / mw; ctx.font = weight + ' ' + size + 'px ' + family; }
    ctx.fillText(text, w / 2, h * (opts.cy || 0.52));
    const d = ctx.getImageData(0, 0, w, h).data;
    const cells = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const row = h - 1 - y; // picks count upward
      for (let x = 0; x < w; x++) {
        const fig = d[(row * w + x) * 4] > 110;
        const tie = mod(x, 5) === mod(2 * y, 5);
        cells[y * w + x] = fig ? (tie ? 0 : 1) : (tie ? 1 : 0);
      }
    }
    return { w, h, cells };
  }

  function measureJacquard(text, h, opts) {
    opts = opts || {};
    const cv = document.createElement('canvas').getContext('2d');
    const family = opts.font || '"Noto Sans TC", "Microsoft JhengHei", "PingFang TC", sans-serif';
    cv.font = (opts.weight || 900) + ' ' + h * (opts.fill || 0.62) + 'px ' + family;
    return cv.measureText(text).width;
  }

  // ---------------------------------------------------------------- analysis
  function cyclicRuns(arr) {
    const n = arr.length;
    let s = 0;
    while (s < n && arr[s] === arr[(s - 1 + n) % n]) s++;
    if (s === n) return [{ v: arr[0], len: n, unbound: true }];
    const out = [];
    let v = arr[s], len = 0;
    for (let k = 0; k < n; k++) {
      const a = arr[(s + k) % n];
      if (a === v) len++; else { out.push({ v, len }); v = a; len = 1; }
    }
    out.push({ v, len });
    return out;
  }

  function weaveStats(p) {
    const { w, h, cells } = p;
    const warpFloats = [], weftFloats = [], looseWarp = [], looseWeft = [];
    let transitions = 0, up = 0;
    for (let x = 0; x < w; x++) {
      const col = [];
      for (let y = 0; y < h; y++) { col.push(cells[y * w + x]); up += cells[y * w + x]; }
      const runs = cyclicRuns(col);
      if (runs[0].unbound) { looseWarp.push(x); continue; }
      transitions += runs.length;
      runs.forEach(r => { if (r.v === 1) warpFloats.push(r.len); });
    }
    for (let y = 0; y < h; y++) {
      const row = Array.from(cells.subarray(y * w, y * w + w));
      const runs = cyclicRuns(row);
      if (runs[0].unbound) { looseWeft.push(y); continue; }
      transitions += runs.length;
      runs.forEach(r => { if (r.v === 0) weftFloats.push(r.len); });
    }
    const avg = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
    return {
      w, h,
      interlace: transitions / (2 * w * h),          // 1 = plain weave
      interlacings: transitions / 2,
      warpFloat: avg(warpFloats), weftFloat: avg(weftFloats),
      maxFloat: Math.max(1, ...warpFloats, ...weftFloats),
      warpFace: up / (w * h),
      looseWarp, looseWeft,
    };
  }

  // Physical estimate: polyester filament, density 1.38 g/cm³, packing factor 0.75.
  function fabricSpec(o) {
    const interlace = o.interlace == null ? 1 : o.interlace;
    const crimp = 0.03 + 0.05 * interlace;
    const perM = 39.3701;
    const gWarp = o.epi * perM * (o.warpDen / 9000) * (1 + crimp);
    const gWeft = o.ppi * perM * (o.weftDen / 9000) * (1 + crimp * 0.8);
    const gsm = gWarp + gWeft;
    const dia = den => Math.sqrt((4 * den) / (9e5 * Math.PI * 1.38 * 0.75)) * 10; // mm
    const flat = 1.3 + 0.3 * (1 - interlace);
    const dW = dia(o.warpDen), dF = dia(o.weftDen);
    const cW = Math.min(1, dW * flat * (o.epi / 25.4));
    const cF = Math.min(1, dF * flat * (o.ppi / 25.4));
    return {
      gsm, oz: gsm / 33.906, crimp,
      dWarp: dW, dWeft: dF, cW, cF,
      cover: cW + cF - cW * cF,
      warpW: clamp(cW * 0.62, 0.16, 0.49),
      weftW: clamp(cF * 0.62, 0.16, 0.49),
    };
  }

  function colorOrder(kind, a, b) {
    if (kind === '44') return { warp: [a, a, a, a, b, b, b, b], weft: [a, a, a, a, b, b, b, b] };
    if (kind === 'ripstop') {
      const la = mixHex(a, '#ffffff', 0.32), lb = mixHex(b, '#ffffff', 0.32);
      return { warp: [a, a, a, a, a, a, a, a, a, la, la], weft: [b, b, b, b, b, b, b, b, b, lb, lb] };
    }
    return { warp: [a], weft: [b] };
  }

  function hexToRgb(h) {
    h = h.replace('#', '');
    if (h.length === 3) h = h.split('').map(c => c + c).join('');
    const n = parseInt(h, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgbToHex(r) { return '#' + r.map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join(''); }
  function mixHex(a, b, t) { const x = hexToRgb(a), y = hexToRgb(b); return rgbToHex(x.map((v, i) => v + (y[i] - v) * t)); }

  // Same camera as the shader: screen offset (px from centre, y up) → fabric coords.
  function project(sx, sy, cam, res) {
    const focal = res[1] * 1.25;
    const D = focal / cam.cellPx;
    const st = Math.sin(cam.tilt || 0), ct = Math.cos(cam.tilt || 0);
    const den = focal * ct - sy * st;
    if (den < 1e-3) return null;
    const t = (D * ct) / den;
    let qx = t * sx, qy = t * sy * ct - (D - t * focal) * st;
    const r = cam.roll || 0, cr = Math.cos(r), sr = Math.sin(r);
    const rx = cr * qx - sr * qy, ry = (sr * qx + cr * qy) / (cam.aspect || 1);
    return [cam.center[0] + rx, cam.center[1] + ry, (t * focal) / D];
  }

  // ---------------------------------------------------------------- WebGL2
  const VS = `#version 300 es
void main(){ vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2. - 1., 0., 1.); }`;

  const FS = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
uniform vec2 uRes;
uniform vec2 uCenter;
uniform float uCellPx, uTilt, uRoll, uAspect;
uniform sampler2D uPatA, uPatB, uWarpA, uWeftA, uWarpB, uWeftB;
uniform ivec2 uPatASz, uPatBSz;
uniform int uWarpAN, uWeftAN, uWarpBN, uWeftBN;
uniform float uWarpW, uWeftW, uCrimp;
uniform vec2 uLightPx;
uniform float uLightH;
uniform float uMorph, uMorphNoise, uMorphGlow;
uniform vec2 uMorphDir;
uniform vec3 uGlowCol;
uniform float uProgress, uShuttleGlow, uShed;
uniform vec2 uShuttle;
uniform vec2 uReveal;
uniform float uDropY;
uniform vec3 uBg;
uniform float uExposure, uSpec, uFog, uRidge;
uniform int uAA;
out vec4 outColor;

int imod(int a, int n) { return int(mod(float(a), float(n))); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

float mval(ivec2 c) { return dot(vec2(c), uMorphDir) + hash12(vec2(c) + 17.) * uMorphNoise; }
bool isB(ivec2 c) { return mval(c) < uMorph; }
float patAt(ivec2 c) {
  if (isB(c)) return texelFetch(uPatB, ivec2(imod(c.x, uPatBSz.x), imod(c.y, uPatBSz.y)), 0).r;
  return texelFetch(uPatA, ivec2(imod(c.x, uPatASz.x), imod(c.y, uPatASz.y)), 0).r;
}
vec3 warpCol(ivec2 c) {
  return isB(c) ? texelFetch(uWarpB, ivec2(imod(c.x, uWarpBN), 0), 0).rgb : texelFetch(uWarpA, ivec2(imod(c.x, uWarpAN), 0), 0).rgb;
}
vec3 weftCol(ivec2 c) {
  return isB(c) ? texelFetch(uWeftB, ivec2(imod(c.y, uWeftBN), 0), 0).rgb : texelFetch(uWeftA, ivec2(imod(c.y, uWeftAN), 0), 0).rgb;
}
bool weftIn(int j, float x) {
  float fp = floor(uProgress), fj = float(j);
  if (fj < fp) return true;
  if (fj > fp) return false;
  return uShuttle.y > 0. ? x < uShuttle.x : x > uShuttle.x;
}
float warpSign(ivec2 c, float x) { return weftIn(c.y, x) ? (patAt(c) > .5 ? 1. : -1.) : 0.; }

vec2 project(vec2 s, out float depth) {
  float focal = uRes.y * 1.25;
  float D = focal / uCellPx;
  float st = sin(uTilt), ct = cos(uTilt);
  float den = focal * ct - s.y * st;
  if (den < 1e-3) { depth = -1.; return vec2(0.); }
  float t = D * ct / den;
  depth = t * focal / D;
  vec2 q = vec2(t * s.x, t * s.y * ct - (D - t * focal) * st);
  float cr = cos(uRoll), sr = sin(uRoll);
  q = vec2(cr * q.x - sr * q.y, (sr * q.x + cr * q.y) / uAspect);
  return uCenter + q;
}

vec3 shade(vec2 p, vec2 lp, out float hit) {
  ivec2 c = ivec2(floor(p));
  vec2 f = p - floor(p);
  bool warpVis = abs(float(c.x) - uReveal.x) <= uReveal.y && p.y > uDropY;
  bool weftVis = weftIn(c.y, p.x);

  float sC = warpSign(c, p.x), sD = warpSign(c + ivec2(0, -1), p.x), sU = warpSign(c + ivec2(0, 1), p.x);
  float hW, dW;
  if (f.y < .5) { float u = f.y + .5; hW = mix(sD, sC, smoothstep(0., 1., u)); dW = (sC - sD) * 6. * u * (1. - u); }
  else          { float u = f.y - .5; hW = mix(sC, sU, smoothstep(0., 1., u)); dW = (sU - sC) * 6. * u * (1. - u); }

  float pC = patAt(c) > .5 ? -1. : 1.;
  float wC = weftVis ? pC : 0.;
  float wL = weftVis ? (patAt(c + ivec2(-1, 0)) > .5 ? -1. : 1.) : 0.;
  float wR = weftVis ? (patAt(c + ivec2(1, 0)) > .5 ? -1. : 1.) : 0.;
  float hF, dF;
  if (f.x < .5) { float u = f.x + .5; hF = mix(wL, wC, smoothstep(0., 1., u)); dF = (wC - wL) * 6. * u * (1. - u); }
  else          { float u = f.x - .5; hF = mix(wC, wR, smoothstep(0., 1., u)); dF = (wR - wC) * 6. * u * (1. - u); }

  float aW = (f.x - .5) / uWarpW, aF = (f.y - .5) / uWeftW;
  bool inW = warpVis && abs(aW) < 1.;
  bool inF = weftVis && abs(aF) < 1.;
  float bW = sqrt(max(0., 1. - aW * aW)), bF = sqrt(max(0., 1. - aF * aF));
  float HW = hW * uCrimp + bW * uWarpW;
  float HF = hF * uCrimp + bF * uWeftW;

  hit = 0.;
  if (!inW && !inF) return uBg;
  hit = 1.;
  bool topW = inW && (!inF || HW >= HF);
  vec3 alb, N, T; float ao, fib, H;
  if (topW) {
    alb = warpCol(c) * (.9 + .2 * hash12(vec2(float(c.x), 3.7)));
    if (!weftVis && uShed > 0.) {
      float up = texelFetch(uPatA, ivec2(imod(c.x, uPatASz.x), imod(int(floor(uProgress)), uPatASz.y)), 0).r;
      alb *= mix(1., up > .5 ? 1.08 : .5, uShed);
    }
    float ph = ((aW * .5 + .5) * 3. + p.y * 1.7) * 6.2832;
    N = normalize(vec3(aW * 1.1 + uRidge * .55 * cos(ph), -dW * uCrimp * 1.4, bW + .12));
    T = normalize(vec3(0., 1., dW * uCrimp));
    float u = (aW * .5 + .5) + p.y * .85;
    fib = hash12(vec2(float(c.x) * 7.13, floor(u * (10. + 34. * uRidge)))) * (1. - .35 * uRidge) + uRidge * .35 * (.5 + .5 * sin(ph));
    ao = mix(.3, 1., smoothstep(-1., 1., hW)) * mix(.5, 1., bW);
    H = HW;
  } else {
    alb = weftCol(c) * (.9 + .2 * hash12(vec2(5.3, float(c.y))));
    float ph = ((aF * .5 + .5) * 3. + p.x * 1.7) * 6.2832;
    N = normalize(vec3(-dF * uCrimp * 1.4, aF * 1.1 + uRidge * .55 * cos(ph), bF + .12));
    T = normalize(vec3(1., 0., dF * uCrimp));
    float u = (aF * .5 + .5) + p.x * .85;
    fib = hash12(vec2(floor(u * (10. + 34. * uRidge)), float(c.y) * 3.71)) * (1. - .35 * uRidge) + uRidge * .35 * (.5 + .5 * sin(ph));
    ao = mix(.3, 1., smoothstep(-1., 1., hF)) * mix(.5, 1., bF);
    H = HF;
  }
  alb = pow(max(alb, vec3(0.)), vec3(2.2));
  vec3 P = vec3(p, H);
  vec3 L = normalize(vec3(lp, uLightH) - P);
  float cr = cos(uRoll), sr = sin(uRoll);
  vec2 vxy = vec2(sr * sin(uTilt), -cr * sin(uTilt));
  vec3 V = normalize(vec3(vxy, cos(uTilt)));
  vec3 Hh = normalize(L + V);
  float diff = max(dot(N, L), 0.);
  float th = dot(T, Hh);
  float sinTH = sqrt(max(0., 1. - th * th));
  float nh = max(dot(N, Hh), 0.);
  float spec = (pow(nh, 36.) * (.3 + .7 * pow(sinTH, 24.)) * .5 + pow(nh, 6.) * .035) * smoothstep(0., .25, diff);
  vec3 col = alb * (.14 + 1.05 * diff) * ao * mix(.8, 1.12, fib);
  col += uSpec * spec * ao * mix(vec3(1., .98, .94), alb * 4., .25);
  return col;
}

void main() {
  vec2 s0 = gl_FragCoord.xy - uRes * .5;
  float dl;
  vec2 lp = project(uLightPx - uRes * .5, dl);
  vec3 acc = vec3(0.);
  float n = 0.;
  for (int k = 0; k < 4; k++) {
    if (k >= uAA * uAA) break;
    vec2 o = uAA == 1 ? vec2(0.) : (vec2(float(k % 2), float(k / 2)) - .5) * .5 + vec2(.125, -.125) * (float(k / 2) * 2. - 1.);
    float depth;
    vec2 p = project(s0 + o, depth);
    vec3 c;
    if (depth < 0.) c = uBg;
    else {
      float h;
      c = shade(p, lp, h);
      if (uMorphGlow > 0.) {
        float mv = dot(p, uMorphDir);
        float e = exp(-pow((mv - uMorph) / 1.6, 2.));
        c += uGlowCol * e * uMorphGlow * mix(.25, 1., h);
      }
      if (uShuttleGlow > 0.) {
        float fp = floor(uProgress);
        vec2 d = (p - vec2(uShuttle.x, fp + .5)) * vec2(1., uAspect);
        float g = exp(-dot(d, d) * .5) * 1.4 + exp(-dot(d, d) * .04) * .22;
        if (floor(p.y) == fp) {
          float behind = (uShuttle.x - p.x) * uShuttle.y;
          if (behind > 0.) g += exp(-behind * .1) * .55 * h;
        }
        c += uGlowCol * g * uShuttleGlow;
      }
      c = mix(c, uBg, clamp((depth - 1.) * uFog, 0., .92));
    }
    acc += c; n += 1.;
  }
  vec3 col = acc / n;
  col = vec3(1.) - exp(-col * uExposure);
  outColor = vec4(pow(col, vec3(1. / 2.2)), 1.);
}`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || 'shader compile failed');
    return s;
  }
  function program(gl, vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link failed');
    const u = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name.replace(/\[0\]$/, '')] = gl.getUniformLocation(p, info.name); }
    return { p, u };
  }

  const DEFAULTS = {
    center: [0, 0], cellPx: 24, tilt: 0, roll: 0, aspect: 1,
    warpW: 0.42, weftW: 0.42, crimp: 0.26,
    light: null, lightH: 10,
    morph: -1e9, morphDir: [0.86, 0.5], morphNoise: 2.5, morphGlow: 0, glow: [1.0, 0.62, 0.32],
    progress: 1e8, shuttle: [0, 1], shuttleGlow: 0, shed: 0,
    reveal: [0, 1e8], dropY: -1e8,
    bg: [0.012, 0.014, 0.022], exposure: 1.6, spec: 1, fog: 0, aa: 1, ridge: 0,
  };

  class FabricGL {
    constructor(canvas, opts) {
      opts = opts || {};
      const gl = opts.gl || canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: !!opts.preserve, powerPreference: 'high-performance' });
      if (!gl) throw new Error('WebGL2 unavailable');
      this.gl = gl; this.canvas = canvas;
      this.prog = program(gl, VS, FS);
      this.vao = gl.createVertexArray();
      this.tex = {};
      this.size = {};
      ['PatA', 'PatB', 'WarpA', 'WeftA', 'WarpB', 'WeftB'].forEach(k => { this.tex[k] = gl.createTexture(); });
      this.setPattern('A', weave('plain'));
      this.setPattern('B', weave('plain'));
      this.setColors('A', ['#888888'], ['#cccccc']);
      this.setColors('B', ['#888888'], ['#cccccc']);
    }
    _tex(key, w, h, internal, format, data) {
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.tex[key]);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, gl.UNSIGNED_BYTE, data);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.size[key] = [w, h];
    }
    setPattern(slot, pat) {
      const data = new Uint8Array(pat.cells.length);
      for (let i = 0; i < data.length; i++) data[i] = pat.cells[i] ? 255 : 0;
      this._tex('Pat' + slot, pat.w, pat.h, this.gl.R8, this.gl.RED, data);
    }
    setColors(slot, warp, weft) {
      const enc = arr => { const d = new Uint8Array(arr.length * 4); arr.forEach((h, i) => { const c = hexToRgb(h); d.set([c[0], c[1], c[2], 255], i * 4); }); return d; };
      this._tex('Warp' + slot, warp.length, 1, this.gl.RGBA8, this.gl.RGBA, enc(warp));
      this._tex('Weft' + slot, weft.length, 1, this.gl.RGBA8, this.gl.RGBA, enc(weft));
    }
    createTarget(w, h) {
      const gl = this.gl;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return { fb, tex, w, h };
    }
    render(params, target) {
      const gl = this.gl, P = Object.assign({}, DEFAULTS, params), U = this.prog.u;
      const w = target ? target.w : gl.drawingBufferWidth, h = target ? target.h : gl.drawingBufferHeight;
      gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fb : null);
      gl.viewport(0, 0, w, h);
      gl.useProgram(this.prog.p);
      gl.bindVertexArray(this.vao);
      const keys = ['PatA', 'PatB', 'WarpA', 'WeftA', 'WarpB', 'WeftB'];
      keys.forEach((k, i) => { gl.activeTexture(gl.TEXTURE0 + i); gl.bindTexture(gl.TEXTURE_2D, this.tex[k]); gl.uniform1i(U['u' + k], i); });
      gl.uniform2i(U.uPatASz, this.size.PatA[0], this.size.PatA[1]);
      gl.uniform2i(U.uPatBSz, this.size.PatB[0], this.size.PatB[1]);
      gl.uniform1i(U.uWarpAN, this.size.WarpA[0]); gl.uniform1i(U.uWeftAN, this.size.WeftA[0]);
      gl.uniform1i(U.uWarpBN, this.size.WarpB[0]); gl.uniform1i(U.uWeftBN, this.size.WeftB[0]);
      gl.uniform2f(U.uRes, w, h);
      gl.uniform2f(U.uCenter, P.center[0], P.center[1]);
      gl.uniform1f(U.uCellPx, P.cellPx); gl.uniform1f(U.uTilt, P.tilt); gl.uniform1f(U.uRoll, P.roll); gl.uniform1f(U.uAspect, P.aspect);
      gl.uniform1f(U.uWarpW, P.warpW); gl.uniform1f(U.uWeftW, P.weftW); gl.uniform1f(U.uCrimp, P.crimp);
      const light = P.light || [w * 0.3, h * 0.75];
      gl.uniform2f(U.uLightPx, light[0], light[1]); gl.uniform1f(U.uLightH, P.lightH);
      gl.uniform1f(U.uMorph, P.morph); gl.uniform2f(U.uMorphDir, P.morphDir[0], P.morphDir[1]);
      gl.uniform1f(U.uMorphNoise, P.morphNoise); gl.uniform1f(U.uMorphGlow, P.morphGlow);
      gl.uniform3f(U.uGlowCol, P.glow[0], P.glow[1], P.glow[2]);
      gl.uniform1f(U.uProgress, P.progress); gl.uniform2f(U.uShuttle, P.shuttle[0], P.shuttle[1]);
      gl.uniform1f(U.uShuttleGlow, P.shuttleGlow); gl.uniform1f(U.uShed, P.shed);
      gl.uniform2f(U.uReveal, P.reveal[0], P.reveal[1]); gl.uniform1f(U.uDropY, P.dropY);
      gl.uniform3f(U.uBg, P.bg[0], P.bg[1], P.bg[2]);
      gl.uniform1f(U.uExposure, P.exposure); gl.uniform1f(U.uSpec, P.spec); gl.uniform1f(U.uFog, P.fog); gl.uniform1f(U.uRidge, P.ridge);
      gl.uniform1i(U.uAA, P.aa);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.bindVertexArray(null);
      if (target) {
        gl.bindTexture(gl.TEXTURE_2D, target.tex);
        gl.generateMipmap(gl.TEXTURE_2D);
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      }
    }
  }
  FabricGL.supported = function () {
    try { const c = document.createElement('canvas'); return !!c.getContext('webgl2'); } catch (e) { return false; }
  };

  // ---------------------------------------------------------------- shoe
  // Lateral view of a running shoe, viewBox units, toe to the right, ground at y≈400.
  const SHOE = {
    parts: [
      { id: 'outsole', zh: '大底', en: 'Outsole', mat: '橡膠', note: '接地抓地，前掌上翹做出滾動感', fill: '#2a2b30',
        d: 'M 92 372 C 100 386 124 396 170 397 L 720 399 C 800 399 872 383 922 340 C 926 336 929 332 930 328 L 918 330 C 868 372 800 384 720 384 L 172 382 C 140 382 116 378 92 372 Z',
        ex: [0, 96], anchor: [420, 392] },
      { id: 'midsole', zh: '中底', en: 'Midsole', mat: 'EVA／超臨界發泡', note: '吸震回彈，厚度決定腳感', fill: '#ecebe6',
        d: 'M 80 300 C 66 322 72 364 104 386 C 120 394 140 396 170 396 L 720 398 C 800 398 872 382 922 340 C 934 330 934 318 920 318 C 860 326 790 336 700 333 C 560 326 420 306 300 298 C 200 292 120 290 80 300 Z',
        ex: [0, 52], anchor: [560, 360] },
      { id: 'insole', zh: '鞋墊', en: 'Sockliner', mat: 'PU 發泡＋針織面布', note: '直接貼腳，吸汗、補一層緩衝', fill: '#7f8798',
        d: 'M 104 296 C 200 288 330 292 440 300 C 600 314 760 326 880 318 C 892 317 896 324 884 328 C 760 338 600 330 440 316 C 330 308 200 304 110 308 C 100 306 98 298 104 296 Z',
        ex: [0, 27], anchor: [600, 318] },
      { id: 'upper', zh: '鞋面', en: 'Vamp & Quarter', mat: '織物：工程網布／賈卡／帆布', note: '你在實驗室織的布就裁在這裡', fill: 'fabric',
        d: 'M 84 302 C 64 262 62 204 94 152 C 116 138 156 146 186 166 C 212 184 248 186 282 168 L 318 150 C 420 186 520 222 604 252 C 700 284 820 298 904 306 C 924 309 932 318 922 322 C 860 330 790 337 700 333 C 560 326 420 306 300 298 C 200 292 120 290 84 302 Z',
        ex: [0, -8], anchor: [690, 300] },
      { id: 'saddle', zh: '中足支撐', en: 'Midfoot saddle', mat: 'TPU 無縫熱壓膜', note: '鎖住中足，不必車縫', fill: 'rgba(255,255,255,0.55)', stroke: true,
        d: 'M 372 204 C 360 240 346 270 334 300 M 440 228 C 432 260 424 286 418 306 M 508 250 C 504 276 502 298 500 320',
        ex: [0, -30], anchor: [440, 268] },
      { id: 'toecap', zh: '鞋頭', en: 'Toe bumper', mat: 'TPU 熱熔膜／合成革', note: '耐磨、防踢', fill: '#d9dbe0',
        d: 'M 812 300 C 860 302 900 305 916 310 C 930 315 932 321 922 324 C 880 330 846 333 812 334 C 800 324 802 308 812 300 Z',
        ex: [96, -16], anchor: [868, 318] },
      { id: 'heel', zh: '後跟補強', en: 'Heel counter', mat: 'TPU 補強片', note: '包覆後跟，穩定落地', fill: '#3a3f4b',
        d: 'M 84 302 C 64 262 64 214 88 174 C 118 182 152 206 178 252 C 188 272 190 288 186 296 C 150 292 112 292 84 302 Z',
        ex: [-96, 6], anchor: [120, 250] },
      { id: 'eyestay', zh: '眼片', en: 'Eyestay', mat: '合成革補強＋鞋眼', note: '分散鞋帶拉力', fill: '#1f2433',
        d: 'M 312 152 C 420 188 520 224 608 254 L 600 284 C 512 256 408 220 298 182 Z',
        ex: [36, -74], anchor: [456, 214] },
      { id: 'tongue', zh: '鞋舌', en: 'Tongue', mat: '網布＋海綿', note: '隔開鞋帶壓力', fill: '#c9ccd3',
        d: 'M 296 166 C 290 132 306 104 340 98 C 366 94 384 106 382 124 C 380 140 392 160 420 190 C 380 182 330 176 296 166 Z',
        ex: [14, -138], anchor: [344, 130] },
      { id: 'collar', zh: '領口', en: 'Collar', mat: '泡棉＋針織內裡', note: '包覆腳踝，不磨腳', fill: '#2e3340',
        d: 'M 94 152 C 116 138 156 146 186 166 C 212 184 248 186 282 168 L 318 150 L 322 166 L 288 184 C 250 204 206 202 176 184 C 150 166 120 160 100 168 Z',
        ex: [-48, -84], anchor: [200, 180] },
      { id: 'tab', zh: '拉環', en: 'Pull tab', mat: '織帶', note: '穿鞋時好拉', fill: '#c8372d',
        d: 'M 92 156 C 84 132 90 110 104 106 C 116 104 122 114 120 128 L 112 160 Z',
        ex: [-96, -92], anchor: [104, 124] },
      { id: 'laces', zh: '鞋帶', en: 'Laces', mat: '聚酯編織帶', note: '扁帶比圓帶不易鬆', fill: '#f2f0ea', stroke: true, d: '',
        ex: [44, -118], anchor: [470, 210] },
    ],
  };
  // eyelets along the eyestay, laces built from them
  SHOE.eyelets = [];
  for (let i = 0; i < 6; i++) {
    const t = i / 5;
    SHOE.eyelets.push([336 + (586 - 336) * t + Math.sin(t * Math.PI) * -6, 172 + (264 - 172) * t + Math.sin(t * Math.PI) * 10]);
  }
  (function buildLaces() {
    const e = SHOE.eyelets;
    let d = '';
    for (let i = 0; i < e.length - 1; i++) {
      const a = e[i], b = e[i + 1];
      d += `M ${a[0]} ${a[1]} C ${a[0] + 14} ${a[1] - 24} ${b[0] - 10} ${b[1] - 34} ${b[0] + 6} ${b[1] - 26} `;
    }
    const top = e[0];
    d += `M ${top[0]} ${top[1]} C ${top[0] - 34} ${top[1] - 40} ${top[0] - 66} ${top[1] - 18} ${top[0] - 30} ${top[1] - 6} `;
    d += `M ${top[0]} ${top[1]} C ${top[0] + 6} ${top[1] - 52} ${top[0] + 46} ${top[1] - 44} ${top[0] + 18} ${top[1] - 10} `;
    d += `M ${top[0] - 2} ${top[1] - 2} C ${top[0] - 20} ${top[1] + 20} ${top[0] - 34} ${top[1] + 44} ${top[0] - 28} ${top[1] + 62} `;
    SHOE.parts.find(p => p.id === 'laces').d = d;
  })();

  global.FabricCore = {
    WEAVES, weave, make, invert, resize, jacquard, measureJacquard,
    weaveStats, fabricSpec, colorOrder, hexToRgb, rgbToHex, mixHex,
    project, FabricGL, SHOE, mod, clamp,
  };
})(typeof window !== 'undefined' ? window : globalThis);
