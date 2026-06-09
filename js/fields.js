/* fields.js — viewport-resolution shaded scalar-field layer (canvas).
 *
 * Replaces the old whole-world Mercator-warped L.imageOverlay (360 px wide for
 * the entire globe — ~1 px per degree, hopelessly blurry once stretched across
 * a retina phone). Instead, every redraw samples the field bilinearly for each
 * canvas pixel of the CURRENT viewport (earth.nullschool style), so the shading
 * is crisp at any zoom and the work scales with the screen, not the world.
 * Web-Mercator makes this cheap: longitude is linear in x, latitude depends
 * only on y, so we unproject once per row/edge and sample inside a tight loop.
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

    // Re-shades for a new time IF the layer is on a map; otherwise just stores
    // the time for the next onAdd.
    setTime: function (t) { this._t = t; this._redraw(); return this; },

    onAdd: function (map) {
      this._map = map;
      var pane = map.getPane(this._paneName) || map.createPane(this._paneName);
      var c = L.DomUtil.create('canvas', 'leaflet-field-canvas');
      c.style.position = 'absolute'; c.style.pointerEvents = 'none';
      c.style.opacity = this._opacity;
      pane.appendChild(c);
      this._canvas = c; this._ctx = c.getContext('2d');
      map.on('moveend zoomend resize', this._redraw, this);
      // Hide during a zoom animation — the canvas isn't zoom-transformed, so it
      // would sit misaligned until the post-zoom redraw.
      map.on('zoomstart', this._hide, this);
      this._redraw();
      return this;
    },

    onRemove: function (map) {
      map.off('moveend zoomend resize', this._redraw, this);
      map.off('zoomstart', this._hide, this);
      if (this._canvas && this._canvas.parentNode) this._canvas.parentNode.removeChild(this._canvas);
      this._canvas = this._ctx = null;
      this._map = null;
      return this;
    },

    _hide: function () { if (this._canvas) this._canvas.style.visibility = 'hidden'; },

    _redraw: function () {
      if (!this._canvas || !this._map || !this._sample) return;
      var map = this._map, size = map.getSize(), c = this._canvas;
      var dpr = window.devicePixelRatio || 1;
      var scale = Math.min(2, dpr, Math.sqrt(MAX_SAMPLES / (size.x * size.y)));
      var w = Math.max(2, Math.round(size.x * scale)), h = Math.max(2, Math.round(size.y * scale));
      c.width = w; c.height = h;
      c.style.width = size.x + 'px'; c.style.height = size.y + 'px';
      c.style.visibility = '';
      L.DomUtil.setPosition(c, map.containerPointToLayerPoint([0, 0]));

      var ctx = this._ctx, img = ctx.createImageData(w, h);
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
    },
  });

  window.FieldLayer = FieldLayer;
})();
