/* particles.js — animated wind-particle flow layer for Leaflet.
 *
 * A 2D-canvas particle advection layer (earth.nullschool style), adapted from
 * TC-ATLAS realtime_seasonal.js (_evoParticleTick) + the realtime_ir.js canvas
 * overlay pattern. Particles are advected on the ambient deep-layer-mean
 * steering field (Model.ambientUV) sampled at a settable time, so the flow
 * evolves as the storm marches forward through the dealt month. The wind data
 * is already in memory (loaded when a round is dealt), so this costs zero
 * network calls — only canvas CPU.
 */
(function () {
  'use strict';

  var TRAIL = 8;           // ring-buffer history positions per particle
  var MAX_AGE = 90;        // frames before respawn
  var AGE_JIT = 0.4;       // +/- lifetime jitter (desync respawn cohorts)
  var STEP_DEG = 0.022;    // deg advanced per (m/s) per frame (tuned for ~30 fps)
  var ERASE = 0.10;        // per-frame trail decay (destination-out alpha)
  var MIN_MS = 0.3;        // calm threshold (respawn below this)
  var SPEED_NORM = 14;     // m/s that saturates trail opacity
  var FADE_IN = 8, FADE_OUT = 12;
  var FRAME_MS = 30;       // ~30 fps cap
  var DEG2RAD = Math.PI / 180;

  // Storm vortex blended into the ambient flow while a storm animates (set via
  // setStorm): a modified-Rankine tangential wind + ~24° inflow, so particles
  // visibly wrap into and spiral around the cyclone as it intensifies.
  var VORTEX_R = 6.5;      // deg — outer influence radius
  var VORTEX_RMW = 0.5;    // deg — radius of maximum wind
  var VORTEX_DECAY = 0.65; // outer-profile exponent: vt ~ (rmw/r)^decay
  var VORTEX_VCAP = 22;    // m/s advection cap (full speed would overshoot at 30 fps)
  var EYE_R = 0.22;        // deg — particles reaching the eye respawn elsewhere
  var INFLOW_COS = 0.91, INFLOW_SIN = 0.42;   // ~24° inward-spiral angle

  var ParticleLayer = L.Layer.extend({
    initialize: function () {
      this._env = null; this._t = 0; this._raf = null;
      this._running = false; this._lastMs = 0;
      this._storm = null; this._N = 0;
    },
    setField: function (env) { this._env = env; return this; },
    setTime: function (t) { this._t = t; return this; },
    // storm = {lat, lon, v(kt)} or null. Weak disturbances barely swirl;
    // ignore below ~20 kt so the pick-stage flow stays purely ambient.
    setStorm: function (s) { this._storm = (s && s.v > 20) ? s : null; return this; },

    onAdd: function (map) {
      this._map = map;
      var pane = map.getPane('flowPane');
      if (!pane) {
        pane = map.createPane('flowPane');
        pane.style.zIndex = 350;            // above tiles, below tracks/markers
        pane.style.pointerEvents = 'none';
      }
      var c = L.DomUtil.create('canvas', 'leaflet-flow-canvas');
      c.style.position = 'absolute'; c.style.pointerEvents = 'none';
      pane.appendChild(c);
      this._canvas = c; this._ctx = c.getContext('2d');
      this._reset();
      map.on('moveend zoomend resize', this._reset, this);
      map.on('movestart zoomstart', this._clear, this);
      this._running = true; this._loop();
      return this;
    },

    onRemove: function (map) {
      this._running = false;
      if (this._raf) cancelAnimationFrame(this._raf);
      map.off('moveend zoomend resize', this._reset, this);
      map.off('movestart zoomstart', this._clear, this);
      if (this._canvas && this._canvas.parentNode) this._canvas.parentNode.removeChild(this._canvas);
      this._canvas = this._ctx = null;
      return this;
    },

    _initParts: function (n) {
      this._N = n;
      this._p = {
        lat: new Float32Array(n), lon: new Float32Array(n),
        age: new Float32Array(n), life: new Float32Array(n),
        tlat: new Float32Array(n * TRAIL), tlon: new Float32Array(n * TRAIL),
        head: new Int16Array(n),
      };
    },

    _clear: function () {
      if (!this._ctx) return;
      var s = this._map.getSize();
      this._ctx.clearRect(0, 0, s.x, s.y);
    },

    _reset: function () {
      if (!this._canvas) return;
      var map = this._map, size = map.getSize(), dpr = window.devicePixelRatio || 1;
      var c = this._canvas;
      c.width = size.x * dpr; c.height = size.y * dpr;
      c.style.width = size.x + 'px'; c.style.height = size.y + 'px';
      L.DomUtil.setPosition(c, map.containerPointToLayerPoint([0, 0]));
      this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Particle density follows viewport area (one per ~1100 css px²), so a
      // phone isn't overcrowded and a big desktop window isn't sparse.
      var n = Math.max(450, Math.min(1500, Math.round(size.x * size.y / 1100)));
      if (!this._p || Math.abs(n - this._N) > this._N * 0.2) this._initParts(n);
      for (var i = 0; i < this._N; i++) { this._spawn(i); this._p.age[i] = Math.random() * MAX_AGE; }
    },

    _spawn: function (i) {
      var b = this._map.getBounds(), p = this._p;
      var lat = b.getSouth() + Math.random() * (b.getNorth() - b.getSouth());
      var lon = b.getWest() + Math.random() * (b.getEast() - b.getWest());
      p.lat[i] = lat; p.lon[i] = lon; p.age[i] = 0;
      p.life[i] = MAX_AGE * (1 - AGE_JIT + 2 * AGE_JIT * Math.random());
      var base = i * TRAIL;
      for (var t = 0; t < TRAIL; t++) { p.tlat[base + t] = lat; p.tlon[base + t] = lon; }
      p.head[i] = 0;
    },

    _loop: function () {
      if (!this._running) return;
      var self = this;
      this._raf = requestAnimationFrame(function (ts) { self._tick(ts); self._loop(); });
    },

    _tick: function (ts) {
      if (!this._env || !this._ctx) return;
      if (ts - this._lastMs < FRAME_MS) return;
      this._lastMs = ts;
      var ctx = this._ctx, map = this._map, size = map.getSize(), p = this._p, b = map.getBounds();

      // Fade existing trails.
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = 'rgba(0,0,0,' + ERASE + ')';
      ctx.fillRect(0, 0, size.x, size.y);
      ctx.globalCompositeOperation = 'source-over';
      ctx.lineCap = 'round';

      var st = this._storm, stCos = 0, stVm = 0;
      if (st) {
        stCos = Math.cos(st.lat * DEG2RAD);
        stVm = Math.min(st.v, 120) * 0.5144;   // kt -> m/s, capped
      }

      for (var i = 0; i < this._N; i++) {
        var age = p.age[i];
        if (age >= p.life[i]) { this._spawn(i); continue; }
        var lat = p.lat[i], lon = p.lon[i];
        var uv = Model.ambientUV(this._env, this._t, lat, lon);
        if (!uv) { this._spawn(i); continue; }
        var u = uv.u, v = uv.v;
        // Blend in the storm's vortex: tangential (CCW, Northern Hemisphere)
        // + inflow, tapering to zero at the outer radius.
        if (st) {
          var dx = (lon - st.lon) * stCos, dy = lat - st.lat;
          var r = Math.sqrt(dx * dx + dy * dy);
          if (r < EYE_R) { this._spawn(i); continue; }   // spiralled into the eye
          if (r < VORTEX_R) {
            var vt = r < VORTEX_RMW ? stVm * (r / VORTEX_RMW)
                                    : stVm * Math.pow(VORTEX_RMW / r, VORTEX_DECAY);
            vt *= Math.min(1, (VORTEX_R - r) / 1.5);
            if (vt > VORTEX_VCAP) vt = VORTEX_VCAP;
            var rx = dx / r, ry = dy / r;
            u += vt * (-ry * INFLOW_COS - rx * INFLOW_SIN);
            v += vt * (rx * INFLOW_COS - ry * INFLOW_SIN);
          }
        }
        var spd = Math.sqrt(u * u + v * v);
        if (spd < MIN_MS) { this._spawn(i); continue; }
        var cosl = Math.cos(lat * DEG2RAD); if (cosl < 0.05) cosl = 0.05;
        var nlat = lat + v * STEP_DEG, nlon = lon + (u / cosl) * STEP_DEG;
        if (nlat > b.getNorth() + 1 || nlat < b.getSouth() - 1 ||
            nlon > b.getEast() + 1 || nlon < b.getWest() - 1) { this._spawn(i); continue; }

        var head = (p.head[i] + 1) % TRAIL; p.head[i] = head;
        var base = i * TRAIL;
        p.tlat[base + head] = nlat; p.tlon[base + head] = nlon;
        p.lat[i] = nlat; p.lon[i] = nlon; p.age[i] = age + 1;
        if (age < 1) continue;

        var fast = Math.min(1, spd / SPEED_NORM);
        var sa = 0.25 + 0.6 * fast;
        var af = 1;
        if (age < FADE_IN) af = age / FADE_IN;
        else if (age > p.life[i] - FADE_OUT) af = Math.max(0, (p.life[i] - age) / FADE_OUT);
        ctx.lineWidth = 0.8 + 0.7 * fast;   // fast air draws a bolder streak
        ctx.strokeStyle = 'rgba(190,225,255,' + (sa * af).toFixed(3) + ')';
        ctx.beginPath();
        var pt = map.latLngToContainerPoint([nlat, nlon]), px = pt.x, py = pt.y;
        for (var k = 1; k < TRAIL; k++) {
          var idx = (head - k + TRAIL) % TRAIL;
          var q = map.latLngToContainerPoint([p.tlat[base + idx], p.tlon[base + idx]]);
          ctx.moveTo(px, py); ctx.lineTo(q.x, q.y); px = q.x; py = q.y;
        }
        ctx.stroke();
      }
    },
  });

  window.ParticleLayer = ParticleLayer;
})();
