/* fields.js — viewport-resolution shaded scalar-field layer (canvas).
 *
 * Replaces the old whole-world Mercator-warped L.imageOverlay (360 px wide for
 * the entire globe — ~1 px per degree, hopelessly blurry once stretched across
 * a retina phone). Instead, every redraw samples the field bilinearly for each
 * canvas pixel of the CURRENT viewport (earth.nullschool style), so the shading
 * is crisp at any zoom and the work scales with the screen, not the world.
 * Web-Mercator makes this cheap: longitude is linear in x, latitude depends
 * only on y, so we unproject once per row/edge and sample inside a tight loop.
 *
 * Time changes CROSSFADE: the new shading renders into a back canvas that
 * fades in over the old one, so the field evolves smoothly through the storm
 * animation instead of snapping every re-shade interval.
 */
(function () {
  'use strict';

  // Sampling budget per redraw. Phones get up-to-DPR supersampling (their
  // viewports are small); huge desktop windows drop below 1 sample per CSS px
  // and let the browser's smooth upscale cover the difference.
  var MAX_SAMPLES = 480000;

  var FieldLayer = L.Layer.extend({
    // opts: sample(lat, lon, t) -> value (NaN = transparent),
    //       color(value) -> [r,g,b,a], opacity, pane
    initialize: function (opts) {
      opts = opts || {};
      this._sample = opts.sample;
      this._color = opts.color;
      this._opacity = opts.opacity != null ? opts.opacity : 0.6;
      this._paneName = opts.pane || 'overlayPane';
      this._t = 0;
    },

    // Re-shades for a new time IF the layer is on a map (with a crossfade);
    // otherwise just stores the time for the next onAdd.
    setTime: function (t) {
      this._t = t;
      if (this._map) this._render(1 - this._front, true);
      return this;
    },

    onAdd: function (map) {
      this._map = map;
      var pane = map.getPane(this._paneName) || map.createPane(this._paneName);
      this._cv = []; this._cx = []; this._front = 0;
      for (var k = 0; k < 2; k++) {
        var c = L.DomUtil.create('canvas', 'leaflet-field-canvas');
        c.style.position = 'absolute'; c.style.pointerEvents = 'none';
        c.style.opacity = k === 0 ? this._opacity : 0;
        pane.appendChild(c);
        this._cv.push(c); this._cx.push(c.getContext('2d'));
      }
      map.on('moveend zoomend resize', this._redraw, this);
      // Hide during a zoom animation — the canvases aren't zoom-transformed,
      // so they would sit misaligned until the post-zoom redraw.
      map.on('zoomstart', this._hide, this);
      this._redraw();
      return this;
    },

    onRemove: function (map) {
      map.off('moveend zoomend resize', this._redraw, this);
      map.off('zoomstart', this._hide, this);
      (this._cv || []).forEach(function (c) { if (c.parentNode) c.parentNode.removeChild(c); });
      this._cv = this._cx = null;
      this._map = null;
      return this;
    },

    _hide: function () {
      (this._cv || []).forEach(function (c) { c.style.visibility = 'hidden'; });
    },

    // Geometry refresh (pan/zoom/resize/add): draw the front canvas in place,
    // no fade; the back canvas (possibly mid-fade, stale geometry) goes dark.
    _redraw: function () {
      if (!this._cv) return;
      this._render(this._front, false);
      var back = this._cv[1 - this._front];
      back.style.transition = 'none'; back.style.opacity = 0;
      // restore the fade transition once the instant hide has applied
      void back.offsetWidth; back.style.transition = '';
    },

    _render: function (idx, fade) {
      if (!this._cv || !this._map || !this._sample) return;
      var map = this._map, size = map.getSize();
      var c = this._cv[idx], ctx = this._cx[idx];
      var dpr = window.devicePixelRatio || 1;
      var scale = Math.min(2, dpr, Math.sqrt(MAX_SAMPLES / (size.x * size.y)));
      var w = Math.max(2, Math.round(size.x * scale)), h = Math.max(2, Math.round(size.y * scale));
      c.width = w; c.height = h;
      c.style.width = size.x + 'px'; c.style.height = size.y + 'px';
      c.style.visibility = '';
      L.DomUtil.setPosition(c, map.containerPointToLayerPoint([0, 0]));

      var img = ctx.createImageData(w, h);
      var d = img.data, sample = this._sample, color = this._color, t = this._t;
      // Longitude is linear across the viewport in Web Mercator (and if the
      // window is wider than the world, per-column wrapping repeats it).
      var west = map.containerPointToLatLng([0, 0]).lng;
      var east = map.containerPointToLatLng([size.x, 0]).lng;
      for (var j = 0; j < h; j++) {
        var lat = map.containerPointToLatLng([0, (j + 0.5) * size.y / h]).lat;
        var o = j * w * 4;
        for (var i = 0; i < w; i++) {
          var lon = west + (east - west) * (i + 0.5) / w;
          lon = ((lon + 180) % 360 + 360) % 360 - 180;   // wrap to the data's [-180,180)
          var col = color(sample(lat, lon, t));
          d[o] = col[0]; d[o + 1] = col[1]; d[o + 2] = col[2]; d[o + 3] = col[3];
          o += 4;
        }
      }
      ctx.putImageData(img, 0, 0);

      if (fade) {
        // Crossfade: the freshly drawn canvas eases in while the old one eases
        // out (CSS transition on .leaflet-field-canvas).
        var nu = c, old = this._cv[this._front], op = this._opacity;
        this._front = idx;
        requestAnimationFrame(function () { nu.style.opacity = op; old.style.opacity = 0; });
      } else {
        c.style.opacity = this._opacity;
      }
    },
  });

  window.FieldLayer = FieldLayer;
})();
