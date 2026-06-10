/* fields.js — viewport-resolution shaded scalar-field layer (canvas).
 *
 * Replaces the old whole-world Mercator-warped L.imageOverlay (360 px wide for
 * the entire globe — ~1 px per degree, hopelessly blurry once stretched across
 * a retina phone). Instead, every render samples the field bilinearly for each
 * canvas pixel of the CURRENT viewport (earth.nullschool style), so the shading
 * is crisp at any zoom and the work scales with the screen, not the world.
 *
 * TIME is continuous: the layer keeps two canvases — day D and day D+1 — and
 * blends them per frame with alpha-correct weights (back over front), so the
 * field EVOLVES smoothly through the storm animation. Pixels re-render only
 * when the integer day changes (the old "tomorrow" canvas is reused as the new
 * "today" by swapping roles); every other frame just updates two opacities.
 *
 * Renders are kept off the critical path: per-render lat/lon arrays are
 * precomputed once (not per pixel), the day-D+1 canvas is rendered in row
 * CHUNKS across animation frames (it is invisible until complete, so a late
 * finish costs nothing), and touch devices skip DPR supersampling — fluid
 * playback beats the last notch of sharpness on a phone.
 */
(function () {
  'use strict';

  var MAX_SAMPLES = 480000;   // sampling budget per render
  var CHUNK_ROWS_PX = 130000; // ~samples per chunked slice (one slice per frame)
  var COARSE = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;

  var FieldLayer = L.Layer.extend({
    // opts: sample(lat, lon, day) -> value at an INTEGER day (NaN = transparent),
    //       color(value) -> [r,g,b,a], opacity, pane
    initialize: function (opts) {
      opts = opts || {};
      this._sample = opts.sample;
      this._color = opts.color;
      this._opacity = opts.opacity != null ? opts.opacity : 0.6;
      this._paneName = opts.pane || 'overlayPane';
      this._t = 0;
      this._day0 = null;      // integer day held by the front canvas
      this._day1 = null;      // integer day held by the back canvas (null = stale)
      this._geom = null;      // cached viewport geometry + lat/lon sample arrays
      this._chunk = null;     // in-flight chunked back render {day, raf}
    },

    // t may be fractional; the fraction crossfades day floor(t) -> floor(t)+1.
    setTime: function (t) {
      this._t = t;
      if (!this._map) return this;
      var d0 = Math.floor(t), f = t - d0;
      if (this._day0 !== d0) {
        this._cancelChunk();
        if (this._day1 === d0) {            // crossed midnight: tomorrow becomes today
          this._front = 1 - this._front;
          this._day0 = d0; this._day1 = null;
        } else {
          this._renderSync(this._front, d0);
          this._day0 = d0; this._day1 = null;
        }
      }
      if (f > 0.001 && this._day1 !== d0 + 1 && !(this._chunk && this._chunk.day === d0 + 1)) {
        this._renderChunked(1 - this._front, d0 + 1);
      }
      this._applyBlend(f);
      return this;
    },

    onAdd: function (map) {
      this._map = map;
      var pane = map.getPane(this._paneName) || map.createPane(this._paneName);
      this._cv = []; this._cx = []; this._front = 0;
      for (var k = 0; k < 2; k++) {
        var c = L.DomUtil.create('canvas', 'leaflet-field-canvas');
        c.style.position = 'absolute'; c.style.pointerEvents = 'none';
        c.style.opacity = 0;
        pane.appendChild(c);
        this._cv.push(c); this._cx.push(c.getContext('2d'));
      }
      map.on('moveend zoomend resize', this._redraw, this);
      // Scale/position the canvases through zooms (buttons, double-tap, pinch)
      // so the field tracks the basemap instead of blinking out and back.
      map.on('zoomanim', this._onZoomAnim, this);
      map.on('zoom', this._onZoom, this);
      this._redraw();
      return this;
    },

    onRemove: function (map) {
      this._cancelChunk();
      map.off('moveend zoomend resize', this._redraw, this);
      map.off('zoomanim', this._onZoomAnim, this);
      map.off('zoom', this._onZoom, this);
      (this._cv || []).forEach(function (c) { if (c.parentNode) c.parentNode.removeChild(c); });
      this._cv = this._cx = null;
      this._map = null;
      this._day0 = this._day1 = null;
      this._geom = null;
      return this;
    },

    // Animated zoom (setZoom / double-tap): project the rendered top-left
    // corner into the target view and scale.
    _onZoomAnim: function (e) {
      var g = this._geom;
      if (!this._cv || !g) return;
      var map = this._map;
      var scale = map.getZoomScale(e.zoom, g.zoom);
      var pos = map._latLngToNewLayerPoint(g.nw, e.zoom, e.center);
      this._cv.forEach(function (c) { L.DomUtil.setTransform(c, pos, scale); });
    },
    // Continuous (pinch) zoom: same idea against the live fractional zoom.
    _onZoom: function () {
      var g = this._geom;
      if (!this._cv || !g || this._map._animatingZoom) return;
      var map = this._map;
      var scale = map.getZoomScale(map.getZoom(), g.zoom);
      var pos = map.latLngToLayerPoint(g.nw);
      this._cv.forEach(function (c) { L.DomUtil.setTransform(c, pos, scale); });
    },

    // Alpha-correct two-canvas blend at total layer opacity p: back (day D+1,
    // stacked on top) gets p·f; front gets p(1-f)/(1-p·f), so the composite
    // weight of each day is exactly lerp(f) and the TOTAL opacity over the
    // basemap stays p for every f — no darkening pulse through the day.
    _applyBlend: function (f) {
      var p = this._opacity;
      var front = this._cv[this._front], back = this._cv[1 - this._front];
      var hasBack = this._day1 === Math.floor(this._t) + 1 && f > 0.001;
      front.style.zIndex = 0; back.style.zIndex = 1;
      var b = hasBack ? p * f : 0;
      front.style.opacity = hasBack ? p * (1 - f) / (1 - b) : p;
      back.style.opacity = b;
    },

    // Geometry refresh (pan/zoom/resize/add): rebuild the sample grids and
    // re-render ONLY the front canvas now — one render per camera move. The
    // back day is rebuilt chunked by the next setTime tick; until it lands the
    // blend shows the front day alone at full layer opacity.
    _redraw: function () {
      if (!this._cv) return;
      this._cancelChunk();
      this._rebuildGeom();
      var d0 = Math.floor(this._t), f = this._t - d0;
      this._renderSync(this._front, d0);
      this._day0 = d0; this._day1 = null;
      this._applyBlend(f);
    },

    // Viewport geometry, computed once per camera change and shared by both
    // canvases (and all chunks): per-row latitudes, per-column wrapped
    // longitudes, canvas size, and the zoom-transform reference.
    _rebuildGeom: function () {
      var map = this._map, size = map.getSize();
      var dpr = window.devicePixelRatio || 1;
      // No supersampling on touch devices: halves the work for a sliver of
      // sharpness no one can see mid-animation on a phone.
      var scale = Math.min(COARSE ? 1 : 2, dpr, Math.sqrt(MAX_SAMPLES / (size.x * size.y)));
      var w = Math.max(2, Math.round(size.x * scale)), h = Math.max(2, Math.round(size.y * scale));
      var lats = new Float64Array(h), lons = new Float64Array(w);
      var west = map.containerPointToLatLng([0, 0]).lng;
      var east = map.containerPointToLatLng([size.x, 0]).lng;
      for (var j = 0; j < h; j++) lats[j] = map.containerPointToLatLng([0, (j + 0.5) * size.y / h]).lat;
      for (var i = 0; i < w; i++) {
        var lon = west + (east - west) * (i + 0.5) / w;
        lons[i] = ((lon + 180) % 360 + 360) % 360 - 180;   // wrap to the data's [-180,180)
      }
      this._geom = {
        w: w, h: h, cssW: size.x, cssH: size.y, lats: lats, lons: lons,
        origin: map.containerPointToLayerPoint([0, 0]),
        nw: map.containerPointToLatLng([0, 0]),
        zoom: map.getZoom(),
      };
    },

    _prepCanvas: function (idx) {
      var g = this._geom, c = this._cv[idx];
      c.width = g.w; c.height = g.h;
      c.style.width = g.cssW + 'px'; c.style.height = g.cssH + 'px';
      c.style.visibility = '';
      L.DomUtil.setPosition(c, g.origin);
    },

    // Fill rows [y0, y1) for `day` into a fresh ImageData strip.
    _fillRows: function (y0, y1, day) {
      var g = this._geom, w = g.w, lats = g.lats, lons = g.lons;
      var sample = this._sample, color = this._color;
      var img = this._cx[0].createImageData(w, y1 - y0), d = img.data, o = 0;
      for (var j = y0; j < y1; j++) {
        var lat = lats[j];
        for (var i = 0; i < w; i++) {
          var col = color(sample(lat, lons[i], day));
          d[o] = col[0]; d[o + 1] = col[1]; d[o + 2] = col[2]; d[o + 3] = col[3];
          o += 4;
        }
      }
      return img;
    },

    _renderSync: function (idx, day) {
      if (!this._cv || !this._sample) return;
      if (!this._geom) this._rebuildGeom();
      this._prepCanvas(idx);
      this._cx[idx].putImageData(this._fillRows(0, this._geom.h, day), 0, 0);
    },

    // Render the (hidden) back canvas a slice per animation frame — the blend
    // only picks it up once _day1 is set, so a late finish is invisible.
    _renderChunked: function (idx, day) {
      if (!this._cv || !this._sample) return;
      if (!this._geom) this._rebuildGeom();
      this._cancelChunk();
      this._prepCanvas(idx);
      var self = this, g = this._geom;
      var rows = Math.max(8, Math.round(CHUNK_ROWS_PX / g.w)), y = 0;
      var chunk = { day: day, raf: 0 };
      this._chunk = chunk;
      (function step() {
        if (self._chunk !== chunk || !self._cv) return;     // superseded
        var y1 = Math.min(g.h, y + rows);
        self._cx[idx].putImageData(self._fillRows(y, y1, day), 0, y);
        y = y1;
        if (y < g.h) { chunk.raf = requestAnimationFrame(step); return; }
        self._chunk = null;
        self._day1 = day;
        var t = self._t, d0 = Math.floor(t);
        self._applyBlend(t - d0);
      })();
    },

    _cancelChunk: function () {
      if (this._chunk) { cancelAnimationFrame(this._chunk.raf); this._chunk = null; }
    },
  });

  window.FieldLayer = FieldLayer;
})();
