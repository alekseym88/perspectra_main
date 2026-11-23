// Viewer adapted from landing/Perspectra_Track_Preview_1.html.
// v7 supports independent automatic NPZ exports and the original corrected Garage scene.
(() => {
"use strict";
/**
 * <perspectra-preview> — an interactive, simplified Blender viewport showing a Perspectra video track.
 *
 *   <script type="module" src="perspectra-preview.js"><\/script>
 *   <perspectra-preview src="data/scene.json" video="data/footage.mp4" poster="data/poster.jpg" autoplay></perspectra-preview>
 *
 * Everything shown comes from data/scene.json, written by export_scene.py inside Blender from the add-on's own
 * result and overlay state. This file only DRAWS that data; it never tracks, fits or re-scores anything.
 *
 * Layout (one application, three areas):  viewport (stage)  ·  control bar + timeline  ·  footer (legend, keys).
 * Components: SceneData (decode) · Playback (video = clock) · Overlay2D (Blender's picture overlays, label placement,
 * picking) · Scene3D (Three.js objects + overview) · OrbitRig (overview navigation) · Timeline (ruler, health) ·
 * PerspectraPreview (the element that wires them together).
 */
const THREE = window.THREE;

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);            // keep Blender's Z-up world: no axis conversion anywhere

// ─── colours: the add-on's overlay colours (video_report / floor_tris / video_edges) ────────────────────────────
const rgba = (c, a) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${a ?? (c[3] ?? 1)})`;
const TP_OK = [0.2, 1.0, 0.45], TP_BAD = [1.0, 0.2, 0.2], TP_OFF = [0.6, 0.6, 0.6], TP_YEL = [1.0, 0.85, 0.2];
const TRI_COL = { ok: [0.25, 0.85, 0.4], off: [1.0, 0.25, 0.2], out: [0.55, 0.55, 0.55] };
const EDGE_COL = { g: [0.25, 0.9, 0.35], r: [1.0, 0.3, 0.25], n: [0.6, 0.6, 0.6] };
const LANE_COL = { out: [0.55, 0.55, 0.55, 0.6], off: [1.0, 0.25, 0.2, 0.95] };
const BLUE = "#4772b3";                              // Blender: playhead, active button
const SEL = [1.0, 0.63, 0.16];                       // Blender: selected object orange
const AX_X = 0xff3352, AX_Y = 0x8bdc00;              // Blender theme axis colours
const FONT = '"Instrument Sans", "Inter", "Segoe UI", system-ui, -apple-system, sans-serif';
const STATE_WORD = { ok: "on its spot", off: "off on this frame", gone: "not tracked on this frame", dis: "switched off" };

// Presentation-only similarity transform for automatic camera/point-cloud exports.
// The same rotation, translation and uniform scale are applied to all geometry;
// image reprojection and the shape of the solved motion are unchanged.
function alignAutomaticScene(source) {
  if (!source.preset || !source.presentation?.normalize) return source;
  const j = structuredClone(source), start = j.presentation.playback.start - j.frames.start;
  const c0 = j.camera.pos.slice(start * 3, start * 3 + 3);
  const shared = j.presentation.alignments?.[j.preset.toLowerCase()];
  if (!shared && !(c0[2] > 1e-4)) throw new Error('This result needs a valid starting floor height before preview alignment.');
  const q0 = new THREE.Quaternion(...j.camera.quat.slice(start * 4, start * 4 + 4));
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(q0);
  const yaw = Math.atan2(forward.x, forward.y);
  const rotation = shared ? new THREE.Quaternion(...shared.rotation) : new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), yaw);
  const scale = shared?.scale ?? j.presentation.cameraHeight / c0[2];
  const offset = new THREE.Vector3(...(shared?.sourceOrigin || [c0[0], c0[1], 0]));
  const origin = new THREE.Vector3(...(shared?.origin || [0, 0, 0]));
  const positions = values => {
    const out = [];
    for (let i = 0; i < values.length; i += 3) out.push(...new THREE.Vector3(...values.slice(i, i + 3)).sub(offset).applyQuaternion(rotation).multiplyScalar(scale).add(origin).toArray());
    return out;
  };
  j.camera.pos = positions(j.camera.pos);
  for (let i = 0; i < j.camera.quat.length; i += 4) {
    const q = new THREE.Quaternion(...j.camera.quat.slice(i, i + 4)).premultiply(rotation).normalize();
    j.camera.quat.splice(i, 4, ...q.toArray());
  }
  if (j.cloud) j.cloud.xyz = positions(j.cloud.xyz);
  // The comparison grid and test cube use the reference floor, not a different
  // independently estimated floor for each quality preset.
  j.worldUp = shared ? [0, 0, 1] : new THREE.Vector3(...j.worldUp).applyQuaternion(rotation).toArray();
  j.overviewBounds = j.presentation.overviewBounds;
  j.cubeSize = .5;
  j.displayAlignment = {scale, yaw, cameraHeight:j.presentation.cameraHeight, originalStart:c0,
    reference:shared?.reference, method:shared?.method, matchedPoints:shared?.matchedPoints};
  return j;
}
function trackingDuration(seconds) {
  if (!Number.isFinite(seconds)) return 'Not recorded';
  const n = Math.round(seconds), hours = Math.floor(n / 3600), minutes = Math.floor(n % 3600 / 60), rest = n % 60;
  return (hours ? hours + 'h ' : '') + (minutes || hours ? minutes + 'm ' : '') + rest + 's';
}

// ═══ SceneData ═════════════════════════════════════════════════════════════════════════════════════════════════
class SceneData {
  constructor(j) {
    j = alignAutomaticScene(j);
    this.j = j;
    const fs = (this.fs = j.frames.start), fe = (this.fe = j.frames.end), n = (this.n = fe - fs + 1);
    this.W = j.video.width; this.H = j.video.height; this.fps = j.video.fps;
    this.clipStart = j.video.clipStart;
    this.cam = j.camera;
    this.rowSet = new Set(j.rows.frames);
    this.edgeRows = new Set(j.edgeRows || j.rows.frames);
    this.near = Int32Array.from(j.near);
    const qRow = new Map(j.rows.frames.map((f, k) => [f, j.rows.quality[k]]));
    this.qFrame = Int8Array.from(j.near, (f) => (qRow.get(f) ?? -1));
    this.tps = j.tpoints.map((tp) => {
      const xy = new Float32Array(n * 2).fill(NaN);
      let first = Infinity, last = -Infinity, count = 0;
      for (const run of tp.tr) {
        let f = run[0], x = run[2], y = run[3];
        first = Math.min(first, f); last = Math.max(last, f + run[1] - 1); count += run[1];
        for (let i = 0; i < run[1]; i++) {
          if (i) { x += run[2 + 2 * i]; y += run[3 + 2 * i]; }
          const k = f + i - fs;
          if (k >= 0 && k < n) { xy[2 * k] = x / 4; xy[2 * k + 1] = y / 4; }
        }
      }
      const bad = new Uint8Array(n);
      for (const [a, b] of tp.off) for (let f = a; f <= b; f++) if (f >= fs && f <= fe) bad[f - fs] = 1;
      return { ...tp, xy, bad, keySet: new Set(tp.keys), Xv: tp.X ? new THREE.Vector3(...tp.X) : null,
        span: count ? [first, last] : null, count };
    });
    this.tpById = new Map(this.tps.map((t) => [t.id, t]));
    this.surfaces = j.surfaces.map((s) => {
      const st = new Int8Array(n);                   // 0 = not followed, 1 ok, 2 off, 3 out
      for (const [a, b, v] of s.state) for (let f = a; f <= b; f++) if (f >= fs && f <= fe) st[f - fs] = { ok: 1, off: 2, out: 3 }[v];
      return { ...s, st };
    });
    this.surfById = new Map(this.surfaces.map((s) => [s.id, s]));
    this.edges = j.edges.map((e) => {
      const seg = new Array(n).fill(null);
      let count = 0;
      for (const [a, , list] of e.segs) list.forEach((s, i) => { const k = a + i - fs; count++; if (k >= 0 && k < n) seg[k] = s; });
      const L = e.line;
      return { ...e, seg, count, X0: L ? new THREE.Vector3(...L.X0) : null, d: L ? new THREE.Vector3(...L.d) : null };
    });
    this.edgeById = new Map(this.edges.map((e) => [e.id, e]));
    this.Q = Object.fromEntries(Object.entries(j.health.colors).map(([k, c]) => [+k, c]));
    this.qWord = j.health.words || { 0: "solid", 1: "check", 2: "weak", 3: "blurred – pose filled in", 4: "camera jump repaired" };
    this.qPresent = [...new Set(j.rows.quality)].sort((a, b) => a - b);
    this.up = new THREE.Vector3(...(j.worldUp || [0, 0, 1])).normalize();   // the tracked scene's up (cube stands on it)
    this.cubeSize = j.cubeSize || 0.5;
    this.unavailable = new Set(j.sampling?.unavailableSourceFrames ?? j.untrackedSourceFrames ?? []);
    this.interpolated = new Set(j.sampling?.interpolatedSourceFrames || []);
    this.held = new Set(j.sampling?.heldSourceFrames || []);
    // Source playback can extend beyond solved camera samples (for example a blank tail).
    // Keep geometry arrays and the camera path restricted to their actual exported range.
    this.playback = Object.create(this);
    const range = j.provenance?.source_range;
    this.playback.fs = range ? this.clipStart + range[0] : fs;
    this.playback.fe = range ? this.clipStart + range[1] : fe;
    if (j.presentation?.playback) {
      this.playback.fs = Math.max(this.playback.fs, j.presentation.playback.start);
      this.playback.fe = Math.min(this.playback.fe, j.presentation.playback.end);
    }
    this.playback.n = this.playback.fe - this.playback.fs + 1;
    this.playback.k = this.k.bind(this);
    this.playback.hasCamera = this.hasCamera.bind(this);
  }
  hasCamera(f) { return f >= this.fs && f <= this.fe && !this.unavailable.has(f - this.clipStart); }
  sampleNote(f) {
    const source = f - this.clipStart;
    if (!this.hasCamera(f)) return 'No camera estimate · Overlays hidden on this source frame';
    if (this.held.has(source)) return 'Held camera pose · Unsampled boundary frame';
    if (this.interpolated.has(source)) return 'Interpolated camera pose · Between directly tracked frames';
    return '';
  }
  clampF(f) { return Math.max(this.fs, Math.min(this.fe, Math.round(f))); }
  k(f) { return f - this.fs; }
  pose(f) {
    const k = this.k(f), c = this.cam;
    return { p: c.pos.slice(3 * k, 3 * k + 3), q: c.quat.slice(4 * k, 4 * k + 4), lens: c.lens[k] };
  }
  /** video_tools.tpoint_here: the tracked spot (px, undistorted) on this frame, else on the nearest tracked row. */
  tpHere(tp, f) {
    let k = this.k(f);
    if (k < 0 || k >= this.n) return null;
    if (!Number.isNaN(tp.xy[2 * k])) return [tp.xy[2 * k], tp.xy[2 * k + 1]];
    const nf = this.near[k];
    if (!nf) return null;
    k = this.k(nf);
    return Number.isNaN(tp.xy[2 * k]) ? null : [tp.xy[2 * k], tp.xy[2 * k + 1]];
  }
  /** _draw_tpoints colour rule: red where off on THIS frame (or loose when no per-frame status), grey when off. */
  tpBad(tp, f) { return tp.hasStatus ? !!tp.bad[this.k(f)] : tp.loose; }
  tpState(tp, f) { return !tp.on ? "dis" : !this.tpHere(tp, f) ? "gone" : this.tpBad(tp, f) ? "off" : "ok"; }
  hfovTan(lens) { return (this.cam.sensor / 2) / lens; }   // sensor fit horizontal (the picture is wider than tall)
  spotAt(f) { return this.j.health.spots.find((s) => f >= s.a - 0.5 && f <= s.b + 0.5) || null; }
  bridgeAt(f) { return this.j.health.bridges.find(([a, b]) => f >= a && f <= b) || null; }
}

// ═══ Playback: the <video> is the clock. Every visual follows the frame the video has actually presented. ═══════
class Playback extends EventTarget {
  constructor(video, data) {
    super();
    this.v = video; this.d = data.playback;
    this.frame = this.d.fs;        // requested source frame (playhead)
    this.shown = this.d.fs;        // frame the footage is showing (what everything draws)
    this.playing = false;
    this.ready = false;
    const v = video;
    v.muted = true; v.playsInline = true; v.preload = "auto";
    this.hasRVFC = "requestVideoFrameCallback" in HTMLVideoElement.prototype;
    v.addEventListener("loadeddata", () => { this.ready = true; this.seek(this.frame, true); });
    v.addEventListener("seeked", () => { if (!this.playing) { this.frame=this.d.clampF(this.frameOf(v.currentTime)); this._present(this.frame); } });
    v.addEventListener("error", () => { this.ready = false; this._present(this.frame); });
    if (this.hasRVFC) {
      const tick = (_now, meta) => { if (this.disposed) return; this._lastV = performance.now(); this._onVideoFrame(meta.mediaTime); this.videoFrameID = v.requestVideoFrameCallback(tick); };
      this.videoFrameID = v.requestVideoFrameCallback(tick);
    }
  }
  timeOf(f) { return (f - this.d.clipStart + 0.3) / this.d.fps; }               // inside the frame, not on its edge
  frameOf(t) { return Math.floor(t * this.d.fps + 1e-3) + this.d.clipStart; }
  _onVideoFrame(t) {
    if (!this.playing && Math.abs(t-this.v.currentTime)>1/this.d.fps) return;
    const f = this.frameOf(t);
    if (this.playing) {
      if (f >= this.d.fe) { this._present(this.d.fe); this.v.currentTime = this.timeOf(this.d.fs); return; }   // loop like Blender
      this.frame = this.d.clampF(f);
    }
    this._present(this.d.clampF(f));
  }
  _present(f) {
    this.shown = f;
    this.dispatchEvent(new CustomEvent("frame", { detail: { frame: this.frame, shown: f } }));
  }
  _rafLoop() {                                      // fallback clock: no requestVideoFrameCallback, or it went quiet
    if (!this.playing) return;
    if (!this.hasRVFC || performance.now() - (this._lastV || 0) > 120) this._onVideoFrame(this.v.currentTime);
    requestAnimationFrame(() => this._rafLoop());
  }
  seek(f, force = false) {
    f = this.d.clampF(f);
    if (f === this.frame && !force) return;
    this.frame = f;
    if (!this.ready) { this._present(f); return; }
    const t = this.timeOf(f);
    if (Math.abs(this.v.currentTime - t) > 0.5 / this.d.fps || force) this.v.currentTime = t;
    if (!this.hasRVFC) this._present(f);
    this.dispatchEvent(new CustomEvent("frame", { detail: { frame: f, shown: this.shown } }));
  }
  play() {
    if (this.playing) return;
    if (this.frame >= this.d.fe) this.seek(this.d.fs, true);
    this.playing = true;
    const p = this.v.play();
    if (p && p.catch) p.catch(() => { this.playing = false; this.dispatchEvent(new Event("state")); });
    this._rafLoop();
    this.dispatchEvent(new Event("state"));
  }
  pause() {
    if (!this.playing) return;
    this.playing = false;
    this.v.pause();
    this.seek(this.shown, true);                    // land exactly on the frame being shown
    this.dispatchEvent(new Event("state"));
  }
  toggle() { this.playing ? this.pause() : this.play(); }
  dispose() {
    this.playing = false; this.disposed = true; this.v.pause();
    if (this.videoFrameID != null) this.v.cancelVideoFrameCallback(this.videoFrameID);
    this.v.removeAttribute('src'); this.v.load();
  }
}

// ═══ Overlay2D: the add-on's picture overlays, redrawn from the baked data, with label placement and picking ═════
class Boxes {                                      // greedy collision set for labels
  constructor() { this.b = []; }
  free(r) { return !this.b.some((o) => r.x < o.x + o.w && r.x + r.w > o.x && r.y < o.y + o.h && r.y + r.h > o.y); }
  add(r) { this.b.push(r); }
}
class Overlay2D {
  constructor(canvas) { this.c = canvas; this.g = canvas.getContext("2d"); }
  resize(w, h, dpr) { this.w = w; this.h = h; this.dpr = dpr; this.c.width = Math.round(w * dpr); this.c.height = Math.round(h * dpr); }
  clear() { const g = this.g; g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); g.clearRect(0, 0, this.w, this.h); }

  /** A tracked marker: state colour fill, a dark outer ring and a light inner rim (reads on bright and dark footage). */
  _marker(x, y, r, fill, rim, rimW) {
    const g = this.g;
    g.beginPath(); g.arc(x, y, r + rimW * 0.5 + 0.9, 0, Math.PI * 2); g.fillStyle = "rgba(0,0,0,.72)"; g.fill();
    g.beginPath(); g.arc(x, y, r + rimW * 0.5, 0, Math.PI * 2); g.fillStyle = rim; g.fill();
    g.beginPath(); g.arc(x, y, r - rimW * 0.5, 0, Math.PI * 2); g.fillStyle = fill; g.fill();
  }
  _ring(x, y, r, col, w = 2) {
    const g = this.g;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2);
    g.lineWidth = w + 2; g.strokeStyle = "rgba(0,0,0,.6)"; g.stroke();
    g.lineWidth = w; g.strokeStyle = col; g.stroke();
  }
  _pill(txt, x, y, col, strong) {                 // label: small pill with a translucent dark ground
    const g = this.g;
    g.font = `600 10.5px ${FONT}`; g.textBaseline = "middle"; g.textAlign = "left";
    const w = g.measureText(txt).width + 8;
    g.fillStyle = strong ? "rgba(10,10,14,.86)" : "rgba(12,12,16,.6)";
    roundRect(g, x, y, w, 15, 4); g.fill();
    if (strong) { g.lineWidth = 1; g.strokeStyle = rgba(SEL, 0.9); g.stroke(); }
    g.fillStyle = col; g.fillText(txt, x + 4, y + 7.8);
  }
  _measure(txt) { this.g.font = `600 10.5px ${FONT}`; return this.g.measureText(txt).width + 8; }

  /**
   * Camera view: surfaces, edges, track points (the add-on's order and colours), then labels placed without
   * collisions. Returns the pick list (what is under the mouse) for hover / selection.
   */
  drawCamera(V, f, opt) {
    const { d, rect } = V, g = this.g, picks = [], boxes = new Boxes(), labels = [];
    const toPx = (x, y) => [rect.x0 + (x / d.W) * rect.w, rect.y0 + (y / d.H) * rect.h];
    const isSel = (k, id) => opt.sel && opt.sel.kind === k && opt.sel.id === id;
    const isHov = (k, id) => opt.hov && opt.hov.kind === k && opt.hov.id === id;
    // ── surfaces
    if (opt.show.surfaces) for (const s of d.surfaces) {
      let st = s.st[d.k(f)], xy = null;
      if (st) {
        const uv = s.tps.map((i) => (d.tpById.has(i) ? d.tpHere(d.tpById.get(i), f) : null));
        if (uv.every(Boolean)) xy = uv.map((q) => toPx(q[0], q[1]));
      }
      if (!xy) {                                                     // not followed here: grey, at its 3-D spots
        st = 3; xy = [];
        for (const i of s.tps) {
          const tp = d.tpById.get(i);
          const p = tp && tp.Xv && V.inFront(tp.Xv, 0.05) ? V.project(tp.Xv) : null;
          if (!p) break;
          xy.push(p);
        }
        if (xy.length < 3) continue;
      }
      const c = TRI_COL[["", "ok", "off", "out"][st]], hi = isSel("surf", s.id) || isHov("surf", s.id);
      g.beginPath(); g.moveTo(...xy[0]); g.lineTo(...xy[1]); g.lineTo(...xy[2]); g.closePath();
      g.fillStyle = rgba(c, hi ? 0.28 : 0.12); g.fill();
      g.setLineDash(s.floor ? [] : [5, 3]);
      g.lineWidth = 3.2; g.strokeStyle = "rgba(0,0,0,.35)"; g.stroke();
      g.lineWidth = hi ? 2.2 : 1.4; g.strokeStyle = isSel("surf", s.id) ? rgba(SEL, 1) : rgba(c, 0.92); g.stroke();
      g.setLineDash([]);
      for (const [x, y] of xy) {
        g.fillStyle = "rgba(0,0,0,.7)"; g.fillRect(x - 3.2, y - 3.2, 6.4, 6.4);
        g.fillStyle = rgba(c, 1); g.fillRect(x - 2.2, y - 2.2, 4.4, 4.4);
      }
      const cx = (xy[0][0] + xy[1][0] + xy[2][0]) / 3, cy = (xy[0][1] + xy[1][1] + xy[2][1]) / 3;
      labels.push({ prio: hi ? 0 : 2, txt: s.label, col: rgba(c, 1), ax: cx, ay: cy, center: true, strong: isSel("surf", s.id) });
      picks.push({ kind: "surf", id: s.id, tri: xy, state: ["", "ok", "off", "out"][st] });
    }
    // ── edges (clipped to the picture, like the add-on)
    if (opt.show.edges) {
      g.save(); g.beginPath(); g.rect(rect.x0, rect.y0, rect.w, rect.h); g.clip();
      const exact = d.edgeRows.has(f);
      for (const e of d.edges) {
        const s = e.seg[d.k(f)];
        const usable = e.line && e.line.usable, hi = isSel("edge", e.id) || isHov("edge", e.id);
        let col = EDGE_COL.n, off = -1, anchor = null, seg = null;
        if (s) {
          col = EDGE_COL[s[4]]; off = s[5];
          const a = toPx(s[0], s[1]), b = toPx(s[2], s[3]);
          g.beginPath(); g.moveTo(...a); g.lineTo(...b);
          g.lineWidth = hi ? 5 : 4; g.strokeStyle = "rgba(0,0,0,.5)"; g.stroke();
          g.lineWidth = hi ? 2.6 : 2; g.strokeStyle = isSel("edge", e.id) ? rgba(SEL, 1) : rgba(col, 0.88); g.stroke();
          anchor = a[1] < b[1] ? a : b; seg = [a, b];
        } else if (exact && usable) {                                // not tracked here: where its 3-D line lands (guide)
          const P = V.projectLine(e.X0, e.d, e.line.span);
          if (P.length >= 2) {
            g.beginPath(); g.moveTo(...P[0]); for (const p of P.slice(1)) g.lineTo(...p);
            g.setLineDash([6, 4]);
            g.lineWidth = 2.6; g.strokeStyle = "rgba(0,0,0,.35)"; g.stroke();
            g.lineWidth = hi ? 1.6 : 1.1; g.strokeStyle = isSel("edge", e.id) ? rgba(SEL, 1) : rgba(EDGE_COL.n, 0.7); g.stroke();
            g.setLineDash([]);
            anchor = P[P.length >> 1]; seg = [P[0], P[P.length - 1]];
          }
        }
        if (anchor) {
          const ax = Math.min(Math.max(anchor[0], rect.x0), rect.x0 + rect.w - 60), ay = Math.min(Math.max(anchor[1], rect.y0 + 10), rect.y0 + rect.h - 10);
          labels.push({ prio: hi ? 0 : s ? 1 : 3, txt: e.id + (off >= 0 ? ` · ${off} px` : ""), col: rgba(col, 1), ax, ay, strong: isSel("edge", e.id) });
          picks.push({ kind: "edge", id: e.id, seg, state: s ? s[4] : "n", off });
        }
      }
      g.restore();
    }
    // ── track points
    if (opt.show.tpoints) {
      const mk = [];
      for (const tp of d.tps) {
        if (tp.tri) continue;                                         // drawn as its surface
        const uv = d.tpHere(tp, f);
        const s = uv ? toPx(uv[0], uv[1]) : null;
        const pr = tp.Xv ? V.project(tp.Xv) : null;
        if (!s && !pr) continue;
        const state = d.tpState(tp, f);
        mk.push({ tp, s, pr, state, key: tp.keySet.has(f) });
      }
      // grey (not tracked here) first, so tracked points sit on top
      mk.sort((a, b) => (a.s ? 1 : 0) - (b.s ? 1 : 0));
      for (const m of mk) {
        const { tp, s, pr, state } = m, p = s || pr;
        if (s && pr && Math.hypot(s[0] - pr[0], s[1] - pr[1]) > 2) {   // where its 3-D spot lands, when they disagree
          const lc = tp.on ? rgba(TP_YEL, 0.95) : rgba(TP_OFF, 0.7);
          g.lineWidth = 1.2; g.strokeStyle = lc;
          g.beginPath(); g.moveTo(s[0], s[1]); g.lineTo(pr[0], pr[1]); g.stroke();
          g.beginPath(); g.arc(pr[0], pr[1], 3.5, 0, Math.PI * 2); g.stroke();
        }
        if (s) {
          const fill = state === "dis" ? rgba(TP_OFF, 0.85) : rgba(state === "off" ? TP_BAD : TP_OK, 1);
          this._marker(s[0], s[1], 5.2, fill, state === "dis" ? "rgba(200,200,200,.85)" : "#fff", m.key ? 2.6 : 1.5);
        } else {
          this._marker(pr[0], pr[1], 3.6, "rgba(120,120,120,.75)", "rgba(185,185,185,.9)", 1.1);
        }
        boxes.add({ x: p[0] - 7, y: p[1] - 7, w: 14, h: 14 });
        const col = state === "ok" ? "#7dffa4" : state === "off" ? "#ff8a8a" : "#c4c4c4";
        const hi = isSel("tp", tp.id) || isHov("tp", tp.id);
        if (hi) this._ring(p[0], p[1], s ? 9.5 : 7.5, isSel("tp", tp.id) ? rgba(SEL, 1) : "rgba(255,255,255,.95)", 2);
        const prio = hi ? 0 : state === "off" ? 1 : state === "ok" ? 2 : 4;
        labels.push({ prio, txt: `T${tp.id}`, col, ax: p[0], ay: p[1], marker: true, strong: isSel("tp", tp.id), grey: !s });
        picks.push({ kind: "tp", id: tp.id, p, r: s ? 6 : 5, state, s, pr });
      }
    }
    this._placeLabels(labels, boxes, opt.labels, rect);
    return picks;
  }
  /**
   * Labels by priority (selected/hovered, then off, on-spot, others), each in the first free spot around its anchor.
   * "smart": a label that has no free spot is left out (its point keeps its marker; hover shows it);
   * grey points get labels only on hover. "all": every label, overlapping if it must. "off": hovered/selected only.
   */
  _placeLabels(labels, boxes, mode, rect) {
    labels.sort((a, b) => a.prio - b.prio);
    for (const L of labels) {
      const forced = L.prio === 0;
      if (mode === "off" && !forced) continue;
      if (mode === "smart" && L.grey && !forced) continue;
      const w = this._measure(L.txt), h = 15;
      const cand = L.center ? [[-w / 2, -h / 2], [-w / 2, -h - 6], [-w / 2, 6]]
        : L.marker ? [[8, -h - 2], [-w - 8, -h - 2], [8, 3], [-w - 8, 3], [10, -h / 2], [-w - 10, -h / 2]]
        : [[6, -h - 2], [6, 3], [-w - 6, -h - 2]];
      let at = null;
      for (const [dx, dy] of cand) {
        const r = { x: L.ax + dx, y: L.ay + dy, w, h };
        if (r.x < 2 || r.y < 2 || r.x + w > this.w - 2 || r.y + h > this.h - 2) continue;
        if (boxes.free(r)) { at = r; break; }
      }
      if (!at) {
        if (mode === "smart" && !forced) continue;
        at = { x: L.ax + cand[0][0], y: L.ay + cand[0][1], w, h };
      }
      boxes.add(at);
      this._pill(L.txt, at.x, at.y, L.col, L.strong || forced);
    }
  }
  /** Overview: names for surfaces / edges, the current camera, and hover / selection of track points in 3-D. */
  drawOverview(V, f, opt) {
    const { d } = V, picks = [], boxes = new Boxes(), labels = [];
    const isSel = (k, id) => opt.sel && opt.sel.kind === k && opt.sel.id === id;
    const isHov = (k, id) => opt.hov && opt.hov.kind === k && opt.hov.id === id;
    if (opt.show.tpoints) for (const t of d.tps) {
      if (t.tri || !t.Xv) continue;
      const p = V.project(t.Xv);
      if (!p) continue;
      const state = d.tpState(t, f), hi = isSel("tp", t.id) || isHov("tp", t.id);
      boxes.add({ x: p[0] - 5, y: p[1] - 5, w: 10, h: 10 });
      if (hi) {
        this._ring(p[0], p[1], 8, isSel("tp", t.id) ? rgba(SEL, 1) : "#fff", 2);
        labels.push({ prio: 0, txt: `T${t.id}`, col: "#fff", ax: p[0], ay: p[1], marker: true, strong: isSel("tp", t.id) });
      } else if (opt.labels === "all") {
        labels.push({ prio: 3, txt: `T${t.id}`, col: state === "ok" ? "#7dffa4" : state === "off" ? "#ff8a8a" : "#c4c4c4", ax: p[0], ay: p[1], marker: true });
      }
      picks.push({ kind: "tp", id: t.id, p, r: 6, state });
    }
    if (opt.show.surfaces) for (const s of V.surfList) {
      const P = s.tps.map((i) => V.project(d.tpById.get(i).Xv));
      if (P.some((p) => !p)) continue;
      const c = TRI_COL[["out", "ok", "off", "out"][s.st[d.k(f)]]], hi = isSel("surf", s.id) || isHov("surf", s.id);
      if (hi) {
        const g = this.g; g.beginPath(); g.moveTo(...P[0]); g.lineTo(...P[1]); g.lineTo(...P[2]); g.closePath();
        g.lineWidth = 2; g.strokeStyle = isSel("surf", s.id) ? rgba(SEL, 1) : "#fff"; g.stroke();
      }
      labels.push({ prio: hi ? 0 : 2, txt: s.label, col: rgba(c, 1), ax: (P[0][0] + P[1][0] + P[2][0]) / 3, ay: (P[0][1] + P[1][1] + P[2][1]) / 3, center: true });
      picks.push({ kind: "surf", id: s.id, tri: P, state: ["out", "ok", "off", "out"][s.st[d.k(f)]] });
    }
    if (opt.show.edges) for (const e of V.edgeEnds) {
      const a = V.project(e.A), b = V.project(e.B);
      if (!a || !b) continue;
      const hi = isSel("edge", e.id) || isHov("edge", e.id);
      if (hi) { const g = this.g; g.beginPath(); g.moveTo(...a); g.lineTo(...b); g.lineWidth = 2.4; g.strokeStyle = isSel("edge", e.id) ? rgba(SEL, 1) : "#fff"; g.stroke(); }
      const m = a[1] < b[1] ? a : b;
      labels.push({ prio: hi ? 0 : 2, txt: e.id, col: rgba(e.usable ? EDGE_COL.g : EDGE_COL.n, 1), ax: m[0], ay: m[1] });
      picks.push({ kind: "edge", id: e.id, seg: [a, b], state: "3d" });
    }
    const pc = V.project(new THREE.Vector3(...d.pose(f).p));
    if (pc && d.j.comparison !== 'rig') labels.push({ prio: 0, txt: `Camera · ${f}`, col: "#ffd08a", ax: pc[0], ay: pc[1], marker: true });
    this._placeLabels(labels, boxes, opt.labels === "off" ? "off" : "smart", null);
    return picks;
  }
  /** video_report._draw_health: the clip strip right under the picture, with a tick on the current frame. */
  drawHealthStrip(d, rect, f) {
    const g = this.g, hs = 5, x0 = rect.x0, x1 = rect.x0 + rect.w, sy = rect.y0 + rect.h + 7;
    g.fillStyle = "rgba(15,15,18,.72)"; roundRect(g, x0 - 2, sy - 2, x1 - x0 + 4, hs + 4, 3); g.fill();
    const R = d.j.rows, f0 = R.frames[0], f1 = R.frames[R.frames.length - 1], span = f1 - f0 + 1;
    for (let k = 0; k < R.frames.length;) {                          // one rect per run of equal quality
      let j = k;
      while (j + 1 < R.frames.length && R.quality[j + 1] === R.quality[k]) j++;
      const xa = x0 + ((R.frames[k] - f0) / span) * (x1 - x0), xb = x0 + ((R.frames[j] - f0 + 1) / span) * (x1 - x0);
      g.fillStyle = rgba(d.Q[R.quality[k]]); g.fillRect(xa, sy, Math.max(xb - xa, R.quality[k] ? 2 : 1), hs);
      k = j + 1;
    }
    if (f >= f0 && f <= f1) {
      const xc = x0 + ((f - f0 + 0.5) / span) * (x1 - x0);
      g.fillStyle = "rgba(0,0,0,.6)"; g.fillRect(xc - 2, sy - 4, 4, hs + 8);
      g.fillStyle = "#fff"; g.fillRect(xc - 1, sy - 3, 2, hs + 6);
    }
  }
}

// ═══ OrbitRig: overview navigation in a Z-up world (orbit · pan · zoom, mouse and touch) ═══════════════════════════
class OrbitRig {
  constructor(el, cam, onChange, onStart) {
    this.el = el; this.cam = cam; this.onChange = onChange; this.onStart = onStart;
    this.target = new THREE.Vector3(); this.r = 10; this.az = 0; this.el_ = 0.5; this.enabled = false;
    const P = new Map();
    let last = null, pinch = null;
    el.addEventListener("pointerdown", (e) => {
      if (!this.enabled || e.target.closest?.("button, .pip, .chip, .pop")) return;
      P.set(e.pointerId, [e.clientX, e.clientY]);
      last = { x: e.clientX, y: e.clientY, pan: e.button === 1 || e.button === 2 || e.shiftKey, moved: 0 };
      if (P.size === 2) pinch = this._pinch(P);
    });
    el.addEventListener("pointermove", (e) => {
      if (!this.enabled || !P.has(e.pointerId)) return;
      if (!el.hasPointerCapture(e.pointerId)) try { el.setPointerCapture(e.pointerId); } catch (_) { /* gone */ }
      P.set(e.pointerId, [e.clientX, e.clientY]);
      if (P.size === 2 && pinch) {
        const n = this._pinch(P);
        this.r = THREE.MathUtils.clamp(this.r * (pinch.d / n.d), 0.3, 400);
        this._pan(n.x - pinch.x, n.y - pinch.y);
        pinch = n; this.apply(); return;
      }
      const dx = e.clientX - last.x, dy = e.clientY - last.y;
      last.x = e.clientX; last.y = e.clientY; last.moved += Math.abs(dx) + Math.abs(dy);
      if (last.moved > 3) this.onStart();
      if (last.pan) this._pan(dx, dy);
      else { this.az -= dx * 0.008; this.el_ = THREE.MathUtils.clamp(this.el_ + dy * 0.008, -1.45, 1.45); }
      this.apply();
    });
    const up = (e) => { P.delete(e.pointerId); if (P.size < 2) pinch = null; };
    el.addEventListener("pointerup", up); el.addEventListener("pointercancel", up);
    el.addEventListener("contextmenu", (e) => this.enabled && e.preventDefault());
    el.addEventListener("wheel", (e) => {
      if (!this.enabled) return;
      e.preventDefault(); this.onStart();
      this.r = THREE.MathUtils.clamp(this.r * Math.exp(e.deltaY * 0.0012), 0.3, 400); this.apply();
    }, { passive: false });
  }
  _pinch(P) { const [a, b] = [...P.values()]; return { d: Math.hypot(a[0] - b[0], a[1] - b[1]) || 1, x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2 }; }
  _pan(dx, dy) {
    const h = this.el.clientHeight || 1, s = (2 * this.r * Math.tan(THREE.MathUtils.degToRad(this.cam.fov / 2))) / h;
    const right = new THREE.Vector3().setFromMatrixColumn(this.cam.matrixWorld, 0);
    const upv = new THREE.Vector3().setFromMatrixColumn(this.cam.matrixWorld, 1);
    this.target.addScaledVector(right, -dx * s).addScaledVector(upv, dy * s);
  }
  pose() {
    const c = Math.cos(this.el_);
    const pos = new THREE.Vector3(Math.cos(this.az) * c, Math.sin(this.az) * c, Math.sin(this.el_)).multiplyScalar(this.r).add(this.target);
    const m = new THREE.Matrix4().lookAt(pos, this.target, new THREE.Vector3(0, 0, 1));
    return { pos, quat: new THREE.Quaternion().setFromRotationMatrix(m) };
  }
  apply() {
    const { pos, quat } = this.pose();
    this.cam.position.copy(pos); this.cam.quaternion.copy(quat); this.cam.fov = 38; this.cam.updateProjectionMatrix(); this.cam.updateMatrixWorld();
    this.onChange();
  }
}

// ═══ Scene3D: Three.js scene — Blender meshes, tracking data in 3-D, camera path and frustums ═════════════════════
class Scene3D {
  constructor(canvas, d) {
    this.d = d;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "low-power" });
    this.renderer.setClearColor(0x000000, 0);
    this.scene = new THREE.Scene();
    this.camCam = new THREE.PerspectiveCamera(40, 1, 0.02, 2000);   // the tracked camera (camera view)
    this.ovCam = new THREE.PerspectiveCamera(38, 1, 0.05, 3000);    // the overview camera
    this.g = { meshes: new THREE.Group(), axes: new THREE.Group(), grid: new THREE.Group(), track: new THREE.Group(),
      tp: new THREE.Group(), surf: new THREE.Group(), edges: new THREE.Group(), path: new THREE.Group(),
      keys: new THREE.Group(), cam: new THREE.Group(), cloud: new THREE.Group(), cube: new THREE.Group() };
    Object.values(this.g).forEach((o) => this.scene.add(o));
    this.g.track.add(this.g.tp, this.g.surf, this.g.edges);
    this.animatedMeshes = [];
    this._meshes(); this._grid(); this._trackingObjects(); this._path(); this._cloud(); this._cube();
    if (d.j.rawCamera) {
      const raw = d.j.rawCamera, fixed = d.cam;
      const start = new THREE.Vector3().fromArray(raw.pos);
      const origin = new THREE.Vector3().fromArray(fixed.pos);
      const rotation = new THREE.Quaternion().fromArray(fixed.quat)
        .multiply(new THREE.Quaternion().fromArray(raw.quat).invert());
      const path = [], sample = new THREE.Vector3();
      let rawEnergy = 0, fixedEnergy = 0;
      for (let i = 0; i < Math.min(raw.pos.length, fixed.pos.length); i += 3) {
        const point = new THREE.Vector3().fromArray(raw.pos, i).sub(start);
        rawEnergy += point.lengthSq();
        fixedEnergy += sample.fromArray(fixed.pos, i).distanceToSquared(origin);
        path.push(point.applyQuaternion(rotation));
      }
      const scale = rawEnergy ? Math.sqrt(fixedEnergy / rawEnergy) : 1;
      for (const point of path) point.multiplyScalar(scale).add(origin);
      this.g.path.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(path), this._mat(0x42dbd1, 1)));
    }
    if (d.j.platform && d.j.variant !== "cabin") {
      const positions = d.j.platform.pos;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      this.g.path.add(new THREE.Line(g, this._mat(0x48dfd0, .85)));
      this.platformMarker = new THREE.Group();
      this.platformMarker.add(new THREE.AxesHelper(.4));
      this.g.path.add(this.platformMarker);
    }
    if (d.j.skeletons) this._humanRigs();
    this.vis = {};
  }
  _humanRigs() {
    const scene = this.d.j;
    if (scene.handTracks) {
      // Each saved frame contains a wrist followed by four joints per digit.
      const links = [];
      for (let first = 1; first < 21; first += 4) links.push(0,first,first,first+1,first+1,first+2,first+2,first+3);
      this.rigs = scene.skeletons.map(rig => {
        const frames = new Float32Array(Uint8Array.from(atob(rig.motion), c => c.charCodeAt(0)).buffer);
        if (frames.length !== this.d.n * 63) throw new Error('Invalid hand track length.');
        const geometry = new THREE.BufferGeometry();
        const position = new THREE.Float32BufferAttribute(new Float32Array(63),3);
        position.setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute('position',position);
        geometry.setIndex(links);
        const body = new THREE.LineSegments(geometry,new THREE.LineBasicMaterial({color:rig.color}));
        const dots = new THREE.BufferGeometry();
        dots.setAttribute('position',position);
        const joints = new THREE.Points(dots,new THREE.PointsMaterial({color:rig.color,size:4,sizeAttenuation:false}));
        joints.frustumCulled = body.frustumCulled = false;
        body.add(joints);
        this.scene.add(body);
        return {body,rig,update:frame => {
          position.array.set(frames.subarray(frame*63,(frame+1)*63));
          position.needsUpdate = true;
          body.material.color.set(rig.state[frame] === 2 ? 0xa9aaab : rig.color);
          joints.material.color.copy(body.material.color);
        }};
      });
      return;
    }
    const display = scene.poseDisplay || scene.bodyTemplate;
    const template = window.PerspectraBodies[scene.poseDisplayTemplate || (display === 'mixamo' && scene.poseDisplay ? 'ybot' : display)];
    const geometry = template.segments ? new THREE.OctahedronGeometry(1) : new THREE.BufferGeometry();
    if (!template.segments) {
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(template.position, 3));
      geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(template.skinIndex, 4));
      geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(template.skinWeight, 4));
      geometry.setIndex(template.index);
      for (const group of template.groups || []) geometry.addGroup(...group);
      geometry.computeVertexNormals();
      const sky = new THREE.HemisphereLight(0xfff8ed, 0x68697c, 1.6);
      sky.position.set(0, 0, 1);
      const key = new THREE.DirectionalLight(0xfff4df, 2.1);
      key.position.set(-3, -4, 6);
      this.scene.add(sky, key);
    }
    this.rigs = scene.skeletons.map((rig, index) => {
      const bytes = Uint8Array.from(atob(rig.motion), ch => ch.charCodeAt(0));
      const frames = new Float32Array(bytes.buffer);
      const jointCount = template.jointCount ?? template.heads.length;
      if (frames.length !== this.d.n * jointCount * 7) throw new Error('Motion and rig joint counts differ.');
      const offsets = template.bindings?.map(binding => new THREE.Vector3().fromArray(binding, 2));
      const shell = index === 0 ? 0x1786aa : 0xe8a440;
      let body, update;
      if (template.segments) {
        body = new THREE.InstancedMesh(geometry, new THREE.MeshBasicMaterial({color:rig.color}), template.segments.length);
        body.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        const axis = new THREE.Vector3(0,1,0), direction = new THREE.Vector3();
        const rotation = new THREE.Quaternion(), transform = new THREE.Object3D();
        update = base => {
          template.segments.forEach(([joint,x,y,z], i) => {
            const at = base + joint * 7;
            rotation.fromArray(frames, at + 3);
            direction.set(x,y,z).multiplyScalar(rig.scale).applyQuaternion(rotation);
            transform.position.fromArray(frames, at).addScaledVector(direction, .5);
            const length = direction.length(), width = Math.min(.024, length * .13);
            transform.scale.set(width, length / 2, width);
            transform.quaternion.setFromUnitVectors(axis, direction.normalize());
            transform.updateMatrix();
            body.setMatrixAt(i, transform.matrix);
          });
          body.instanceMatrix.needsUpdate = true;
        };
      } else {
        const material = template.groups
          ? [new THREE.MeshStandardMaterial({color:shell, metalness:.28, roughness:.4}),
             new THREE.MeshStandardMaterial({color:0x263139, metalness:.18, roughness:.58})]
          : new THREE.MeshStandardMaterial({color:rig.color, roughness:.83});
        body = new THREE.SkinnedMesh(geometry, material);
        const bones = template.heads.map(() => new THREE.Bone());
        const inverses = template.heads.map(([x,y,z]) => new THREE.Matrix4().makeTranslation(-x,-y,-z));
        for (const bone of bones) { bone.scale.setScalar(rig.scale); body.add(bone); }
        body.bind(new THREE.Skeleton(bones, inverses), new THREE.Matrix4());
        const correction = new THREE.Vector3();
        update = base => {
          for (let i = 0; i < bones.length; i++) {
            const binding = template.bindings?.[i];
            const at = base + (binding ? binding[0] : i) * 7;
            const bone = bones[i];
            bone.position.fromArray(frames, at);
            bone.quaternion.fromArray(frames, at + 3);
            if (binding && binding[1] >= 0) {
              // Carry the parent's rest-proportion correction through the chain.
              const parentIndex = binding[1], parent = bones[parentIndex];
              correction.fromArray(frames, base + 7 * template.bindings[parentIndex][0]);
              bone.position.add(parent.position).sub(correction);
              correction.copy(offsets[i]).applyQuaternion(parent.quaternion);
              bone.position.addScaledVector(correction, rig.scale);
            }
          }
        };
      }
      body.frustumCulled = false;
      this.scene.add(body);
      return {body, rig, update:frame => update(frame * jointCount * 7)};
    });
  }
  _mat(color, opacity = 1, extra = {}) {
    return new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity, depthWrite: opacity >= 1, ...extra });
  }
  _meshes() {
    for (const m of this.d.j.meshes) {
      const wire = new THREE.BufferGeometry();
      wire.setAttribute("position", new THREE.Float32BufferAttribute(m.edges.flatMap(([a, b]) => [...m.verts[a], ...m.verts[b]]), 3));
      const isFloor = m.kind === "floor";
      const lines = new THREE.LineSegments(wire, this._mat(isFloor ? 0xb9bec6 : 0xe6e9ee, isFloor ? 0.45 : 0.85));
      lines.userData.kind = m.kind;
      const fg = new THREE.BufferGeometry();
      fg.setAttribute("position", new THREE.Float32BufferAttribute(m.verts.flat(), 3));
      fg.setIndex(m.tris.flat());
      const fill = new THREE.Mesh(fg, new THREE.MeshBasicMaterial({ color: isFloor ? 0x8c95a3 : 0x9bb4d6, transparent: true,
        opacity: isFloor ? 0.05 : 0.14, side: THREE.DoubleSide, depthWrite: false }));
      fill.userData.overviewOnly = true; fill.userData.kind = m.kind;                       // WIRE display in Blender: faces only in the overview
      if (m.matrices) {
        for (const object of [lines, fill]) {
          object.matrixAutoUpdate = false;
          object.matrix.fromArray(m.matrices);
          if (m.matrices.length > 16) this.animatedMeshes.push({object, matrices:m.matrices});
        }
        if (!isFloor) {
          lines.material.color.set(0x58efbf);
          fill.userData.overviewOnly = false;
          fill.material.color.set(0x299d87);
          fill.material.polygonOffset = true;
          fill.material.polygonOffsetFactor = 1;
          fill.material.polygonOffsetUnits = 1;
          fill.material.depthWrite = true;
          fill.renderOrder = -1;
        }
      }
      this.g.meshes.add(lines, fill);
    }
  }
  _grid() {
    const P = [], C = [], N = 40, step = 0.5;
    for (let i = -N; i <= N; i++) {
      if (i === 0) continue;
      const a = i % 2 === 0 ? 0.075 : 0.035;
      P.push(i * step, -N * step, 0, i * step, N * step, 0, -N * step, i * step, 0, N * step, i * step, 0);
      for (let k = 0; k < 4; k++) C.push(1, 1, 1, a);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.Float32BufferAttribute(P, 3));
    geo.setAttribute("color", new THREE.Float32BufferAttribute(C, 4));
    this.g.grid.add(new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false })));
    const ax = (a, b, c) => new THREE.Line(new THREE.BufferGeometry().setFromPoints([a, b]), this._mat(c, 0.55));
    const L = N * step;
    this.g.axes.add(ax(new THREE.Vector3(-L, 0, 0), new THREE.Vector3(L, 0, 0), AX_X), ax(new THREE.Vector3(0, -L, 0), new THREE.Vector3(0, L, 0), AX_Y));
  }
  _trackingObjects() {
    const d = this.d;
    this.tpList = d.tps.filter((t) => t.Xv && !t.tri);
    // scene extent: the camera's travel plus the tracked points near it (far background points don't set the zoom)
    const box = new THREE.Box3();
    for (let k = 0; k < d.n; k++) box.expandByPoint(new THREE.Vector3(...d.pose(d.fs + k).p));
    const mid = box.getCenter(new THREE.Vector3()), reach = box.getSize(new THREE.Vector3()).length() + 4;
    this.tpList.forEach((t) => { if (t.Xv.distanceTo(mid) < reach) box.expandByPoint(t.Xv); });
    if (d.j.variant === 'cabin') {
      for (const f of [d.fs, Math.round((d.fs + d.fe)/2), d.fe]) {
        const lines = frustumLines(d, f, 1);
        for (let i=0; i<lines.length; i+=3) box.expandByPoint(new THREE.Vector3().fromArray(lines, i));
      }
    } else box.min.z = Math.min(box.min.z, 0);
    if (d.j.primitivePreview) {
      const transform = new THREE.Matrix4(), placed = new THREE.Box3();
      for (const mesh of d.j.meshes) {
        const local = new THREE.Box3().setFromPoints(mesh.verts.map(v => new THREE.Vector3(...v)));
        for (let offset = 0; offset < mesh.matrices.length; offset += 16) {
          transform.fromArray(mesh.matrices, offset);
          box.union(placed.copy(local).applyMatrix4(transform));
        }
      }
    } else if (d.j.overviewBounds) { box.min.set(...d.j.overviewBounds.min); box.max.set(...d.j.overviewBounds.max); }
    this.bounds = box;
    const pos = new Float32Array(this.tpList.length * 3);
    this.tpList.forEach((t, i) => pos.set(t.X, 3 * i));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(this.tpList.length * 3), 3));
    this.tpPoints = new THREE.Points(geo, new THREE.PointsMaterial({ size: 8, sizeAttenuation: false, vertexColors: true,
      map: discTexture(), alphaTest: 0.5, transparent: true }));
    this.tpPoints.renderOrder = 3;
    const rg = new THREE.BufferGeometry();
    rg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(this.tpList.length * 6), 3));
    this.rays = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: 0x33ff73, transparent: true, opacity: 0.12, depthWrite: false }));
    this.g.tp.add(this.tpPoints, this.rays);
    this.surfList = d.surfaces.filter((s) => s.tps.every((i) => d.tpById.get(i)?.Xv));
    const sp = [], ep = [];
    for (const s of this.surfList) {
      const X = s.tps.map((i) => d.tpById.get(i).X);
      sp.push(...X[0], ...X[1], ...X[2]);
      ep.push(...X[0], ...X[1], ...X[1], ...X[2], ...X[2], ...X[0]);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute("position", new THREE.Float32BufferAttribute(sp, 3));
    sg.setAttribute("color", new THREE.BufferAttribute(new Float32Array(sp.length), 3));
    this.surfMesh = new THREE.Mesh(sg, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false }));
    const eg = new THREE.BufferGeometry();
    eg.setAttribute("position", new THREE.Float32BufferAttribute(ep, 3));
    eg.setAttribute("color", new THREE.BufferAttribute(new Float32Array(ep.length), 3));
    this.surfLines = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85 }));
    this.g.surf.add(this.surfMesh, this.surfLines);
    // edges: each one's 3-D line, cut to the scene's extent (the overlay's line is ±6 m)
    this.edgeList = d.edges.filter((e) => e.X0);
    this.edgeEnds = [];
    const lp = [], clip = box.clone().expandByScalar(0.25);
    clip.min.z = Math.max(clip.min.z, -0.02);
    for (const e of this.edgeList) {
      const s = e.line.span;
      const ray = new THREE.Ray(e.X0.clone().addScaledVector(e.d, -s), e.d.clone());
      const back = new THREE.Ray(e.X0.clone().addScaledVector(e.d, s), e.d.clone().negate());
      const a = ray.intersectBox(clip, new THREE.Vector3()), b = back.intersectBox(clip, new THREE.Vector3());
      const A = a && a.distanceTo(e.X0) <= s + 1e-6 ? a : ray.origin, B = b && b.distanceTo(e.X0) <= s + 1e-6 ? b : back.origin;
      lp.push(...A.toArray(), ...B.toArray());
      this.edgeEnds.push({ id: e.id, A, B, usable: e.line.usable });
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute("position", new THREE.Float32BufferAttribute(lp, 3));
    lg.setAttribute("color", new THREE.BufferAttribute(new Float32Array(lp.length), 3));
    this.edgeLines = new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.75 }));
    this.g.edges.add(this.edgeLines);
  }
  _path() {
    const d = this.d, c = d.cam, first = Math.max(d.fs, d.playback.fs), last = Math.min(d.fe, d.playback.fe), n = last - first + 1;
    const P = new Float32Array(n * 3), C = new Float32Array(n * 3);
    for (let k = 0; k < n; k++) {
      const source = d.k(first + k);
      P.set(c.pos.slice(3 * source, 3 * source + 3), 3 * k);
      const q = d.qFrame[source];
      C.set((d.j.traceColor || (q >= 0 ? d.Q[q].slice(0, 3) : [0.5, 0.5, 0.5])).map(srgbToLinear), 3 * k);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(P, 3));
    g.setAttribute("color", new THREE.BufferAttribute(C, 3));
    this.pathLine = new THREE.Line(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: d.j.traceColor ? 1 : 0.7 }));
    this.g.path.add(this.pathLine);
    const box = this.bounds;
    this.fr = d.j.comparison === 'rig' ? 1 : THREE.MathUtils.clamp(box.getSize(new THREE.Vector3()).length() * 0.025, 0.1, 0.6);   // frustum depth
    if (d.j.primitivePreview) {
      const point = new THREE.Vector3();
      for (let f = d.fs; f <= d.fe; f++) {
        const lines = frustumLines(d, f, this.fr);
        for (let i = 0; i < lines.length; i += 3) box.expandByPoint(point.fromArray(lines, i));
      }
    }
    // the solve's keyframes: small dots on the path (always) and thin frustums (optional)
    const keys = [...new Set(d.j.rows.solveKeys)].filter((f) => f >= first && f <= last).sort((a, b) => a - b);
    const kd = [], kp = [];
    let lastP = null;
    for (const f of keys) {
      const p = new THREE.Vector3(...d.pose(f).p);
      kd.push(p.x, p.y, p.z);
      if (lastP && p.distanceTo(lastP) < this.fr * 0.9) continue;
      lastP = p;
      kp.push(...frustumLines(d, f, this.fr * 0.45));
    }
    const dg = new THREE.BufferGeometry(); dg.setAttribute("position", new THREE.Float32BufferAttribute(kd, 3));
    const keyMaterial = new THREE.PointsMaterial({ size: d.j.traceColor ? 3 : 4.5, sizeAttenuation: false, color: 0xffffff, map: discTexture(), alphaTest: 0.5, transparent: true, opacity: 0.9 });
    if (d.j.traceColor) keyMaterial.color.setRGB(...d.j.traceColor.map(srgbToLinear));
    this.g.path.add(new THREE.Points(dg, keyMaterial));
    const kg = new THREE.BufferGeometry(); kg.setAttribute("position", new THREE.Float32BufferAttribute(kp, 3));
    this.g.keys.add(new THREE.LineSegments(kg, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, depthWrite: false })));
    // the active camera: frustum, filled up-triangle, the footage on its picture plane, a dot on the path
    const cg = new THREE.BufferGeometry();
    cg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(16 * 3 + 6 * 3), 3));
    this.camLines = new THREE.LineSegments(cg, new THREE.LineBasicMaterial({ color: 0xffa028 }));
    this.camPlane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0.95, depthWrite: false }));
    const tg = new THREE.BufferGeometry(); tg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(9), 3));
    this.camTri = new THREE.Mesh(tg, new THREE.MeshBasicMaterial({ color: 0xffa028, side: THREE.DoubleSide }));
    const dotg = new THREE.BufferGeometry(); dotg.setAttribute("position", new THREE.BufferAttribute(new Float32Array(3), 3));
    this.camDot = new THREE.Points(dotg, new THREE.PointsMaterial({ size: 9, sizeAttenuation: false, color: 0xffa028, map: discTexture(), alphaTest: 0.5, transparent: true }));
    this.camDot.renderOrder = 4;
    this.g.cam.add(this.camLines, this.camPlane, this.camTri, this.camDot);
    if (d.j.traceColor) for (const obj of [this.camLines, this.camTri, this.camDot]) obj.material.color.setRGB(...d.j.traceColor.map(srgbToLinear));
  }
  _cloud() {
    const c = this.d.j.cloud;
    if (!c || !c.xyz.length) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(c.xyz, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(c.rgb.map((v) => srgbToLinear(v / 255)), 3));
    if (c.overviewIds) g.setIndex(c.overviewIds);
    this.photoCloud = new THREE.Points(g, new THREE.PointsMaterial({size:2.2, sizeAttenuation:false, vertexColors:true}));
    this.g.cloud.add(this.photoCloud);
    if (this.d.j.preset || this.d.j.show?.cameraCloud) {
      let cameraGeometry = g;
      if (c.spans) {
        cameraGeometry = new THREE.BufferGeometry();
        cameraGeometry.setAttribute("position", g.getAttribute("position"));
        const count = c.xyz.length / 3;
        const supported = c.overviewIds ? new Set(c.overviewIds) : null;
        const index = count > 65535 ? new Uint32Array(count) : new Uint16Array(count);
        cameraGeometry.setIndex(new THREE.BufferAttribute(index, 1));
        cameraGeometry.setDrawRange(0, 0);
        const platform = this.d.j.platform;
        const transform = new THREE.Matrix4();
        const pos = new THREE.Vector3(), rot = new THREE.Quaternion(), unit = new THREE.Vector3(1, 1, 1);
        const point = new THREE.Vector3();
        const cabinView = this.d.j.variant === "cabin";
        if (c.platformCount !== undefined) {
          // Both views use the same measurements. Only their reference frame changes.
          this.photoCloud.geometry = cameraGeometry;
          cameraGeometry.setAttribute("color", g.getAttribute("color"));
          this.photoCloud.frustumCulled = false;
        }
        this.updateCloud = frame => {
          if (c.platformCount !== undefined) {
            const k = this.d.k(frame);
            transform.compose(pos.fromArray(platform.pos, 3*k), rot.fromArray(platform.quat, 4*k), unit);
            if (cabinView) transform.invert();
            const positions = cameraGeometry.getAttribute("position");
            const first = cabinView ? c.platformCount : 0;
            const end = cabinView ? count : c.platformCount;
            for (let id = first; id < end; id++) {
              point.fromArray(c.xyz, 3*id).applyMatrix4(transform);
              positions.setXYZ(id, point.x, point.y, point.z);
            }
            positions.needsUpdate = true;
          }
          let n = 0;
          for (let i = 0; i < c.spans.length; i += 3) {
            if (c.spans[i+1] <= frame && frame <= c.spans[i+2] && (!supported || supported.has(c.spans[i]))) index[n++] = c.spans[i];
          }
          cameraGeometry.index.needsUpdate = true;
          cameraGeometry.setDrawRange(0, n);
        };
      }
      this.orangeCloud = new THREE.Points(cameraGeometry, new THREE.PointsMaterial({size:4.5, sizeAttenuation:false, color:0xffad32, map:discTexture(), alphaTest:.4, transparent:true}));
      if (c.platformCount !== undefined) {
        this.orangeCloud.frustumCulled = false;
        this.orangeCloud.material.vertexColors = true;
        this.orangeCloud.material.color.setHex(0xffffff);
      }
      this.g.cloud.add(this.orangeCloud);
    }
  }
  /** The test cube: flat-shaded faces (no lights) so it reads as a solid on the footage, dark edges. */
  _cube() {
    const geo = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
    const shade = [0.78, 0.62, 0.70, 0.56, 0.95, 0.42];            // +x −x +y −y +z(top) −z
    const col = [];
    for (let f = 0; f < 6; f++) for (let v = 0; v < 6; v++) { const c = srgbToLinear(shade[f]); col.push(c * 1.0, c * 0.86, c * 0.62); }
    geo.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    const solid = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.88 }));
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: 0x1a1206 }));
    solid.renderOrder = 2; edges.renderOrder = 3;
    this.g.cube.add(solid, edges);
    this.g.cube.matrixAutoUpdate = false;
    this.g.cube.visible = false;
  }
  /** video_track._cube_matrix: bottom corner on ``corner``, standing on ``up``, edges along ax0 and up×ax0, turned by rot. */
  setCube(c) {
    if (!c) { this.g.cube.visible = false; return; }
    const up = c.up.clone().normalize();
    let ax = c.ax0.clone().addScaledVector(up, -c.ax0.dot(up)).normalize();
    ax.applyAxisAngle(up, c.rot);
    const ay = up.clone().cross(ax).normalize();
    const centre = c.corner.clone().addScaledVector(ax.clone().add(ay).add(up), c.size / 2);
    this.g.cube.matrix.makeBasis(ax.multiplyScalar(c.size), ay.multiplyScalar(c.size), up.clone().multiplyScalar(c.size)).setPosition(centre);
    this.g.cube.matrixWorldNeedsUpdate = true;
    this.g.cube.visible = true;
  }
  /** Where a click lands in the scene: the nearest of the floor (Z = 0), the blockout and the tracked surfaces. */
  raycast(ndc, cam) {
    const rc = new THREE.Raycaster();
    rc.setFromCamera(ndc, cam);
    if (cam.isPerspectiveCamera && cam === this.camCam) {           // camera view: custom off-centre projection
      rc.ray.origin.setFromMatrixPosition(cam.matrixWorld);
      rc.ray.direction.set(ndc.x, ndc.y, 0.5).unproject(cam).sub(rc.ray.origin).normalize();
    }
    const hits = [];
    const targets = [...this.g.meshes.children.filter((o) => o.isMesh && o.userData.overviewOnly), this.surfMesh];
    for (const h of rc.intersectObjects(targets, false)) {
      const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : null;
      hits.push({ p: h.point, n, t: h.distance, what: h.object === this.surfMesh ? "tracked surface" : h.object.userData.kind === "floor" ? "floor" : "blockout" });
    }
    const placement = this.d.j.placement;
    for (const vertices of placement?.treads || []) {
      const [a,b,c,d] = vertices.map(v => new THREE.Vector3(...v));
      const p = rc.ray.intersectTriangle(a,b,c,false,new THREE.Vector3()) ||
                rc.ray.intersectTriangle(a,c,d,false,new THREE.Vector3());
      if (p) hits.push({p, t:p.distanceTo(rc.ray.origin), what:'stair tread', tread:[a,b,d]});
    }
    const fl = rc.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -(placement?.floorZ || 0)), new THREE.Vector3());
    if (fl) hits.push({ p: fl, n: new THREE.Vector3(0, 0, 1), t: fl.distanceTo(rc.ray.origin), what: "floor" });
    hits.sort((a, b) => a.t - b.t);
    return hits[0] || null;
  }
  setVideoTexture(video) {
    // Local files can play in a video element while their pixels cannot be uploaded to WebGL.
    if (video.src.startsWith('file:')) {
      this.localFilm = true;
      this.camPlane.material.visible = false;
      return;
    }
    this.vtex = new THREE.VideoTexture(video);
    this.vtex.colorSpace = THREE.SRGBColorSpace;
    this.camPlane.material.map = this.vtex; this.camPlane.material.needsUpdate = true;
  }
  /** Per-frame state: the tracked camera, colours of points / surfaces / edges, the active camera. */
  update(f, sel) {
    const d = this.d, k = d.k(f), { p, q, lens } = d.pose(f);
    if (this.updateCloud && this.cloudFrame !== f) {
      this.updateCloud(f);
      this.cloudFrame = f;
    }
    for (const {object, matrices} of this.animatedMeshes) {
      object.matrix.fromArray(matrices, k * 16);
      object.matrixWorldNeedsUpdate = true;
    }
    if (this.rigs && this.poseFrame !== k) {
      this.poseFrame = k;
      for (const {rig, update} of this.rigs) {
        if (rig.visible[k]) update(k);
      }
    }
    if (this.platformMarker) {
      this.platformMarker.position.fromArray(d.j.platform.pos, 3*k);
      this.platformMarker.quaternion.fromArray(d.j.platform.quat, 4*k);
    }
    this.camCam.position.set(...p); this.camCam.quaternion.set(...q); this.camCam.updateMatrixWorld();
    this.lens = lens;
    const col = this.tpPoints.geometry.attributes.color, rays = this.rays.geometry.attributes.position;
    let nr = 0;
    this.tpList.forEach((t, i) => {
      const tracked = !Number.isNaN(t.xy[2 * k]);
      const isSel = sel && sel.kind === "tp" && sel.id === t.id;
      const c = isSel ? SEL : !t.on ? [0.33, 0.33, 0.33] : !tracked ? [0.5, 0.5, 0.5] : d.tpBad(t, f) ? TP_BAD : TP_OK;
      col.setXYZ(i, ...c.map(srgbToLinear));
      if (tracked && t.on) { rays.setXYZ(nr++, ...p); rays.setXYZ(nr++, ...t.X); }
    });
    col.needsUpdate = true; rays.needsUpdate = true; this.rays.geometry.setDrawRange(0, nr);
    const sc = this.surfMesh.geometry.attributes.color, lc = this.surfLines.geometry.attributes.color;
    this.surfList.forEach((s, i) => {
      const c = TRI_COL[["out", "ok", "off", "out"][s.st[k]]].map(srgbToLinear);
      for (let j = 0; j < 3; j++) sc.setXYZ(3 * i + j, ...c);
      for (let j = 0; j < 6; j++) lc.setXYZ(6 * i + j, ...c);
    });
    sc.needsUpdate = true; lc.needsUpdate = true;
    const ec = this.edgeLines.geometry.attributes.color;
    this.edgeList.forEach((e, i) => {
      const s = e.seg[k];
      const c = (!e.line.usable ? [0.45, 0.45, 0.45] : s ? EDGE_COL[s[4]] : EDGE_COL.n).map(srgbToLinear);
      ec.setXYZ(2 * i, ...c); ec.setXYZ(2 * i + 1, ...c);
    });
    ec.needsUpdate = true;
    const L = frustumLines(d, f, this.fr);
    this.camLines.geometry.attributes.position.array.set(L); this.camLines.geometry.attributes.position.needsUpdate = true;
    this.camLines.geometry.computeBoundingSphere();
    this.camTri.geometry.attributes.position.array.set(L.slice(L.length - 18, L.length - 15).concat(L.slice(L.length - 12, L.length - 9), L.slice(L.length - 6, L.length - 3)));
    this.camTri.geometry.attributes.position.needsUpdate = true; this.camTri.geometry.computeBoundingSphere();
    this.camDot.geometry.attributes.position.array.set(p); this.camDot.geometry.attributes.position.needsUpdate = true;
    this.camDot.geometry.computeBoundingSphere();
    const tz = this.fr, hw = tz * d.hfovTan(lens), hh = hw * d.H / d.W;
    this.camPlane.position.set(...p); this.camPlane.quaternion.set(...q);
    this.camPlane.translateZ(-tz * 0.999); this.camPlane.scale.set(2 * hw, 2 * hh, 1);
  }
  /** What is drawn in 3-D for this mode and these toggles (camera view: wireframes and axes only). */
  apply(mode, v) {
    const ov = mode !== "camera", g = this.g;
    g.grid.visible = ov && v.grid; g.axes.visible = v.grid;
    g.path.visible = ov && v.path; g.keys.visible = ov && v.keys; g.cam.visible = ov;
    g.track.visible = ov && v.track;
    g.tp.visible = !!v.tpoints; g.surf.visible = !!v.surfaces; g.edges.visible = !!v.edges;
    g.cloud.visible = (ov || !!this.d.j.preset || !!this.d.j.show?.cameraCloud) && v.cloud && v.track;
    if (this.orangeCloud) { this.photoCloud.visible = ov; this.orangeCloud.visible = !ov; }
    if (this.rigs) for (const {body, rig} of this.rigs) body.visible = v.track && rig.visible[this.poseFrame];
    g.meshes.visible = v.geometry;
    g.meshes.children.forEach((o) => {
      if (o.userData.overviewOnly) o.visible = ov;
      if (o.userData.kind === "block") o.material.color.set(ov ? 0xe6e9ee : 0x141414);   // Blender's black wire on the footage
    });
    g.axes.children.forEach((o) => { o.material.opacity = ov ? 0.55 : 0.35; });
    g.cube.visible = !!v.cube;
  }
  render(cam) { this.renderer.render(this.scene, cam); }
}

// Apply the result's own division-model lens correction to the shared source proxy.
// Each preset keeps its actual kappa; the camera and scene geometry are never adjusted to hide drift.
class RectifiedFootage {
  constructor(video, data, stage) {
    this.canvas = document.createElement('canvas'); this.canvas.className = 'rectified-video';
    this.canvas.style.cssText = 'position:absolute;pointer-events:none;z-index:0'; stage.prepend(this.canvas);
    this.renderer = new THREE.WebGLRenderer({ canvas:this.canvas, alpha:false, powerPreference:'low-power' });
    const scale = Math.min(1, 960 / Math.max(data.W,data.H));
    this.renderer.setSize(Math.round(data.W*scale),Math.round(data.H*scale),false);
    this.texture = new THREE.VideoTexture(video); this.scene = new THREE.Scene(); this.camera = new THREE.Camera();
    this.material = new THREE.ShaderMaterial({uniforms:{footage:{value:this.texture},kappa:{value:data.j.kappa},aspect:{value:data.H/data.W}},
      vertexShader:'varying vec2 uvOut; void main(){uvOut=uv;gl_Position=vec4(position.xy,0.0,1.0);}',
      fragmentShader:'uniform sampler2D footage;uniform float kappa;uniform float aspect;varying vec2 uvOut;void main(){vec2 u=(uvOut-.5)*vec2(1.,aspect);float disc=1.-4.*kappa*dot(u,u);vec2 d=u*2./(1.+sqrt(max(0.,disc)));vec2 source=d/vec2(1.,aspect)+.5;if(disc<0.||any(lessThan(source,vec2(0.)))||any(greaterThan(source,vec2(1.))))gl_FragColor=vec4(0.,0.,0.,1.);else gl_FragColor=texture2D(footage,source);}'});
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2,2),this.material);this.scene.add(this.mesh);
  }
  render(){this.renderer.render(this.scene,this.camera);}
  dispose(){this.texture.dispose();this.mesh.geometry.dispose();this.material.dispose();this.renderer.dispose();this.renderer.forceContextLoss();this.canvas.remove();}
}

function frustumLines(d, f, depth) {
  const { p, q, lens } = d.pose(f);
  const Q = new THREE.Quaternion(...q), O = new THREE.Vector3(...p);
  const hw = depth * d.hfovTan(lens), hh = hw * d.H / d.W;
  const c = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => new THREE.Vector3(x, y, -depth).applyQuaternion(Q).add(O));
  const up = [[-hw * 0.5, hh * 1.1], [hw * 0.5, hh * 1.1], [0, hh * 1.55]].map(([x, y]) => new THREE.Vector3(x, y, -depth).applyQuaternion(Q).add(O));
  const out = [];
  const seg = (a, b) => out.push(a.x, a.y, a.z, b.x, b.y, b.z);
  for (let i = 0; i < 4; i++) { seg(O, c[i]); seg(c[i], c[(i + 1) % 4]); }
  seg(up[0], up[1]); seg(up[1], up[2]); seg(up[2], up[0]);
  return out;
}
let _disc = null;
function discTexture() {
  if (_disc) return _disc;
  const c = document.createElement("canvas"); c.width = c.height = 64;
  const g = c.getContext("2d");
  g.beginPath(); g.arc(32, 32, 26, 0, Math.PI * 2); g.fillStyle = "#fff"; g.fill();
  g.lineWidth = 8; g.strokeStyle = "#222"; g.stroke();
  _disc = new THREE.CanvasTexture(c); _disc.colorSpace = THREE.SRGBColorSpace; return _disc;
}
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
function roundRect(g, x, y, w, h, r) { g.beginPath(); if (g.roundRect) g.roundRect(x, y, w, h, r); else g.rect(x, y, w, h); }

// ═══ Timeline: Blender-style ruler, spot markers, error graph, health stripe, lanes, playhead ════════════════════
class Timeline {
  constructor(canvas, d, onScrub) {
    this.c = canvas; this.g = canvas.getContext("2d"); this.d = d; this.onScrub = onScrub;
    this.lanes = false; this.frame = d.fs; this.hoverF = null;
    // Plot recorded pixel errors directly. Legacy normalized curves cannot be
    // labeled with fixed pixel thresholds (automatic exports use a log scale).
    const rows = d.j.rows, errors = rows.err || [];
    this.hasPixelErrors = errors.length === rows.frames.length && errors.some(v => Number.isFinite(v) && v >= 0);
    this.errorMax = this.hasPixelErrors ? Math.max(1, Math.ceil(errors.reduce((m,v) => Number.isFinite(v) ? Math.max(m,v) : m,0) * 2) / 2) : 1;
    this.curve = this.hasPixelErrors ? errors.map(v => Number.isFinite(v) && v >= 0 ? v / this.errorMax : null) : rows.curve;
    let drag = false;
    const at = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    canvas.addEventListener("pointerdown", (e) => { drag = true; canvas.setPointerCapture(e.pointerId); onScrub(this.frameAt(at(e).x), "start"); });
    canvas.addEventListener("pointermove", (e) => {
      const p = at(e);
      if (drag) { onScrub(this.frameAt(p.x), "move"); return; }
      this.hoverF = this.frameAt(p.x); this.draw();
    });
    const end = (e) => { if (drag) { drag = false; onScrub(this.frameAt(at(e).x), "end"); } };
    canvas.addEventListener("pointerup", end); canvas.addEventListener("pointercancel", end);
    canvas.addEventListener("pointerleave", () => { this.hoverF = null; this.draw(); });
  }
  resize(w, h, dpr) { this.w = w; this.h = h; this.dpr = dpr; this.c.width = Math.round(w * dpr); this.c.height = Math.round(h * dpr); }
  get x0() { return 12; }
  get x1() { return this.w - 12; }
  xOf(f) { const d = this.d; return this.x0 + ((f - (d.fs - 0.5)) / d.n) * (this.x1 - this.x0); }
  frameAt(x) { const d = this.d; return d.clampF(d.fs - 0.5 + ((x - this.x0) / (this.x1 - this.x0)) * d.n); }
  layout() {
    const RUL = 22, MK = 14, STR = 8, PADB = 6;
    const sy = this.h - PADB - STR;                     // stripe
    const gb = sy - 3, laneH = this.lanes ? Math.min(118, this.h - RUL - MK - 30 - STR - PADB) : 0;
    const lt = RUL + MK, gt = lt + laneH + (laneH ? 4 : 0);
    return { RUL, MK, sy, STR, gt, gb, lt, laneH };
  }
  draw() {
    const g = this.g, d = this.d, w = this.w, h = this.h, j = d.j;
    if (!w) return;
    const L = this.layout();
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = "#1f1f21"; g.fillRect(0, 0, w, h);                              // outside the scene range: darker
    const xs = this.xOf(d.fs - 0.5), xe = this.xOf(d.fe + 0.5);
    g.fillStyle = "#28282b"; g.fillRect(xs, L.RUL, xe - xs, h - L.RUL);
    // ruler: adaptive major step (labels never collide), minor ticks between
    g.fillStyle = "#2e2e31"; g.fillRect(0, 0, w, L.RUL);
    g.fillStyle = "rgba(0,0,0,.35)"; g.fillRect(0, L.RUL - 1, w, 1);
    const pxPer = (this.x1 - this.x0) / d.n;
    g.font = `500 10.5px ${FONT}`;
    const lw = g.measureText(String(d.fe)).width + 22;
    const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000];
    const step = steps.find((s) => s * pxPer >= lw) || 5000;
    const minor = [step / 5, step / 2].find((m) => Number.isInteger(m) && m * pxPer >= 7) || 0;
    g.textAlign = "center"; g.textBaseline = "middle";
    if (minor) for (let f = Math.ceil(d.fs / minor) * minor; f <= d.fe; f += minor) {
      if (f % step === 0) continue;
      g.fillStyle = "rgba(255,255,255,.16)"; g.fillRect(Math.round(this.xOf(f)), L.RUL - 5, 1, 4);
    }
    g.font = `600 11px ${FONT}`;
    const phX = this.xOf(this.frame), phW = Math.max(30, g.measureText(String(this.frame)).width + 14);
    g.font = `500 10.5px ${FONT}`;
    for (let f = Math.ceil(d.fs / step) * step; f <= d.fe; f += step) {
      const x = Math.round(this.xOf(f));
      g.fillStyle = "rgba(255,255,255,.045)"; g.fillRect(x, L.RUL, 1, h - L.RUL);   // faint grid
      g.fillStyle = "rgba(255,255,255,.3)"; g.fillRect(x, L.RUL - 7, 1, 6);
      const tw = g.measureText(String(f)).width;
      if (Math.abs(x - phX) < phW / 2 + tw / 2 + 3) continue;                     // the playhead's box wins
      g.fillStyle = "#9d9da3"; g.fillText(String(f), x, 9.5);
    }
    for (const f of [d.fs - 0.5, d.fe + 0.5]) { g.fillStyle = "rgba(255,255,255,.14)"; g.fillRect(Math.round(this.xOf(f)), L.RUL, 1, h - L.RUL); }
    // spots to check: a soft band through graph + stripe, a small marker; text once per distinct reason
    const seen = new Set();
    let lastX = -1e9;
    for (const s of j.health.spots) {
      const c = d.Q[s.code], xa = this.xOf(s.a - 0.5), xb = Math.max(this.xOf(s.b + 0.5), xa + 3);
      g.fillStyle = rgba(c, 0.11); g.fillRect(xa, L.RUL + L.MK - 2, xb - xa, h - L.RUL - L.MK + 2);
      const mx = (xa + xb) / 2, my = L.RUL + 3;
      g.beginPath(); g.moveTo(mx, my + 8); g.lineTo(mx - 4.5, my); g.lineTo(mx + 4.5, my); g.closePath();
      g.fillStyle = rgba(c, 1); g.fill(); g.lineWidth = 1; g.strokeStyle = "rgba(0,0,0,.5)"; g.stroke();
      if (!seen.has(s.label)) {
        g.font = `500 10px ${FONT}`; g.textAlign = "left";
        const tw = g.measureText(s.label).width, tx = Math.min(mx + 8, w - tw - 6);
        if (tx > lastX + 8) { g.fillStyle = rgba(c, 0.95); g.fillText(s.label, tx, my + 4.5); lastX = tx + tw; seen.add(s.label); }
      }
    }
    for (const [a, b] of j.health.bridges) { g.fillStyle = "rgba(89,153,255,.09)"; g.fillRect(this.xOf(a - 0.5), L.RUL + L.MK - 2, this.xOf(b + 0.5) - this.xOf(a - 0.5), h - L.RUL - L.MK + 2); }
    // lanes (optional): one per track point / surface
    if (L.laneH > 0) {
      const lane = Math.max(1.2, Math.min(6, L.laneH / j.lanes.length)), th = Math.max(1, lane * 0.62);
      j.lanes.forEach((ln, i) => {
        const y = L.lt + i * lane;
        for (const [a, b, key] of ln.runs) {
          const c = LANE_COL[key] || [0.25, 0.85, 0.4, ln.loose ? 0.55 : 0.85];
          g.fillStyle = rgba(c); g.fillRect(this.xOf(a), y, Math.max(this.xOf(b + 0.5) - this.xOf(a), 1), th);
        }
      });
    }
    // Pixel error on a linear axis; keep gaps where diagnostics are unavailable.
    const R = j.rows, curve = this.curve, gh = L.gb - L.gt;
    if (gh > 8 && curve?.some(Number.isFinite) && j.comparison !== 'rig' && (!j.primitivePreview || this.hasPixelErrors) && !j.skeletons && !j.cameraReview && j.preset !== 'Saved Blender camera') {
      const yOf = (v) => L.gb - Math.min(1, v) * gh;
      g.font = `500 9px ${FONT}`; g.textAlign = "left"; g.textBaseline = "bottom";
      for (const v of [0.5, 1]) {
        const t = this.hasPixelErrors ? `${+(v * this.errorMax).toFixed(2)} px` : `${v * 100}%`;
        const y = Math.round(yOf(v)) + 0.5;
        g.strokeStyle = "rgba(255,255,255,.08)"; g.lineWidth = 1; g.setLineDash([3, 3]);
        g.beginPath(); g.moveTo(xs, y); g.lineTo(xe, y); g.stroke(); g.setLineDash([]);
        if (gh > 20) { g.fillStyle = "rgba(255,255,255,.32)"; g.fillText(t, xs + 3, y - 1); }
      }
      let connected = false;
      g.beginPath(); R.frames.forEach((f, k) => {
        if (!Number.isFinite(curve[k])) { connected = false; return; }
        const x = this.xOf(f), y = yOf(curve[k]);
        connected ? g.lineTo(x, y) : g.moveTo(x, y); connected = true;
      });
      g.lineWidth = 1.2; g.strokeStyle = "rgba(255,255,255,.62)"; g.stroke();
    }
    // health stripe: one colour per tracked frame; short non-solid runs get a minimum width so they stay visible
    g.save(); roundRect(g, xs, L.sy, xe - xs, L.STR, 2.5); g.clip();
    g.fillStyle = "#3a3a3e"; g.fillRect(xs, L.sy, xe - xs, L.STR);
    for (let k = 0; k < R.frames.length;) {
      let m = k;
      while (m + 1 < R.frames.length && R.quality[m + 1] === R.quality[k]) m++;
      const xa = this.xOf(R.frames[k] - 0.5), xb = this.xOf(R.frames[m] + (R.frames[m + 1] ? R.frames[m + 1] - R.frames[m] : 1) - 0.5);
      const minW = R.quality[k] ? 3 : 0, cx = (xa + xb) / 2, ww = Math.max(xb - xa, minW);
      g.fillStyle = rgba(d.Q[R.quality[k]], 1); g.fillRect(R.quality[k] ? cx - ww / 2 : xa, L.sy, ww + (R.quality[k] ? 0 : 0.5), L.STR);
      k = m + 1;
    }
    g.restore();
    // hover guide
    if (this.hoverF != null) { g.fillStyle = "rgba(255,255,255,.18)"; g.fillRect(Math.round(this.xOf(this.hoverF)), L.RUL, 1, h - L.RUL); }
    // playhead: line with a dark edge, frame box in the ruler, a dot on the graph
    const x = this.xOf(this.frame);
    g.fillStyle = "rgba(0,0,0,.45)"; g.fillRect(x - 1.5, L.RUL, 3, h - L.RUL);
    g.fillStyle = BLUE; g.fillRect(x - 0.75, L.RUL - 2, 1.5, h - L.RUL + 2);
    const kq = R.frames.findIndex((f) => f >= this.frame);
    if (gh > 8 && kq >= 0 && Number.isFinite(curve[kq])) {
      const y = L.gb - Math.min(1, curve[kq]) * gh;
      g.beginPath(); g.arc(x, y, 3.2, 0, Math.PI * 2); g.fillStyle = "#fff"; g.fill(); g.lineWidth = 1.5; g.strokeStyle = BLUE; g.stroke();
    }
    const lab = String(this.frame); g.font = `600 11px ${FONT}`;
    const bw = Math.max(30, g.measureText(lab).width + 14), bx = Math.min(Math.max(x - bw / 2, 1), w - bw - 1);
    g.fillStyle = BLUE; roundRect(g, bx, 2, bw, L.RUL - 5, 4); g.fill();
    g.fillStyle = "#fff"; g.textAlign = "center"; g.textBaseline = "middle"; g.fillText(lab, bx + bw / 2, (L.RUL - 3) / 2 + 2);
  }
}

// ═══ the element ═══════════════════════════════════════════════════════════════════════════════════════════════
const CSS = `
:host{
  --pp-bg:#1f1f21; --pp-panel:#2b2b2e; --pp-bar:#303033; --pp-btn:#3d3d41; --pp-btn-h:#4a4a4f; --pp-line:rgba(255,255,255,.07);
  --pp-text:#e4e4e7; --pp-muted:#9d9da3; --pp-blue:${BLUE}; --pp-sel:${rgba(SEL, 1)};
  --pp-font:var(--body,"Instrument Sans","Inter","Segoe UI",system-ui,sans-serif);
  --pp-r:10px; --pp-h:28px;
  display:block;position:relative;color:var(--pp-text);font:500 12px/1.35 var(--pp-font);background:var(--pp-bg);
  border-radius:var(--pp-r);overflow:hidden;border:1px solid rgba(255,255,255,.09);
  user-select:none;-webkit-user-select:none;container-type:inline-size;font-variant-numeric:tabular-nums}
*{box-sizing:border-box}
[hidden]{display:none!important}
button,input{font:inherit;color:inherit}
:host(:fullscreen),:host([expanded]){display:flex;flex-direction:column;border-radius:0;border:0;width:100%;height:100%}
:host(:fullscreen) .stage,:host([expanded]) .stage{flex:1;aspect-ratio:auto;min-height:100px}
:host(:fullscreen) .foot,:host([expanded]) .foot{display:none}
.preset-panel{padding:10px 12px;background:#171626;border-bottom:1px solid #45405b;flex:none}
.preset-top{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}
.preset-tools{display:flex;border:1px solid #4d4864;border-radius:7px;padding:3px;gap:3px}
.preset-tools>[role=group]{display:flex;gap:3px}
.preset-tools button{display:flex;align-items:center;justify-content:center;gap:7px;min-width:65px;min-height:32px;padding:5px 10px;border:1px solid transparent;border-radius:4px;background:transparent;cursor:pointer;font-size:12px;color:#c7c5d8}
.preset-tools button[data-quality=fast]{--preset-color:#73d6df}
.preset-tools button[data-quality=normal]{--preset-color:#f3bf76}
.preset-tools button[data-quality=best]{--preset-color:#b7a5ff}
.preset-tools i,.preset-trace i{width:7px;height:7px;background:var(--preset-color);border-radius:50%;flex:none}
.preset-tools button[aria-pressed=true]{border-color:var(--preset-color);background:#353044;color:#fff}
.preset-tools button[aria-disabled=true]{color:#868296;cursor:default}
.preset-tools button:focus-visible{outline:2px solid #9be9ff;outline-offset:2px}
.preset-tools button>span{display:grid;gap:2px;text-align:left}.preset-tools small{font-size:9px;line-height:1.3;font-weight:400;color:inherit;opacity:.85;font-variant-numeric:tabular-nums}
.preset-trace{display:flex;align-items:center;gap:6px;color:#c8c5d7;font-size:10px}
.preset-status{font-size:10px;color:#aaa7be;margin:7px 0 0;line-height:1.5}
@media(hover:hover){.preset-tools button[aria-disabled=false]:hover{background:#37334a}}
@media(pointer:coarse){.preset-tools button{min-height:40px}}
@media(forced-colors:active){.preset-tools button[aria-pressed=true]{border-color:Highlight;color:Highlight}.preset-tools button:focus-visible{outline-color:ButtonText}}

/* ── 1 viewport ─────────────────────────────────────────── */
.stage{position:relative;width:100%;aspect-ratio:var(--pp-aspect,16/9.4);background:radial-gradient(120% 90% at 50% 42%,#404044,#2a2a2d);overflow:hidden;touch-action:none}
.stage video{position:absolute;object-fit:fill;background:#111}
.stage canvas{position:absolute;inset:0;width:100%;height:100%}
.stage .gl{z-index:1}.stage .ov{z-index:2;pointer-events:none}
.stage.overview{cursor:grab}.stage.overview.dragging{cursor:grabbing}
.stage.camera{touch-action:pan-y}
.stage.hot{cursor:pointer}
.chip{position:absolute;z-index:5;display:flex;align-items:center;gap:6px;height:24px;padding:0 8px;border-radius:6px;
  background:rgba(22,22,26,.72);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);border:1px solid var(--pp-line);white-space:nowrap}
.viewport-selector{position:absolute;z-index:6;top:7px;right:8px;max-width:calc(100% - 16px)}
.stage:has(.verdict:not([hidden])) .viewport-selector{top:39px}
@container (max-width:540px){.viewport-selector{top:39px}}
.info{top:7px;left:8px;min-width:75px}
.info b{font-weight:600}
.info .sep{width:1px;height:12px;background:rgba(255,255,255,.18)}
.info .f{color:var(--pp-muted)}
.info .f em{font-style:normal;color:var(--pp-text);font-weight:600}
.ib{all:unset;display:grid;place-items:center;width:18px;height:18px;border-radius:4px;color:var(--pp-muted);cursor:pointer}
.ib:hover,.ib[aria-expanded="true"]{background:rgba(255,255,255,.1);color:#fff}
.ib:focus-visible{outline:2px solid var(--pp-blue)}
.verdict{top:7px;right:8px;cursor:pointer}
.verdict:hover{background:rgba(30,30,35,.85)}
.dot{width:8px;height:8px;border-radius:50%;flex:none;box-shadow:0 0 0 1.5px rgba(0,0,0,.35)}
.verdict .d{color:var(--pp-muted)}
.pop{position:absolute;z-index:8;min-width:220px;max-width:min(340px,86%);background:rgba(26,26,30,.96);border:1px solid rgba(255,255,255,.1);
  border-radius:8px;padding:8px 10px;box-shadow:0 10px 28px rgba(0,0,0,.45);font-size:11.5px;line-height:1.5;display:none;user-select:text}
.pop.open{display:block}
.pop dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:2px 10px}
.pop dt{color:var(--pp-muted)}.pop dd{margin:0;min-width:0;overflow-wrap:anywhere}
.pop h4{margin:0 0 4px;font-size:12px;font-weight:600;display:flex;gap:7px;align-items:center}
.pop p{margin:4px 0 0;color:#c9c9ce}
.pop .spots{display:flex;flex-wrap:wrap;gap:4px;margin-top:6px}
.pop .spots button{height:22px;padding:0 7px;border-radius:4px;border:0;background:var(--pp-btn);cursor:pointer;display:flex;gap:5px;align-items:center}
.pop .spots button:hover{background:var(--pp-btn-h)}
.info-pop{top:36px;left:8px}.verdict-pop{top:36px;right:8px}
.status{position:absolute;z-index:5;left:8px;bottom:7px;max-width:calc(100% - 16px);gap:8px}
.stage.overview .status{max-width:calc(100% - min(25%,232px) - 28px)}
.status .t{font-weight:600}
.status .s{color:#c9c9ce;overflow:hidden;text-overflow:ellipsis;min-width:0}
.status .n{display:flex;gap:8px;color:var(--pp-muted);padding-left:8px;border-left:1px solid rgba(255,255,255,.14)}
.status .n span{display:flex;align-items:center;gap:4px}
.status .n i{width:7px;height:7px;border-radius:50%;box-shadow:0 0 0 1px rgba(0,0,0,.5)}
.tip{position:absolute;z-index:9;pointer-events:none;background:rgba(18,18,22,.95);border:1px solid rgba(255,255,255,.12);border-radius:7px;
  padding:7px 9px;font-size:11.5px;line-height:1.45;max-width:260px;box-shadow:0 8px 22px rgba(0,0,0,.45);display:none}
.tip.on{display:block}
.tip b{display:flex;align-items:center;gap:6px;font-weight:600;margin-bottom:2px}
.tip span{display:block;color:#c3c3c8}
.tip small{display:block;color:var(--pp-muted);margin-top:3px}
.pip{position:absolute;z-index:4;right:8px;bottom:7px;width:min(25%,232px);border-radius:6px;overflow:hidden;
  border:1px solid rgba(255,255,255,.22);box-shadow:0 6px 18px rgba(0,0,0,.4);background:#111;display:none;cursor:pointer;aspect-ratio:var(--pp-vaspect)}
.stage.overview .pip{display:block}
.stage .pip-video{z-index:4;right:8px;bottom:7px;width:min(25%,232px);height:auto;aspect-ratio:var(--pp-vaspect);border-radius:6px;pointer-events:none}.stage.overview .pip{z-index:5;background:transparent}
.pip .lab{position:absolute;left:5px;top:5px;font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;background:rgba(0,0,0,.6);padding:2px 6px;border-radius:4px}
.pip .back{position:absolute;right:5px;bottom:5px;font-size:10.5px;background:rgba(0,0,0,.65);padding:2px 7px;border-radius:4px;opacity:0;transition:opacity .15s}
.pip:hover .back,.pip:focus-visible .back{opacity:1}
.hint{position:absolute;z-index:6;left:50%;bottom:44px;transform:translateX(-50%);background:rgba(22,22,26,.82);border:1px solid var(--pp-line);
  border-radius:20px;padding:6px 12px;font-size:11.5px;color:#d6d6da;width:max-content;max-width:calc(100% - 24px);white-space:normal;text-align:center;opacity:0;transition:opacity .4s;pointer-events:none}
.hint.on{opacity:1}
.hint kbd{margin:0 2px}
.loading{position:absolute;inset:0;z-index:9;display:grid;place-items:center;background:#222225;color:#9d9da3;font-size:12.5px;transition:opacity .4s}
.loading.done{opacity:0;pointer-events:none}

/* ── 2 control bar + timeline ─────────────────────────────── */
.bar{display:flex;align-items:center;gap:10px;height:40px;padding:0 8px;background:var(--pp-bar);border-top:1px solid rgba(0,0,0,.45)}
.grp{display:flex;align-items:center}
.join{display:flex;background:var(--pp-btn);border-radius:6px;overflow:hidden}
.join>button{border-radius:0}
.join>button+button{box-shadow:inset 1px 0 0 rgba(0,0,0,.28)}
button.b{height:var(--pp-h);min-width:30px;padding:0 8px;border:0;border-radius:6px;background:var(--pp-btn);display:inline-flex;align-items:center;justify-content:center;gap:6px;cursor:pointer;position:relative}
button.b:hover{background:var(--pp-btn-h)}
button.b:disabled{opacity:.38;cursor:default;background:var(--pp-btn)}
button.b.on{background:var(--pp-blue);color:#fff}
button:focus-visible,input:focus-visible{outline:2px solid var(--pp-blue);outline-offset:1px}
.play{min-width:36px!important}
.play.on{background:var(--pp-blue)}
svg{width:14px;height:14px;fill:currentColor;flex:none}
.frame{display:flex;align-items:center;gap:8px}
.frame-stepper{display:flex;align-items:center;gap:2px;background:#242427;border-radius:6px;padding:2px}
.frame-stepper button.b{min-width:26px;padding:0 5px;background:transparent}
.frame-stepper button.b:hover{background:var(--pp-btn-h)}
.frame input{width:58px;height:var(--pp-h);border-radius:6px;border:1px solid rgba(0,0,0,.4);background:#1d1d20;text-align:center;font-weight:600;font-size:12.5px;padding:0 4px}
.frame input:hover{border-color:rgba(255,255,255,.18)}
.range{color:var(--pp-muted);font-size:11.5px;white-space:nowrap}
.sp{flex:1}
.seg{display:grid;grid-template-columns:1fr 1fr;background:#1d1d20;border-radius:7px;padding:2px;gap:2px}
.seg button{height:24px;min-width:84px;border:0;border-radius:5px;background:transparent;color:var(--pp-muted);cursor:pointer;display:flex;gap:6px;align-items:center;justify-content:center;padding:0 10px}
.seg button:hover{color:#fff;background:rgba(255,255,255,.06)}
.seg button.on{background:var(--pp-btn-h);color:#fff;box-shadow:inset 0 0 0 1px rgba(255,255,255,.08)}
.seg button.on svg{color:var(--pp-blue);filter:brightness(1.5)}
.tools{display:flex;gap:6px;align-items:center}
.menu{position:relative}
.menu .pop{bottom:36px;top:auto;right:0;min-width:236px;padding:6px}
.menu .h{font-size:10px;letter-spacing:.07em;text-transform:uppercase;color:var(--pp-muted);padding:6px 8px 3px}
.row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:4px 8px;border-radius:5px;cursor:pointer;min-height:26px}
.row:hover{background:rgba(255,255,255,.06)}
.row input{appearance:none;width:26px;height:15px;border-radius:8px;background:#55555b;position:relative;cursor:pointer;flex:none;margin:0}
.row input::after{content:"";position:absolute;top:2px;left:2px;width:11px;height:11px;border-radius:50%;background:#ddd;transition:transform .15s}
.row input:checked{background:var(--pp-blue)}.row input:checked::after{transform:translateX(11px);background:#fff}
.row .mini{display:flex;background:#1d1d20;border-radius:5px;padding:2px}
.row .mini button{all:unset;padding:1px 7px;border-radius:4px;color:var(--pp-muted);cursor:pointer;font-size:11px}
.row .mini button.on{background:var(--pp-btn-h);color:#fff}
.menu hr{border:0;border-top:1px solid rgba(255,255,255,.08);margin:4px 2px}
[data-tip]:hover::after{content:attr(data-tip);position:absolute;bottom:calc(100% + 6px);left:50%;transform:translateX(-50%);white-space:nowrap;
  background:rgba(18,18,22,.96);color:#e4e4e7;font-size:11px;font-weight:500;padding:4px 7px;border-radius:5px;pointer-events:none;z-index:20;
  border:1px solid rgba(255,255,255,.1)}
.tools [data-tip]:hover::after{left:auto;right:0;transform:none}
.cube-pop{bottom:36px;top:auto;right:0;min-width:248px}
.cube-pop .sl{display:grid;grid-template-columns:62px 1fr 52px;align-items:center;gap:8px;padding:4px 2px}
.cube-pop .sl span{color:var(--pp-muted)}
.cube-pop .sl output{text-align:right;font-weight:600}
.cube-pop input[type=range]{width:100%;accent-color:var(--pp-blue)}
.cube-pop .acts{display:flex;gap:6px;margin-top:6px}
.cube-pop .acts button{flex:1;height:26px;border:0;border-radius:5px;background:var(--pp-btn);cursor:pointer}
.cube-pop .acts button:hover{background:var(--pp-btn-h)}
.cube-pop .where{color:#c9c9ce;margin:2px 2px 4px}
.stage.placing,.stage.placing.hot{cursor:crosshair}
.tl{display:block;width:100%;height:84px;cursor:col-resize;touch-action:none;border-top:1px solid rgba(0,0,0,.45)}
.timeline-note{margin:0;padding:8px 12px;border-top:1px solid var(--pp-line);background:#252528;color:#b9b9c2;font-size:11px;line-height:1.55;user-select:text}
.timeline-note strong{color:#e4e4e7;font-weight:600}
.timeline-note .curve-mark{display:inline-block;width:18px;height:9px;border-top:2px solid #d4d4df;transform:skewY(-12deg);margin-right:6px}
.foot .ib{min-width:24px;min-height:24px}
:host([lanes]) .tl{height:200px}

/* ── 3 supporting information ─────────────────────────────── */
.foot{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:6px 18px;padding:7px 10px;background:var(--pp-panel);
  border-top:1px solid rgba(0,0,0,.45);font-size:11.5px;color:var(--pp-muted)}
.legend{display:flex;flex-wrap:wrap;gap:4px 14px;align-items:center;min-width:0}
.legend .k{display:flex;align-items:center;gap:7px}
.legend .k{flex-wrap:wrap}
.legend .k>span{display:flex;align-items:center;gap:5px;color:#c4c4c9;white-space:normal}
.legend .g{color:var(--pp-muted);font-size:10.5px;text-transform:uppercase;letter-spacing:.06em}
.mk{width:9px;height:9px;border-radius:50%;box-shadow:0 0 0 1.5px #fff,0 0 0 2.5px rgba(0,0,0,.6)}
.mk.grey{width:7px;height:7px;box-shadow:0 0 0 1px #bbb,0 0 0 2px rgba(0,0,0,.6)}
.sq{width:10px;height:10px;border-radius:2px;border:1.5px solid}
.bar-s{width:16px;height:6px;border-radius:2px}
.keys{display:flex;flex-wrap:wrap;gap:4px 12px;align-items:center}
.keys span{display:flex;align-items:center;gap:5px}
kbd{display:inline-grid;place-items:center;min-width:18px;height:18px;padding:0 5px;border-radius:4px;background:#3a3a3f;border:1px solid rgba(0,0,0,.5);
  box-shadow:inset 0 -1px 0 rgba(0,0,0,.4);font:600 10.5px var(--pp-font);color:#e4e4e7}
.help{position:relative}
.help .pop{bottom:30px;right:0;top:auto;min-width:250px}
.help .pop dl{grid-template-columns:auto 1fr;gap:5px 12px;align-items:center}
.help .pop dt{display:flex;gap:3px}

@container (max-width:620px){
  .range,.hide-s{display:none!important}
  .seg button{min-width:0;padding:0 8px}.seg .txt{display:none}
  .bar{gap:6px;padding:0 6px}
  .keys .opt{display:none}
  .status .s{display:none}
  .stage{aspect-ratio:4/3.4}
}
@container (max-width:420px){
  .join>button.b{min-width:26px;padding:0 5px}
  .info .sep,.status .n{display:none}
  .chip.info b{font-size:10px}
}
@container (max-width:360px){
  .bar{height:auto;min-height:40px;flex-wrap:wrap;padding:5px 6px}
  .sp{display:none}
  .tools{margin-left:auto}
  .verdict .d{display:none}
}
@media (prefers-reduced-motion:reduce){.hint{transition:none}}
`;
const I = (p, vb = "0 0 16 16") => `<svg viewBox="${vb}" aria-hidden="true">${p}</svg>`;
const ICON = {
  play: I('<path d="M4.5 2.8v10.4L13 8z"/>'),
  pause: I('<path d="M4 2.8h2.8v10.4H4zM9.2 2.8H12v10.4H9.2z"/>'),
  start: I('<path d="M3 2.8h2v10.4H3zM13.5 2.8v10.4L6 8z"/>'),
  end: I('<path d="M11 2.8h2v10.4h-2zM2.5 2.8v10.4L10 8z"/>'),
  prev: I('<path d="M11 3v10L5 8z"/>'),
  next: I('<path d="M5 3v10l6-5z"/>'),
  eye: I('<path d="M8 3.5C4.4 3.5 1.8 6.2 1 8c.8 1.8 3.4 4.5 7 4.5s6.2-2.7 7-4.5c-.8-1.8-3.4-4.5-7-4.5zm0 7.3A2.8 2.8 0 1 1 8 5.2a2.8 2.8 0 0 1 0 5.6z"/>'),
  eyeOff: I('<path d="M2.3 1.3 1.3 2.3l2.2 2.2C2.3 5.5 1.4 6.8 1 8c.8 1.8 3.4 4.5 7 4.5 1.3 0 2.5-.3 3.5-.9l2.2 2.2 1-1zM8 10.8A2.8 2.8 0 0 1 5.4 7l1 1A1.6 1.6 0 0 0 8 9.6l1 1c-.3.1-.7.2-1 .2zm7-2.8c-.5-1.1-1.6-2.6-3.3-3.6A7.3 7.3 0 0 0 8 3.5c-.7 0-1.4.1-2 .3l1.3 1.3c.2 0 .5-.1.7-.1A2.8 2.8 0 0 1 10.8 8c0 .2 0 .5-.1.7l2.4 2.4c.9-.9 1.6-2 1.9-3.1z"/>'),
  caret: I('<path d="M3.5 6h9L8 11z"/>'),
  frameAll: I('<path d="M1.5 5V1.5H5V3H3v2zM11 1.5h3.5V5H13V3h-2zM14.5 11v3.5H11V13h2v-2zM5 14.5H1.5V11H3v2h2zM8 5a3 3 0 1 1 0 6 3 3 0 0 1 0-6z"/>'),
  full: I('<path d="M1.5 6V1.5H6V3H3v3zM10 1.5h4.5V6H13V3h-3zM14.5 10v4.5H10V13h3v-3zM6 14.5H1.5V10H3v3h3z"/>'),
  exitFull: I('<path d="M4.5 1.5H6V6H1.5V4.5h3zM10 1.5h1.5v3h3V6H10zM10 10h4.5v1.5h-3v3H10zM1.5 10H6v4.5H4.5v-3h-3z"/>'),
  cam: I('<path d="M1.5 4.5h8.5v7H1.5zM10.8 7.2l3.7-2.2v6l-3.7-2.2z"/>'),
  cube: I('<path d="M8 1.2 14 4.5v7L8 14.8 2 11.5v-7zm0 1.7L4.1 5 8 7.1 11.9 5zM3.5 6.3v4.4l3.8 2.1V8.4zm9 0L8.7 8.4v4.4l3.8-2.1z"/>'),
  testCube: I('<path d="M7 1.5 12.5 4.5v6L7 13.5 1.5 10.5v-6zm0 1.6L3.6 5 7 6.9 10.4 5zM3 6.3v3.4l3.3 1.9V8.2zm8 0L7.7 8.2v3.4L11 9.7z"/><path d="M13 10.5h1.5V12H16v1.5h-1.5V15H13v-1.5h-1.5V12H13z"/>'),
  info: I('<path d="M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM7.2 7v4.6h1.6V7zm.8-3a1 1 0 1 0 0 2 1 1 0 0 0 0-2z"/>'),
  help: I('<path d="M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zm-.1 8.8a.9.9 0 1 0 0 1.8.9.9 0 0 0 0-1.8zM8 4C6.6 4 5.6 4.9 5.5 6.2h1.5c.1-.6.4-.9 1-.9s1 .4 1 .9c0 .9-1.7 1-1.7 2.8v.3h1.5V9c0-1 1.7-1.2 1.7-2.9C10.5 4.9 9.5 4 8 4z"/>'),
};
const VERDICT = { GOOD: { col: [0.3, 0.78, 0.36], word: "Ready to use" }, CHECK: { col: [0.98, 0.78, 0.18], word: "Usable" },
  POOR: { col: [0.92, 0.26, 0.22], word: "Needs work" } };

class PerspectraPreview extends HTMLElement {
  constructor() {
    super();
    const r = this.attachShadow({ mode: "open" });
    r.innerHTML = `<style>${CSS}</style>
      <div class="preset-panel" hidden>
        <div class="preset-top"><div class="preset-tools" role="toolbar" focusgroup="toolbar wrap" aria-label="Automatic tracking preset"><div role="group" aria-label="Quality mode">
          <button type="button" data-quality="fast" aria-pressed="false"><i aria-hidden="true"></i><span>Fast<small></small></span></button>
          <button type="button" data-quality="normal" aria-pressed="true"><i aria-hidden="true"></i><span>Normal<small></small></span></button>
          <button type="button" data-quality="best" aria-pressed="false"><i aria-hidden="true"></i><span>Best<small></small></span></button>
        </div></div><span class="preset-trace"><i aria-hidden="true"></i><span>Normal camera trace</span></span></div>
        <p class="preset-status" role="status"></p>
      </div>
      <div class="stage camera" part="viewport">
        <video class="main-video" muted playsinline preload="auto" width="1280" height="676" aria-label="Original footage"></video>
        <canvas class="gl"></canvas><canvas class="ov"></canvas>
        <div class="viewport-selector"><slot name="model-controls"></slot></div>
        <div class="chip info"><span class="f">Frame <em class="fn">—</em></span></div>
        <div class="pop info-pop" role="dialog" aria-label="Camera and footage details"></div>
        <div class="chip verdict" role="button" tabindex="0" data-pop="verdict-pop" aria-expanded="false" hidden></div>
        <div class="pop verdict-pop" role="dialog" aria-label="Track result"></div>
        <div class="chip status" aria-live="off"><i class="dot"></i><span class="t"></span></div>
        <div class="pip" role="button" tabindex="0" aria-label="Camera footage — return to the camera view"><span class="lab">Camera footage</span><span class="back">Camera view ↩</span></div>
        <div class="hint">Drag to orbit · <kbd>Shift</kbd>/right-drag to pan · scroll to zoom</div>
        <div class="hint place-hint">Click where the test cube should stand · <kbd>Esc</kbd> cancels</div>
        <div class="tip" role="tooltip"></div>
        <div class="loading">Loading tracking result…</div>
      </div>
      <div class="bar" part="controls">
        <div class="join" role="group" aria-label="Playback">
          <button class="b" data-a="start" data-tip="First frame (Home)" aria-label="First frame">${ICON.start}</button>
          <button class="b play" data-a="play" data-tip="Play (Space)" aria-label="Play">${ICON.play}</button>
          <button class="b" data-a="end" data-tip="Last frame (End)" aria-label="Last frame">${ICON.end}</button>
        </div>
        <div class="frame"><div class="frame-stepper" role="group" aria-label="Frame navigation">
          <button class="b" data-a="prev" data-tip="Previous frame (←)" aria-label="Previous frame">${ICON.prev}</button>
          <input class="fin" type="text" inputmode="numeric" aria-label="Current frame" spellcheck="false">
          <button class="b" data-a="next" data-tip="Next frame (→)" aria-label="Next frame">${ICON.next}</button>
        </div><span class="range"></span></div>
        <span class="sp"></span>
        <div class="seg" role="tablist" aria-label="View">
          <button data-mode="camera" class="on" role="tab" aria-selected="true" aria-label="Camera view" title="Camera view (C)">${ICON.cam}<span class="txt">Camera</span></button>
          <button data-mode="overview" role="tab" aria-selected="false" aria-label="Scene overview" title="Scene overview (O)">${ICON.cube}<span class="txt">Overview</span></button>
        </div>
        <div class="tools">
          <button class="b hide-s" data-a="home" data-tip="Frame the whole scene" aria-label="Frame the whole scene" disabled>${ICON.frameAll}</button>
          <div class="menu cube-menu">
            <button class="b" data-a="cube" data-tip="Test cube (T)" aria-label="Test cube" aria-pressed="false">${ICON.testCube}</button>
            <div class="pop cube-pop" role="dialog" aria-label="Test cube">
              <div class="h">Test cube</div>
              <p class="where"></p>
              <label class="sl"><span>Scale</span><input type="range" class="c-size" min="0.05" max="3" step="0.01"><output class="o-size"></output></label>
              <label class="sl"><span>Rotation</span><input type="range" class="c-rot" min="-180" max="180" step="1"><output class="o-rot"></output></label>
              <div class="acts"><button data-c="move">Place again</button><button data-c="remove">Remove</button></div>
            </div>
          </div>
          <button class="b" data-a="full" data-tip="Fullscreen (F)" aria-label="Fullscreen">${ICON.full}</button>
          <div class="menu overlay-menu">
            <div class="join">
              <button class="b on" data-a="overlays" data-tip="Tracking overlays (H)" aria-pressed="true" aria-label="Tracking overlays">${ICON.eye}</button>
              <button class="b" data-a="menu" data-tip="Overlay options" aria-label="Overlay options" aria-haspopup="true" aria-expanded="false" style="min-width:22px;padding:0 4px">${ICON.caret}</button>
            </div>
            <div class="pop overlay-pop" role="dialog" aria-label="Overlay options">
              <div class="h">Tracking overlays</div>
              <label class="row">Track points <input type="checkbox" data-v="tpoints"></label>
              <div class="row">Point labels <span class="mini" role="radiogroup" aria-label="Point labels">
                <button data-labels="smart" title="Labels that fit without overlapping">Smart</button><button data-labels="all">All</button><button data-labels="off" title="Only hovered or selected">Off</button></span></div>
              <label class="row">Track edges <input type="checkbox" data-v="edges"></label>
              <label class="row">Surfaces <input type="checkbox" data-v="surfaces"></label>
              <label class="row">Health strip <input type="checkbox" data-v="health"></label>
              <hr><div class="h">Scene</div>
              <label class="row">Floor &amp; blockout geometry <input type="checkbox" data-v="geometry"></label>
              <label class="row">Grid &amp; axes <input type="checkbox" data-v="grid"></label>
              <label class="row">Camera path <input type="checkbox" data-v="path"></label>
              <label class="row">Keyframe cameras <input type="checkbox" data-v="keys"></label>
              <label class="row">Point cloud <input type="checkbox" data-v="cloud"></label>
              <hr class="lane-heading"><div class="h lane-heading">Timeline</div>
              <label class="row">Point &amp; surface lanes <input type="checkbox" data-v="lanes"></label>
            </div>
          </div>
        </div>
      </div>
      <canvas class="tl" part="timeline" aria-label="Tracking timeline" aria-describedby="timeline-description"></canvas>
      <p class="timeline-note" id="timeline-description"><svg width="22" height="12" viewBox="0 0 22 12" aria-hidden="true"><path d="M1 10C5 10 4 2 8 2S11 10 15 7s4-3 6-3" fill="none" stroke="currentColor" stroke-width="2"/></svg> <strong>Curve: image-fit error <span class="error-unit">(px)</span>.</strong> Lower means a closer match between projected 3D points and image tracks at the analysis resolution. Peaks mark frames to inspect. The coloured strip shows tracking health. Click or drag to scrub; use the frame controls to step.</p>
      <div class="foot" part="footer">
        <div class="legend"></div>
        <div class="keys">
          <span><kbd>Space</kbd>Play</span><span><kbd>←</kbd><kbd>→</kbd>Step</span>
          <span class="opt"><kbd>C</kbd><kbd>O</kbd>View</span><span class="opt"><kbd>H</kbd>Overlays</span>
          <button class="ib" data-pop="info-pop" aria-label="Camera and footage details" aria-expanded="false">${ICON.info}</button>
          <div class="help"><button class="ib" data-pop="help-pop" aria-label="All shortcuts" aria-expanded="false">${ICON.help}</button>
            <div class="pop help-pop" role="dialog" aria-label="Shortcuts"><dl>
              <dt><kbd>Space</kbd></dt><dd>Play / pause</dd>
              <dt><kbd>←</kbd><kbd>→</kbd></dt><dd>Previous / next frame</dd>
              <dt><kbd>Shift</kbd><kbd>←</kbd><kbd>→</kbd></dt><dd>10 frames</dd>
              <dt><kbd>Home</kbd><kbd>End</kbd></dt><dd>First / last frame (Home frames the scene in Overview)</dd>
              <dt><kbd>C</kbd><kbd>O</kbd></dt><dd>Camera view / Overview</dd>
              <dt><kbd>H</kbd></dt><dd>Tracking overlays on / off</dd>
              <dt><kbd>L</kbd></dt><dd>Point labels: smart → all → off</dd>
              <dt><kbd>F</kbd></dt><dd>Fullscreen</dd>
              <dt><kbd>T</kbd></dt><dd>Test cube: click where it should stand</dd>
              <dt><kbd>Esc</kbd></dt><dd>Clear the selection</dd>
              <dt>Mouse</dt><dd>Hover a point, edge or surface for details; click to select it. Overview: drag to orbit, Shift- or right-drag to pan, scroll to zoom.</dd>
            </dl></div></div>
        </div>
      </div>`;
    this.$ = (s) => r.querySelector(s);
    this.$$ = (s) => r.querySelectorAll(s);
    this.mode = "camera";
    this.v = { tpoints: true, edges: true, surfaces: true, health: true, geometry: true, grid: true, path: true, keys: false, cloud: true, lanes: false };
    this.labels = "smart";
    this.overlaysOn = true;
    this.sel = null; this.hov = null; this._picks = [];
    this.cube = null; this.placing = false;
    const bar = this.$('.preset-tools'), buttons = [...bar.querySelectorAll('button')];
    const nativeFocusGroup = 'focusGroup' in HTMLElement.prototype;
    if (!nativeFocusGroup) {
      buttons.forEach((b, i) => b.tabIndex = i ? -1 : 0);
      bar.addEventListener('focusin', e => buttons.forEach(b => b.tabIndex = b === e.target ? 0 : -1));
    }
    bar.addEventListener('keydown', e => {
      if (['ArrowLeft','ArrowRight','Home','End',' ','Enter'].includes(e.key)) e.stopPropagation();
      if (nativeFocusGroup || !['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return;
      const rtl = getComputedStyle(bar).direction === 'rtl', index = buttons.indexOf(e.target);
      const step = (e.key === 'ArrowRight' ? 1 : -1) * (rtl ? -1 : 1);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (index + step + buttons.length) % buttons.length;
      e.preventDefault(); buttons[next].focus();
    });
    bar.addEventListener('click', e => {
      const b = e.target.closest('button[data-quality]');
      if (!b || b.getAttribute('aria-disabled') === 'true' || b.getAttribute('aria-pressed') === 'true') return;
      this.dispatchEvent(new CustomEvent('preset-change', {detail:{quality:b.dataset.quality}}));
    });
  }
  setPresets(selected, modes, message = '', busy = false) {
    this.$('.preset-panel').hidden = false;
    const pending = [];
    for (const b of this.$$('.preset-tools button')) {
      const key = b.dataset.quality, name = key[0].toUpperCase() + key.slice(1), ready = !!modes[key]?.ready;
      b.setAttribute('aria-pressed', String(key === selected));
      b.setAttribute('aria-disabled', String(busy || !ready));
      b.setAttribute('aria-label', name + (ready ? ' automatic tracking' : ' automatic tracking — preview pending'));
      const runtime = ready ? trackingDuration(modes[key].elapsedSeconds) : 'Pending';
      b.querySelector('small').textContent = runtime;
      b.title = ready ? name + ' tracking time: ' + runtime + ' · ' + (modes[key].compute || 'Recorded run') : 'Preview pending';
      if (!ready) pending.push(name);
    }
    const colors = {fast:'#73d6df',normal:'#f3bf76',best:'#b7a5ff'};
    this.$('.preset-trace').style.setProperty('--preset-color',colors[selected]);
    this.$('.preset-trace span').textContent = selected[0].toUpperCase() + selected.slice(1) + ' camera trace';
    this.$('.preset-status').textContent = message || 'Recorded CPU tracking times · ' + (pending.length ? pending.join(' / ') + ' preview pending.' : 'Automatic results, before manual repair.');
  }
  connectedCallback() {
    if (this._started) return;
    this._started = true;
    this._load().catch((error) => {
      this.dispatchEvent(new CustomEvent("preview-error", { detail: error }));
    });
  }
  pause() { this.pb?.pause(); }
  disconnectedCallback() {
    this._ro?.disconnect(); this._io?.disconnect(); this._events?.abort();
    this.pb?.dispose(); cancelAnimationFrame(this._raf); this._raf = 0;
    this.s3?.scene.traverse(object => { object.skeleton?.dispose(); object.geometry?.dispose(); for (const material of [].concat(object.material || [])) { material.map?.dispose(); material.dispose(); } });
    this.s3?.vtex?.dispose(); this.s3?.renderer.dispose(); this.s3?.renderer.forceContextLoss();
    this.rectified?.dispose();
    this.dispatchEvent(new Event('preview-dispose'));
  }

  async _load() {
    const src = this.getAttribute("src") || "data/scene.json";
    const response = await fetch(src);
    if (!response.ok) throw new Error("Could not load the tracking data.");
    const j = await response.json();
    const d = (this.d = new SceneData(j));
    this.style.setProperty("--pp-vaspect", `${d.W}/${d.H}`);
    this._events = new AbortController();
    const v = this.$(".main-video");
    v.width = d.W; v.height = d.H;
    if (this.hasAttribute("poster")) v.poster = this.getAttribute("poster");
    v.src = this.getAttribute("video") || "data/footage.mp4";
    this.pb = new Playback(v, d);
    this.s3 = new Scene3D(this.$(".gl"), d);
    this.s3.update(d.fs, this.sel);
    this.s3.setVideoTexture(v);
    if (!j.footageRectified && Math.abs(j.kappa || 0) > 1e-6) this.rectified = new RectifiedFootage(v,d,this.$('.stage'));
    this.ov = new Overlay2D(this.$(".ov"));
    this.tl = new Timeline(this.$(".tl"), d.playback, (f, ph) => this._scrub(f, ph));
    this.$('.error-unit').textContent = this.tl.hasPixelErrors ? '(px)' : '(relative)';
    if (j.preset === 'Saved Blender camera') this.$('.timeline-note').textContent = 'Saved camera animation. Drag the playhead to inspect the footage frame by frame.';
    if (j.cameraReview) this.$('.timeline-note').textContent = 'Refined camera. Drag the playhead to compare the cube corner with the observed feature.';
    this.rig = new OrbitRig(this.$(".stage"), this.s3.ovCam, () => this.invalidate(), () => this._hideHint());
    const sh = j.show || {};                                      // start state: the add-on's own toggles
    Object.assign(this.v, { tpoints: sh.tpoints ?? true, edges: sh.edges ?? true, surfaces: sh.surfaces ?? true, health: sh.health ?? true });
    if (j.preset) Object.assign(this.v, { tpoints: false, edges: false, surfaces: false, cloud: !!j.cloud?.xyz?.length });
    if (j.skeletons) {
      this.v.path = false;
      this.$('.cube-menu').hidden = true;
      this.$('.timeline-note').textContent = 'Drag the playhead to inspect a pose, or step one frame at a time.';
    }
    if (j.comparison === 'bridge' || j.primitivePreview) {
      const keys = j.primitivePreview ? ['geometry', 'grid', 'path', ...(j.show?.cameraCloud ? ['cloud'] : [])] : ['geometry', 'cloud', 'health'];
      for (const row of this.$$('.overlay-pop > *')) {
        const input = row.querySelector('input[data-v]');
        row.hidden = !input || !keys.includes(input.dataset.v);
        if (input?.dataset.v === 'geometry') row.firstChild.textContent = 'Mesh ';
      }
      if (j.comparison === 'bridge') Object.assign(this.v, {grid:false,path:false});
      if (j.primitivePreview && j.rows.err?.some(Number.isFinite)) this.$('.timeline-note').textContent = 'The curve shows image-fit error in pixels. The strip below shows tracking health.';
    }
    if (j.primitivePreview && !j.timelineNote && !j.rows.err?.some(Number.isFinite)) {
      this.$('.timeline-note').hidden = true;
      this.$('.tl').removeAttribute('aria-describedby');
    }
    if (j.timelineNote) this.$('.timeline-note').textContent = j.timelineNote;
    if (this.hasAttribute("lanes")) this.v.lanes = true;
    this.$(".range").textContent = `${d.playback.fs}–${d.playback.fe} · ${+d.fps.toFixed(3)} fps`;
    this._legend(); this._verdict(j.health); this._ui(); this._syncMenu();
    if (j.preset) {
      this.$('.legend').innerHTML = j.cubeAnchor
        ? '<div class="k"><span class="g">Ring</span><span>Observed image feature.</span></div>'
        : '<div class="k"><span class="g">Scene points</span><span>Projected 3D estimates.</span></div>';
      for (const key of ['tpoints','edges','surfaces','lanes']) this.$(`[data-v="${key}"]`)?.closest('label')?.setAttribute('hidden','');
    }
    if (j.skeletons) {
      this.$('.legend').textContent = j.handTracks ? 'Green marks the left hand and amber the right. Gray marks a filled gap.'
        : j.skeletons.length > 1 ? 'Each color follows a tracked performer.'
        : j.poseDisplay === 'bones' ? 'Green shows the tracked bones.' : 'The body follows the tracked performer.';
      for (const key of ['tpoints','edges','surfaces','health','geometry','cloud','keys','lanes']) this.$(`[data-v="${key}"]`).closest('label').hidden = true;
      this.$('[data-labels]').closest('.row').hidden = true;
    }
    if (!d.tps.length) this.$('[data-labels]').closest('.row').hidden = true;
    if (!j.meshes?.length) this.$('[data-v="geometry"]').closest('label').hidden = true;
    if (this.$('[data-v="lanes"]').closest('label').hidden) {
      for (const heading of this.$$('.lane-heading')) heading.hidden = true;
    }
    if (j.comparison === 'rig') {
      this.$('.timeline-note').textContent = 'The strip shows tracking health from the Normal analysis of this footage. Both views share the same frame timing.';
      this.$('.legend').textContent = 'Orange shows the animated camera and its path.';
    }
    if (j.comparison === 'bridge') this.$('.legend').textContent = 'Orange dots show the point cloud. The outlines mark the pillars.';
    if (j.primitivePreview) this.$('.legend').textContent = j.show?.cameraCloud ? 'Dots show verified landmarks. Outlines show the fitted shapes.' : 'Mesh outlines show the fitted shapes.';
    this.pb.addEventListener("frame", () => this.invalidate());
    this.pb.addEventListener("state", () => this._playIcon());
    this._ro = new ResizeObserver(() => this._resize()); this._ro.observe(this);
    this._resize();
    this._frameOverview(false);
    this._applyMode();
    this.pb.seek(+(this.getAttribute("frame") || d.fs), true);
    if (this.getAttribute("mode") === "overview") this.setMode("overview", false);
    v.addEventListener("loadeddata", () => { this.$(".loading").classList.add("done"); this.invalidate(); }, { once: true });
    v.addEventListener("error", () => { this.$(".loading").textContent = "Footage unavailable — showing the tracking data only."; setTimeout(() => this.$(".loading").classList.add("done"), 1500); }, { once: true });
    if (this.hasAttribute("autoplay")) {
      this._io = new IntersectionObserver(([e]) => {
        if (e.isIntersecting && e.intersectionRatio > 0.4) { if (!this._userPaused) this.pb.play(); }
        else if (this.pb.playing) this.pb.pause();
      }, { threshold: [0, 0.4, 0.8] });
      this._io.observe(this);
    }
    this.dispatchEvent(new CustomEvent("ready", { detail: { frames: [d.playback.fs, d.playback.fe] } }));
  }

  // ── supporting information ────────────────────────────────────────────────────────────────────────────────
  _legend() {
    const d = this.d, Q = d.Q;
    const word = { 0: "Solid", 1: "Check", 2: "Weak", 3: "Blurred, filled in", 4: "Jump repaired" };
    const health = d.qPresent.map((q) => `<span><i class="bar-s" style="background:${rgba(Q[q], 1)}"></i>${word[q] || d.j.health.titles[q]}</span>`).join("");
    this.$(".legend").innerHTML = `
      <div class="k"><span class="g">Points</span>
        <span><i class="mk" style="background:${rgba(TP_OK, 1)}"></i>On its spot</span>
        <span><i class="mk" style="background:${rgba(TP_BAD, 1)}"></i>Off this frame</span>
        <span><i class="mk grey" style="background:#7a7a7a"></i>Not tracked here</span></div>
      <div class="k"><span class="g">Surface</span><span><i class="sq" style="border-color:${rgba(TRI_COL.ok, 1)};background:${rgba(TRI_COL.ok, 0.25)}"></i>Floor</span></div>
      <div class="k"><span class="g">Health</span>${health}</div>`;
  }
  _verdict(h) {
    const el = this.$(".verdict"), pop = this.$(".verdict-pop");
    if (!h.verdict) return;
    const V = VERDICT[h.verdict.level] || { col: [0.6, 0.6, 0.6], word: h.verdict.title };
    const [title, rest] = h.verdict.title.includes(":") ? h.verdict.title.split(/:\s*/, 2) : [V.word, ""];
    const n = h.spots.length;
    el.innerHTML = `<i class="dot" style="background:${rgba(V.col, 1)}"></i><b>${esc(title)}</b>${n ? `<span class="d">· ${n} spot${n > 1 ? "s" : ""} to check</span>` : ""}`;
    el.title = h.verdict.title;
    const spots = h.spots.map((s) => `<button data-go="${s.a}"><i class="dot" style="background:${rgba(this.d.Q[s.code], 1)}"></i>${s.a === s.b ? s.a : `${s.a}–${s.b}`}</button>`).join("");
    pop.innerHTML = `<h4><i class="dot" style="background:${rgba(V.col, 1)}"></i>${esc(h.verdict.title)}</h4>
      <dl>${[["Shot", h.scene], ["Track", h.summary], ["Lens", h.lens], ["Floor", h.floor], ["Note", h.skipped]].filter((x) => x[1]).map(([a, b]) => `<dt>${a}</dt><dd>${esc(b)}</dd>`).join("")}</dl>
      ${h.verdict.lines.map((t) => `<p>${esc(t)}</p>`).join("")}
      ${n ? `<div class="spots" aria-label="Jump to a spot">${spots}</div>` : ""}`;
    pop.querySelectorAll("[data-go]").forEach((b) => b.addEventListener("click", () => { this._go(+b.dataset.go); }));
    el.hidden = false;
  }
  _infoPop(f) {
    const d = this.d, j = d.j, lens = d.cam.lens[d.k(f)], hfov = (2 * Math.atan(d.hfovTan(lens)) * 180) / Math.PI;
    this.$(".info-pop").innerHTML = `<h4>${esc(d.cam.name || 'Perspectra_VideoCamera')}</h4><dl>
      <dt>Frame</dt><dd>${f} of ${d.playback.fs}–${d.playback.fe}</dd>
      <dt>Lens</dt><dd>${d.hasCamera(f) ? `${lens.toFixed(1)} mm · ${hfov.toFixed(1)}° horizontal · ${d.cam.sensor} mm sensor` : 'No camera estimate'}</dd>
      ${d.sampleNote(f) ? `<dt>Sampling</dt><dd>${esc(d.sampleNote(f))}</dd>` : ''}
      ${j.displayAlignment ? `<dt>Display alignment</dt><dd>${j.displayAlignment.reference ? `Shared ${esc(j.displayAlignment.reference)} scene reference; same starting camera and floor. ${j.displayAlignment.matchedPoints ? `${j.displayAlignment.matchedPoints} matching scene points set the relative scale. ` : ''}` : 'Same starting height and heading; floor at zero. '}Uniform scale ×${j.displayAlignment.scale.toFixed(3)}. Preview units, not measured metres. Lens and tracking differences remain visible.</dd>` : ''}
      <dt>Footage</dt><dd>${d.W}×${d.H} · ${+d.fps.toFixed(3)} fps</dd>
      ${j.preset ? `<dt>Processing mode</dt><dd>${esc(j.preset)}</dd>` : ''}
      ${this.mode !== "camera" ? `<dt>View</dt><dd>Scene overview (free camera)</dd>` : ""}</dl>`;
  }
  _statusLine(f) {
    const hasCamera = this.d.hasCamera(f);
    const health = this.d.j.health, q = health.q[this.d.k(f)];
    const label = !hasCamera ? 'No camera data' : q >= 0
      ? (this.d.j.healthReference || 'Track health') + ' · ' + (health.titles[q] || health.words[q])
      : 'Track health unavailable';
    const key = `${label}|${this.overlaysOn}|${this.v.health}`;
    if (key === this._stKey) return;
    this._stKey = key;
    const el = this.$(".status");
    el.hidden = hasCamera && !(this.overlaysOn && this.v.health);
    el.querySelector('.t').textContent = label;
    el.querySelector('.dot').style.background = hasCamera && this.d.Q[q] ? rgba(this.d.Q[q], 1) : '#aaa';
  }

  // ── controls ──────────────────────────────────────────────────────────────────────────────────────────────
  _ui() {
    const act = {
      play: () => { this._userPaused = this.pb.playing; this.pb.toggle(); },
      prev: () => this._step(-1), next: () => this._step(1),
      start: () => this._go(this.pb.d.fs), end: () => this._go(this.pb.d.fe),
      overlays: () => this.setOverlays(!this.overlaysOn),
      menu: () => this._togglePop(this.$(".overlay-pop"), this.$('[data-a="menu"]')),
      home: () => this._frameOverview(true),
      full: () => this._fullscreen(),
      cube: () => (this.cube ? this._togglePop(this.$(".cube-pop"), this.$('[data-a="cube"]')) : this._placeMode(true)),
    };
    this.$$("button[data-a]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); act[b.dataset.a](); }));
    this.$$("button[data-mode]").forEach((b) => {
      b.addEventListener("click", () => this.setMode(b.dataset.mode));
      b.addEventListener('keydown', e => {
        if (!['ArrowLeft','ArrowRight','Home','End'].includes(e.key)) return;
        e.preventDefault(); e.stopPropagation();
        const mode = e.key==='Home' ? 'camera' : e.key==='End' ? 'overview' : b.dataset.mode==='camera' ? 'overview' : 'camera';
        this.setMode(mode,false);this.$(`button[data-mode="${mode}"]`).focus();
      });
    });
    this.$$("input[data-v]").forEach((i) => i.addEventListener("change", () => this._setV(i.dataset.v, i.checked)));
    this.$$("[data-labels]").forEach((b) => b.addEventListener("click", (e) => { e.preventDefault(); this.labels = b.dataset.labels; this._syncMenu(); this.invalidate(); }));
    // popovers: info, verdict, help
    this.$$("[data-pop]").forEach((b) => {
      const pop = this.$("." + b.dataset.pop);
      const open = (e) => { e.stopPropagation(); if (b.dataset.pop === "info-pop") this._infoPop(this.pb.shown); this._togglePop(pop, b); };
      b.addEventListener("click", open);
      if (b.tagName !== 'BUTTON') b.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), open(e)));
    });
    this.shadowRoot.addEventListener("click", (e) => {
      const path = e.composedPath();
      this.$$(".pop.open").forEach((p) => { if (!path.includes(p) && !path.some((n) => n.dataset?.pop || n.dataset?.a === "menu")) this._closePop(p); });
    });
    // test cube panel: Scale / Rotation rebuild it about the corner it stands on (video_track.cube_refresh)
    const cs = this.$(".c-size"), cr = this.$(".c-rot");
    cs.value = this.d.cubeSize; cr.value = 0;
    const cubeUpd = () => {
      this.$(".o-size").textContent = `${(+cs.value).toFixed(2)} ${(this.d.j.displayAlignment || this.d.j.placement) ? 'units' : 'm'}`; this.$(".o-rot").textContent = `${cr.value}°`;
      if (this.cube) { this.cube.size = +cs.value; this.cube.rot = THREE.MathUtils.degToRad(+cr.value); this.s3.setCube(this.cube); this.invalidate(); }
    };
    cs.addEventListener("input", cubeUpd); cr.addEventListener("input", cubeUpd); cubeUpd();
    this.$$("[data-c]").forEach((b) => b.addEventListener("click", (e) => {
      e.stopPropagation(); this._closePop(this.$(".cube-pop"));
      if (b.dataset.c === "move") this._placeMode(true);
      else { this.cube = null; this.s3.setCube(null); this._cubeBtn(); this._flash('Test cube removed.'); this.invalidate(); }
    }));
    // frame field: type a frame, Enter / blur to go; arrows step
    const fin = this.$(".fin");
    const commit = () => { const n = parseInt(fin.value, 10); if (Number.isFinite(n)) this._go(n); else fin.value = this.pb.frame; };
    fin.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") { commit(); fin.blur(); }
      else if (e.key === "Escape") { fin.value = this.pb.frame; fin.blur(); }
      else if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); this._step(e.key === "ArrowUp" ? 1 : -1); fin.value = this.pb.frame; }
    });
    fin.addEventListener("blur", commit);
    fin.addEventListener("focus", () => fin.select());
    // PiP returns to the camera view
    const pip = this.$(".pip");
    pip.addEventListener("click", () => this.setMode("camera"));
    pip.addEventListener("keydown", (e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), this.setMode("camera")));
    // Keep selector gestures local while radio changes still reach the gallery.
    const selector = this.$(".viewport-selector");
    for (const type of ["pointerdown", "pointermove", "pointerup", "wheel", "dblclick"]) {
      selector.addEventListener(type, event => event.stopPropagation());
    }
    // hover / select in the viewport
    const st = this.$(".stage");
    let down = null;
    st.addEventListener("pointermove", (e) => {
      if (e.buttons && this.mode === "overview") { st.classList.add("dragging"); this._setHover(null); return; }
      if (this.placing) { this._setHover(null); return; }
      const r = st.getBoundingClientRect(); this._hoverAt(e.clientX - r.left, e.clientY - r.top);
    });
    st.addEventListener("pointerleave", () => this._setHover(null));
    st.addEventListener("pointerdown", (e) => { down = [e.clientX, e.clientY]; });
    st.addEventListener("pointerup", (e) => {
      st.classList.remove("dragging");
      if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4 || e.target.closest?.(".chip,.pip,.pop")) return;
      if (this.placing) { const r = st.getBoundingClientRect(); this._placeCube(e.clientX - r.left, e.clientY - r.top); return; }
      this.sel = this.hov ? { ...this.hov } : null; this.invalidate(); this._tip();
    });
    this.tabIndex = 0;
    this.addEventListener("keydown", (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // Native controls own their activation keys; Space must not toggle both
      // a focused control and playback, and popover inputs keep their arrows.
      if (e.key !== 'Escape' && e.composedPath().some(n => n.matches?.('button,input,select,textarea'))) return;
      const k = e.key;
      if (k === " ") { e.preventDefault(); act.play(); }
      else if (k === "ArrowLeft" || k === "ArrowRight") { e.preventDefault(); this._step((k === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 10 : 1)); }
      else if (k === "Home") { e.preventDefault(); this.mode === "camera" ? act.start() : act.home(); }
      else if (k === "End") { e.preventDefault(); act.end(); }
      else if (k === "h" || k === "H") act.overlays();
      else if (k === "c" || k === "C") this.setMode("camera");
      else if (k === "o" || k === "O") this.setMode("overview");
      else if (k === "f" || k === "F") act.full();
      else if (k === "l" || k === "L") { this.labels = { smart: "all", all: "off", off: "smart" }[this.labels]; this._syncMenu(); this.invalidate(); }
      else if (k === "t" || k === "T") act.cube();
      else if (k === "Escape") { this.$$(".pop.open").forEach((p) => this._closePop(p)); if (this.placing) this._placeMode(false); else { this.sel = null; this.invalidate(); } }
    });
    const syncFullscreen = () => {
      const on = document.fullscreenElement === (this.fullscreenTarget || this);
      this.toggleAttribute('expanded', on);
      const b = this.$('[data-a="full"]');
      b.innerHTML = on ? ICON.exitFull : ICON.full; b.dataset.tip = on ? "Exit fullscreen (F)" : "Fullscreen (F)";
      setTimeout(() => this._resize(), 50);
    };
    document.addEventListener("fullscreenchange", syncFullscreen, { signal: this._events.signal });
    syncFullscreen();
    if (!document.fullscreenEnabled) this.$('[data-a="full"]').hidden = true;
  }
  // ── test cube (video_track.place_test_cube) ────────────────────────────────────────────────────────────────
  _placeMode(on) {
    this.placing = on;
    this.$(".stage").classList.toggle("placing", on);
    this.$(".place-hint").classList.toggle("on", on);
    this._cubeBtn();
  }
  _cubeBtn() {
    const b = this.$('[data-a="cube"]');
    b.classList.toggle("on", this.placing || !!this.cube); b.setAttribute("aria-pressed", this.placing || !!this.cube);
    b.dataset.tip = this.cube ? "Test cube settings (T)" : "Test cube (T)";
  }
  /** A bottom corner exactly on the clicked spot, standing straight up (the scene's up), the corner nearest the
   *  camera and turned 45° to it so two sides show; a click on a wall / pillar face puts it on the floor below. */
  _placeCube(x, y) {
    if (!this.d.hasCamera(this.pb.shown)) { this._flash('Seek to a frame with a camera estimate before placing a test cube.'); return; }
    const camView = this.$(".stage").classList.contains("camera");
    const cam = camView ? this.s3.camCam : this.s3.ovCam;
    const ndc = new THREE.Vector2((x / this.sw) * 2 - 1, -(y / this.sh) * 2 + 1);
    const hit = this.s3.raycast(ndc, cam);
    if (!hit || hit.t > 200) { this._flash("Click on the floor, or on something standing on it, in front of the camera."); return; }
    const up = this.d.up.clone();
    let p = hit.p.clone(), where;
    if (hit.what !== "floor" && hit.n && Math.abs(hit.n.dot(up)) < 0.7) { p.z = 0; where = `On the floor below where you clicked (${hit.what} face)`; }
    else where = hit.what === "floor" ? "On the floor where you clicked" : `On the ${hit.what} where you clicked`;
    const camPos = this.s3.camCam.position.clone();                    // the tracked camera, also in the overview
    let fwd = p.clone().sub(camPos); fwd.addScaledVector(up, -fwd.dot(up));
    if (fwd.lengthSq() < 1e-10) fwd = new THREE.Vector3(0, 1, 0);
    fwd.normalize();
    const side = up.clone().cross(fwd).normalize();
    let axis = fwd.add(side).normalize();
    const sizeControl = this.$(".c-size"), rotationControl = this.$(".c-rot");
    if (hit.tread) {
      // Choose an inward-facing pair of edges so all four bottom corners fit on this tread.
      const [origin, right, front] = hit.tread;
      const along = right.clone().sub(origin), across = front.clone().sub(origin);
      const w = along.length(), h = across.length();
      along.normalize(); across.normalize();
      const delta = p.clone().sub(origin), x = delta.dot(along), y = delta.dot(across);
      if (x > w/2) along.negate();
      if (y > h/2) across.negate();
      axis = along.clone().cross(across).dot(up) > 0 ? along : across;
      const size = Math.min(+sizeControl.value, .6*h, Math.max(x,w-x), Math.max(y,h-y));
      sizeControl.min = Math.min(+sizeControl.min, size);
      sizeControl.step = "any"; sizeControl.value = size;
      rotationControl.value = 0;
      this.$(".o-size").textContent = size.toFixed(2) + " units";
      this.$(".o-rot").textContent = "0°";
    }
    this.cube = { corner:p, up, ax0:axis, size:+sizeControl.value, rot:THREE.MathUtils.degToRad(+rotationControl.value), where };
    this.s3.setCube(this.cube);
    this._placeMode(false);
    this.$(".cube-pop .where").textContent = `${where} · corner at ${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)} ${(this.d.j.displayAlignment || this.d.j.placement) ? 'preview units' : 'm'}`;
    this._flash('Cube placed. Play or scrub to check stability.');
    this.invalidate();
  }
  _flash(txt) {
    const h = this.$(".place-hint");
    h.textContent = txt; h.classList.add("on");
    clearTimeout(this._ft);
    this._ft = setTimeout(() => { h.classList.remove("on"); setTimeout(() => { h.innerHTML = "Click where the test cube should stand · <kbd>Esc</kbd> cancels"; }, 400); }, 3200);
  }
  _togglePop(pop, btn) {
    const open = !pop.classList.contains("open");
    this.$$(".pop.open").forEach((p) => this._closePop(p));
    if (open) { pop.classList.add("open"); btn?.setAttribute("aria-expanded", "true"); pop._btn = btn; }
  }
  _closePop(p) {
    const restoreFocus = p.contains(this.shadowRoot.activeElement);
    p.classList.remove("open"); p._btn?.setAttribute("aria-expanded", "false");
    if (restoreFocus) p._btn?.focus({preventScroll:true});
  }
  _syncMenu() {
    this.$$("input[data-v]").forEach((i) => (i.checked = !!this.v[i.dataset.v]));
    this.$$("[data-labels]").forEach((b) => { const on = b.dataset.labels === this.labels; b.classList.toggle("on", on); b.setAttribute("aria-checked", on); });
  }
  _setV(key, on) {
    this.v[key] = on;
    if (on && ["tpoints", "edges", "surfaces", "health", "cloud"].includes(key) && !this.overlaysOn) this.setOverlays(true);
    if (key === "lanes") { this.toggleAttribute("lanes", on); this.tl.lanes = on; this._resize(); }
    this._stKey = null; this.invalidate();
  }
  async _fullscreen() {
    const target = this.fullscreenTarget || this;
    try { document.fullscreenElement === target ? await document.exitFullscreen() : await target.requestFullscreen(); } catch (_) { /* refused: stay inline */ }
  }
  _playIcon() {
    const b = this.$('[data-a="play"]');
    b.innerHTML = this.pb.playing ? ICON.pause : ICON.play;
    b.classList.toggle("on", this.pb.playing);
    b.setAttribute("aria-label", this.pb.playing ? "Pause" : "Play"); b.dataset.tip = this.pb.playing ? "Pause (Space)" : "Play (Space)";
  }
  _step(n) { if (this.pb.playing) this.pb.pause(); this.pb.seek(this.pb.frame + n); }
  _go(f) { if (this.pb.playing) this.pb.pause(); this.pb.seek(f); }
  _scrub(f, phase) {
    if (phase === "start") { this._wasPlaying = this.pb.playing; if (this._wasPlaying) this.pb.pause(); }
    this.pb.seek(f);
    if (phase === "end" && this._wasPlaying) this.pb.play();
    this.invalidate();
  }
  setOverlays(on) {
    this.overlaysOn = on;
    const b = this.$('[data-a="overlays"]');
    b.classList.toggle("on", on); b.setAttribute("aria-pressed", on); b.innerHTML = on ? ICON.eye : ICON.eyeOff;
    if (!on) this._setHover(null);
    this._stKey = null; this.invalidate();
  }

  // ── hover, selection, tooltips ────────────────────────────────────────────────────────────────────────────
  _hoverAt(x, y) {
    let best = null, bd = 1e9;
    for (const p of this._picks) {
      let dist = 1e9;
      if (p.kind === "tp") dist = Math.hypot(x - p.p[0], y - p.p[1]) - p.r;
      else if (p.kind === "edge") dist = segDist(x, y, p.seg[0], p.seg[1]) - 3;
      else if (p.kind === "surf") dist = inTri(x, y, p.tri) ? 6 : 1e9;      // surfaces lose to points / edges on top
      if (dist < 5 && dist < bd) { bd = dist; best = p; }
    }
    this._mouse = [x, y];
    this._setHover(best ? { kind: best.kind, id: best.id, pick: best } : null);
  }
  _setHover(h) {
    const same = (h && this.hov && h.kind === this.hov.kind && h.id === this.hov.id) || (!h && !this.hov);
    this.hov = h;
    this.$(".stage").classList.toggle("hot", !!h);
    if (!same) this.invalidate();
    this._tip();
  }
  _tip() {
    const tip = this.$(".tip"), h = this.hov;
    if (!h || !this._mouse) { tip.classList.remove("on"); return; }
    const d = this.d, f = this.pb.shown;
    let html = "";
    if (h.kind === "tp") {
      const t = d.tpById.get(h.id), st = d.tpState(t, f), p = h.pick;
      const c = st === "ok" ? TP_OK : st === "off" ? TP_BAD : TP_OFF;
      const px = p && p.s && p.pr ? Math.hypot(p.s[0] - p.pr[0], p.s[1] - p.pr[1]) * d.W / this.rect.w : null;
      html = `<b><i class="dot" style="background:${rgba(c, 1)}"></i>T${t.id} · ${STATE_WORD[st]}</b>
        <span>${t.span ? `Tracked on ${t.count} frames, ${t.span[0]}–${t.span[1]}` : "Not tracked"}${t.keySet.has(f) ? " · key on this frame" : ""}</span>
        ${px != null && px > 0.5 ? `<span>${px.toFixed(1)} px from where its 3-D spot lands</span>` : ""}
        ${t.loose ? "<small>Its track jumped: shown, but not used to correct the camera.</small>" : ""}
        ${this.mode === "camera" && st === "gone" ? "<small>Grey: drawn where its 3-D spot lands with this camera.</small>" : ""}`;
    } else if (h.kind === "edge") {
      const e = d.edgeById.get(h.id), s = e.seg[d.k(f)];
      const word = s ? (s[4] === "g" ? "on its 3-D line" : s[4] === "r" ? "off its 3-D line" : "tracked") : "not tracked on this frame";
      html = `<b><i class="dot" style="background:${rgba(s ? EDGE_COL[s[4]] : EDGE_COL.n, 1)}"></i>${e.id} · ${word}</b>
        <span>Followed on ${e.count} frames${e.block ? ` · edge of ${esc(e.block.replace("Perspectra_Block_", ""))}` : ""}</span>
        ${s && s[5] >= 0 ? `<span>${s[5]} px from its 3-D line here</span>` : ""}
        ${e.line && !e.line.usable && e.line.why ? `<small>Not used by Fit: ${esc(e.line.why)}</small>` : !s ? "<small>Dashed: where its 3-D line lands with this camera.</small>" : ""}`;
    } else if (h.kind === "surf") {
      const s = d.surfById.get(h.id), st = ["", "ok", "off", "out"][s.st[d.k(f)]] || "out";
      const word = { ok: "all three points on their spots", off: "a point is off its spot, or the triangle isn't level", out: "switched off or outside its frames" }[st];
      html = `<b><i class="dot" style="background:${rgba(TRI_COL[st], 1)}"></i>${s.label} · ${s.floor ? "floor" : "surface"}</b>
        <span>${word}</span><span>Points ${s.tps.map((i) => "T" + i).join(", ")}${s.tilt != null ? ` · tilt ${s.tilt}°` : ""}</span>`;
    }
    tip.innerHTML = html + (this.sel && this.sel.kind === h.kind && this.sel.id === h.id ? "" : "<small>Click to select</small>");
    tip.classList.add("on");
    const st = this.$(".stage"), W = st.clientWidth, H = st.clientHeight, tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = this._mouse[0] + 14, y = this._mouse[1] + 14;
    if (x + tw > W - 6) x = this._mouse[0] - tw - 14;
    if (y + th > H - 6) y = this._mouse[1] - th - 14;
    tip.style.left = `${Math.max(6, x)}px`; tip.style.top = `${Math.max(6, y)}px`;
  }

  // ── modes ─────────────────────────────────────────────────────────────────────────────────────────────────
  /** Switch view without touching playback: the clock (video) keeps running. Layout and controls stay put. */
  setMode(mode, animate = true) {
    if (this.d && !this.d.hasCamera(this.pb.shown)) animate = false;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) animate = false;
    if (mode === this.mode && !this._fly) return;
    const from = this.mode;
    this.mode = mode;
    if (mode === "overview" && this.d.j.primitivePreview) this._frameOverview(false);
    this.$$("button[data-mode]").forEach((b) => { const on = b.dataset.mode === mode; b.classList.toggle("on", on); b.setAttribute("aria-selected", on); b.tabIndex=on?0:-1; });
    this.$('[data-a="home"]').disabled = mode !== "overview";
    this.rig.enabled = mode === "overview";
    if (mode === "camera") this._hideHint();
    this._setHover(null);
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (animate && !reduce && from !== mode) this._startFly(mode); else this._applyMode();
    if (mode === "overview" && !this._hinted) { this._hinted = true; this._showHint(); }
  }
  _showHint() { const h = this.$(".hint"); h.classList.add("on"); clearTimeout(this._ht); this._ht = setTimeout(() => this._hideHint(), 4500); }
  _hideHint() { this.$(".hint").classList.remove("on"); }
  _applyMode() {
    const st = this.$(".stage");
    const ov = this.mode === "overview" || !!this._fly;
    st.classList.toggle("camera", !ov); st.classList.toggle("overview", ov);
    const v = this.$(".main-video"), pip = this.$(".pip");
    // Keep the media node attached in one place; reparenting can restart playback.
    v.classList.toggle("pip-video", ov);
    this._layoutVideo();
    this.invalidate();
  }
  _startFly(to) {
    const camPose = () => { const c = this.s3.camCam; return { pos: c.position.clone(), quat: c.quaternion.clone(), fov: this._camVFov() }; };
    const ovPose = () => ({ ...this.rig.pose(), fov: 38 });
    this._fly = { t0: performance.now(), dur: 700, a: to === "overview" ? camPose : ovPose, b: to === "overview" ? ovPose : camPose };
    this._applyMode();
  }
  _camVFov() {
    const d = this.d, r = this.rect;
    const tanH = d.hfovTan(this.s3.lens || d.cam.lens[0]) * (d.H / d.W) * (this.sh / r.h);
    return THREE.MathUtils.radToDeg(2 * Math.atan(tanH));
  }
  _frameOverview(animate) {
    const s3 = this.s3, b = s3.bounds, c = b.getCenter(new THREE.Vector3()), size = b.getSize(new THREE.Vector3());
    const d = this.d, mid = d.pose(Math.round((d.fs + d.fe) / 2));
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(...mid.q));
    this.rig.target.copy(c).setZ(Math.max(0, c.z * 0.6));
    this.rig.r = Math.max(size.x, size.y, size.z * 1.5) * 1.05 + 1.5;
    if (d.j.platform || d.j.skeletons) this.rig.target.copy(c);
    if (d.j.handTracks) this.rig.r = Math.max(.16, size.length() * 1.8);
    if (d.j.variant === 'cabin') {
      this.rig.target.copy(c);
      this.rig.r = Math.max(.35, size.length() * 1.7);
    }
    if (d.j.displayAlignment) {
      this.rig.target.copy(c);
      const halfFov = Math.min(19 * Math.PI / 180, Math.atan(Math.tan(19 * Math.PI / 180) * this.s3.ovCam.aspect));
      this.rig.r = Math.max(3, size.length() / 2 / Math.sin(halfFov) * 1.1);
    }
    this.rig.az = Math.atan2(-fwd.y, -fwd.x) + 0.75;               // behind and to the side of the average view
    this.rig.el_ = 0.62;
    if (d.j.skeletons) {
      // Start near the footage angle so adjacent performers have distinct silhouettes.
      this.rig.az = Math.atan2(-fwd.y, -fwd.x) - .12;
      this.rig.el_ = .12;
    }
    if (d.j.primitivePreview) {
      // Fit the swept mesh and camera bounds to the area left of the footage inset.
      this.rig.target.copy(c);
      const orientation = this.rig.pose().quat;
      const inverse = orientation.clone().invert();
      const tanY = Math.tan(THREE.MathUtils.degToRad(19)), tanX = tanY * s3.ovCam.aspect;
      let distance = .35;
      for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) {
        const v = new THREE.Vector3(x,y,z).sub(c).applyQuaternion(inverse);
        distance = Math.max(distance, v.z + Math.abs(v.y) / (.82 * tanY),
          (.90 * v.z - v.x / tanX) / .64, (.38 * v.z + v.x / tanX) / .64);
      }
      this.rig.r = distance;
      this.rig.target.addScaledVector(new THREE.Vector3(1,0,0).applyQuaternion(orientation), .26 * distance * tanX);
    }
    if (this.mode === "overview") this.rig.apply(); else { const p = this.rig.pose(); s3.ovCam.position.copy(p.pos); s3.ovCam.quaternion.copy(p.quat); }
    if (animate) this.invalidate();
  }
  _resize() {
    if (!this.d) return;
    const st = this.$(".stage"), w = st.clientWidth, h = st.clientHeight, dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (!w || !h) return; // The gallery can hide this example.
    this.sw = w; this.sh = h;
    // the picture: as large as possible, with room for the info chips above and the health strip + status below
    const d = this.d, side = 10, top = 38, bot = 50;
    let fw = w - 2 * side, fh = fw * d.H / d.W;
    if (fh > h - top - bot) { fh = h - top - bot; fw = fh * d.W / d.H; }
    this.rect = { x0: (w - fw) / 2, y0: top + (h - top - bot - fh) / 2, w: fw, h: fh };
    this.s3.renderer.setPixelRatio(dpr); this.s3.renderer.setSize(w, h, false);
    const aspectChanged = this.s3.ovCam.aspect !== w / h;
    this.s3.ovCam.aspect = w / h; this.s3.ovCam.updateProjectionMatrix();
    if (aspectChanged && this.mode === 'overview' && this.d.j.primitivePreview) this._frameOverview(false);
    this.ov.resize(w, h, dpr);
    const tc = this.$(".tl");
    this.tl.resize(tc.clientWidth, tc.clientHeight, dpr);
    this._layoutVideo();
    this.invalidate();
  }
  _layoutVideo() {
    const v = this.$(".main-video"), r = this.rect;
    if (!r) return;
    if (v.classList.contains("pip-video")) Object.assign(v.style, { left: "", top: "", width: "", height: "" });
    else Object.assign(v.style, { left: `${r.x0}px`, top: `${r.y0}px`, width: `${r.w}px`, height: `${r.h}px` });
    if (this.rectified) {
      const show=this.mode==='camera';this.rectified.canvas.hidden=!show;v.style.opacity=show?'0':'1';
      Object.assign(this.rectified.canvas.style,{left:`${r.x0}px`,top:`${r.y0}px`,width:`${r.w}px`,height:`${r.h}px`});
    }
  }
  /** Projection of the tracked camera so that its picture lands exactly on the footage rectangle (Blender's camera
   *  view with the passepartout around it): an off-centre frustum built from the lens and the sensor width. */
  _cameraProjection(lens) {
    const d = this.d, r = this.rect, cam = this.s3.camCam, n = 0.02, far = 2000;
    const hw = n * d.hfovTan(lens), hh = hw * d.H / d.W, s = (2 * hw) / r.w;
    const L = -hw - r.x0 * s, R = hw + (this.sw - r.x0 - r.w) * s, T = hh + r.y0 * s, B = -hh - (this.sh - r.y0 - r.h) * s;
    cam.projectionMatrix.makePerspective(L, R, T, B, n, far);
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
  }
  invalidate() { if (this.isConnected && !this._raf) this._raf = requestAnimationFrame(() => { this._raf = 0; this._render(); }); }
  _drawLocalFilm(video, camera) {
    const plane = this.s3.camPlane, g = this.ov.g;
    const corners = [[-.5,.5],[.5,.5],[-.5,-.5],[.5,-.5]].map(([x,y]) =>
      plane.localToWorld(new THREE.Vector3(x,y,0)).project(camera));
    if (corners.some(p => p.z < -1 || p.z > 1)) return;
    const screen = corners.map(p => [(p.x+1)*this.sw/2,(1-p.y)*this.sh/2]);
    // Map the two triangles of the frustum screen without reading protected pixels.
    for (const [a,b,c,reverse] of [[0,1,2,false],[3,2,1,true]]) {
      const [x,y] = screen[a], [bx,by] = screen[b], [cx,cy] = screen[c];
      g.save();
      g.transform(bx-x,by-y,cx-x,cy-y,x,y);
      g.beginPath(); g.moveTo(0,0); g.lineTo(1,0); g.lineTo(0,1); g.closePath(); g.clip();
      if (reverse) g.transform(-1,0,0,-1,1,1);
      g.drawImage(video,0,0,1,1);
      g.restore();
    }
  }
  _render() {
    const d = this.d, pb = this.pb;
    if (!d || !this.rect) return;
    if (this.rectified && pb.v.readyState>=2) this.rectified.render();
    const f = pb.shown;                                   // everything follows the frame the footage shows
    const hasCamera = d.hasCamera(f);
    if (hasCamera) this.s3.update(f, this.sel);
    this._cameraProjection(this.s3.lens);
    let cam = this.s3.camCam;
    const st = this.$(".stage");
    if (this._fly) {
      const t = Math.min(1, (performance.now() - this._fly.t0) / this._fly.dur), e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const a = this._fly.a(), b = this._fly.b(), oc = this.s3.ovCam;
      oc.position.lerpVectors(a.pos, b.pos, e); oc.quaternion.slerpQuaternions(a.quat, b.quat, e);
      oc.fov = a.fov + (b.fov - a.fov) * e; oc.updateProjectionMatrix(); oc.updateMatrixWorld();
      cam = oc;
      if (t >= 1) { this._fly = null; if (this.mode === "overview") this.rig.apply(); this._applyMode(); }
      else this.invalidate();
    } else if (this.mode === "overview") cam = this.s3.ovCam;
    const camView = st.classList.contains("camera");
    const show = this.overlaysOn ? this.v : { ...this.v, tpoints: false, edges: false, surfaces: false, health: false };
    this.s3.apply(camView ? "camera" : "overview", { ...show, track: this.overlaysOn, cube: !!this.cube });
    if (!hasCamera) {
      // An overview may retain the static scene, but never a stale active camera.
      this.s3.g.cam.visible = false;
      if (camView) Object.values(this.s3.g).forEach(group => { group.visible = false; });
    }
    if (d.j.primitivePreview && camView) {
      // Clip fitted geometry to the recorded image, including portrait and letterboxed footage.
      const renderer = this.s3.renderer, r = this.rect;
      renderer.clear();
      renderer.setScissor(r.x0, this.sh - r.y0 - r.h, r.w, r.h);
      renderer.setScissorTest(true);
      this.s3.render(cam);
      renderer.setScissorTest(false);
    } else this.s3.render(cam);
    // 2-D layer
    const ov = this.ov;
    ov.clear();
    if (this.s3.localFilm && !camView && this.s3.g.cam.visible && pb.v.readyState >= 2) {
      this._drawLocalFilm(pb.v, cam);
    }
    const opt = { show, sel: this.sel, hov: this.hov, labels: this.labels };
    if (!hasCamera) {
      this._picks = []; this._setHover(null);
    } else if (camView) {
      const V = { d, rect: this.rect, project: (X) => this._proj(X, this.s3.camCam), inFront: (X, m) => this._inFront(X, m), projectLine: (X0, dv, span) => this._projLine(X0, dv, span) };
      this._picks = this.overlaysOn ? ov.drawCamera(V, f, opt) : [];
      const samples = this.cube?.measured && this.overlaysOn && d.j.cubeAnchor?.observations;
      let observed = samples?.[f];
      if (!observed && !d.j.cubeAnchor?.measuredOnly && samples?.[f-1] && samples[f+1]) {
        observed = samples[f-1].map((value, axis) => (value + samples[f+1][axis]) / 2);
      }
      if (observed) {
        const r = this.rect;
        ov._ring(r.x0 + observed[0] * r.w, r.y0 + observed[1] * r.h, 4, '#71f4dc', 1.5);
      }
      if (show.health) ov.drawHealthStrip(d, this.rect, f);
    } else if (!this._fly) {
      const V = { d, project: (X) => this._proj(X, this.s3.ovCam, true), surfList: this.s3.surfList, edgeEnds: this.s3.edgeEnds };
      this._picks = this.overlaysOn ? ov.drawOverview(V, f, opt) : [];
    } else this._picks = [];
    this.$(".fn").textContent = f;
    if (d.j.comparison === 'rig') {
      const first = this.startOrientation ||= new THREE.Quaternion().fromArray(d.cam.quat).normalize();
      const degrees = THREE.MathUtils.radToDeg(first.angleTo(this.s3.camCam.quaternion.clone().normalize()));
      this.$(".fn").textContent = f + ' · ' + degrees.toFixed(2) + '° from frame 1';
    }
    this._statusLine(f);
    const fin = this.$(".fin");
    if (this.shadowRoot.activeElement !== fin) fin.value = pb.frame;
    if (this.hov) this._tip();
    this.tl.frame = pb.frame; this.tl.draw();
  }
  _proj(X, cam, free = false) {
    if (!free && !this._inFront(X, 1e-3)) return null;
    const v = X.clone().project(cam);
    if (free && (v.z > 1 || v.z < -1)) return null;
    return [(v.x + 1) / 2 * this.sw, (1 - v.y) / 2 * this.sh];
  }
  _inFront(X, m) {
    const c = this.s3.camCam, fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(c.quaternion);
    return fwd.dot(X.clone().sub(c.position)) > m;
  }
  _projLine(X0, dv, span) {                                    // video_edges._project_line: 24 samples, in front only
    const out = [];
    for (let i = 0; i < 24; i++) {
      const X = X0.clone().addScaledVector(dv, -span + (2 * span * i) / 23);
      if (this._inFront(X, 0.3 * span / 6)) { const p = this._proj(X, this.s3.camCam); if (p) out.push(p); }
    }
    return out;
  }
}
function segDist(x, y, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = dx * dx + dy * dy || 1;
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L));
  return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
}
function inTri(x, y, [a, b, c]) {
  const s = (p, q, r) => (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1]);
  const P = [x, y], d1 = s(P, a, b), d2 = s(P, b, c), d3 = s(P, c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

customElements.define("perspectra-preview", PerspectraPreview);
})();
