/* contours.js — marching-squares isolines + a Leaflet canvas contour layer.
 *
 * Used to draw wind-shear magnitude as colored contour lines over the steering
 * flow (like the TC-ATLAS Global Map). Contours are projection-correct because
 * each segment is projected per-point via latLngToContainerPoint (no Mercator
 * warp needed). The scalar field is sampled once at deal time; the layer just
 * redraws (reprojects) on pan/zoom.
 */
(function () {
  'use strict';

  // Marching-squares edge table. Corner bits: bl=1, br=2, tr=4, tl=8.
  // Edges: 0=bottom(bl-br), 1=right(br-tr), 2=top(tr-tl), 3=left(tl-bl).
  var MS = [
    [], [[3, 0]], [[0, 1]], [[3, 1]], [[1, 2]], [[3, 0], [1, 2]], [[0, 2]],
    [[3, 2]], [[2, 3]], [[0, 2]], [[0, 1], [2, 3]], [[1, 2]], [[3, 1]],
    [[0, 1]], [[3, 0]], [],
  ];

  // sample(lat, lon) -> value (or NaN). Returns { level: [ [[lat,lon],[lat,lon]], ... ] }.
  function buildContours(sample, bbox, res, levels) {
    var nx = Math.round((bbox.e - bbox.w) / res) + 1;
    var ny = Math.round((bbox.n - bbox.s) / res) + 1;
    var g = new Float32Array(nx * ny);
    for (var j = 0; j < ny; j++) {
      var lat = bbox.s + j * res;
      for (var i = 0; i < nx; i++) g[j * nx + i] = sample(lat, bbox.w + i * res);
    }
    var out = {};
    for (var li = 0; li < levels.length; li++) {
      var L = levels[li], segs = [];
      for (var jj = 0; jj < ny - 1; jj++) {
        var lat0 = bbox.s + jj * res, lat1 = lat0 + res;
        for (var ii = 0; ii < nx - 1; ii++) {
          var v0 = g[jj * nx + ii], v1 = g[jj * nx + ii + 1];
          var v2 = g[(jj + 1) * nx + ii + 1], v3 = g[(jj + 1) * nx + ii];
          if (!(isFinite(v0) && isFinite(v1) && isFinite(v2) && isFinite(v3))) continue;
          var idx = (v0 >= L ? 1 : 0) | (v1 >= L ? 2 : 0) | (v2 >= L ? 4 : 0) | (v3 >= L ? 8 : 0);
          var pairs = MS[idx];
          if (!pairs.length) continue;
          var lon0 = bbox.w + ii * res, lon1 = lon0 + res;
          var ep = [
            [lat0, lon0 + (L - v0) / (v1 - v0) * res],   // 0 bottom
            [lat0 + (L - v1) / (v2 - v1) * res, lon1],   // 1 right
            [lat1, lon0 + (L - v3) / (v2 - v3) * res],   // 2 top
            [lat0 + (L - v0) / (v3 - v0) * res, lon0],   // 3 left
          ];
          for (var p = 0; p < pairs.length; p++) segs.push([ep[pairs[p][0]], ep[pairs[p][1]]]);
        }
      }
      out[L] = segs;
    }
    return out;
  }

  // Canvas layer that draws precomputed contour segments, reprojecting on move.
  var ContourLayer = L.Layer.extend({
    initialize: function (opts) {
      opts = opts || {};
      this._levels = opts.levels || [];
      this._colors = opts.colors || {};
      this._lineWidth = opts.lineWidth || 1.4;
      this._data = null;
    },
    setContours: function (data) { this._data = data; this._redraw(); return this; },

    onAdd: function (map) {
      this._map = map;
      var pane = map.getPane('contourPane');
      if (!pane) {
        pane = map.createPane('contourPane');
        pane.style.zIndex = 360;          // above flow (350), below tracks (400)
        pane.style.pointerEvents = 'none';
      }
      var c = L.DomUtil.create('canvas', 'leaflet-contour-canvas');
      c.style.position = 'absolute'; c.style.pointerEvents = 'none';
      pane.appendChild(c);
      this._canvas = c; this._ctx = c.getContext('2d');
      map.on('moveend zoomend resize', this._redraw, this);
      this._redraw();
      return this;
    },
    onRemove: function (map) {
      map.off('moveend zoomend resize', this._redraw, this);
      if (this._canvas && this._canvas.parentNode) this._canvas.parentNode.removeChild(this._canvas);
      this._canvas = this._ctx = null;
      return this;
    },

    _redraw: function () {
      if (!this._canvas || !this._map) return;
      var map = this._map, size = map.getSize(), dpr = window.devicePixelRatio || 1, c = this._canvas;
      c.width = size.x * dpr; c.height = size.y * dpr;
      c.style.width = size.x + 'px'; c.style.height = size.y + 'px';
      L.DomUtil.setPosition(c, map.containerPointToLayerPoint([0, 0]));
      var ctx = this._ctx;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, size.x, size.y);
      if (!this._data) return;
      ctx.lineWidth = this._lineWidth; ctx.lineCap = 'round';
      for (var li = 0; li < this._levels.length; li++) {
        var lev = this._levels[li], segs = this._data[lev];
        if (!segs || !segs.length) continue;
        ctx.strokeStyle = this._colors[lev] || '#ffffff';
        ctx.beginPath();
        for (var s = 0; s < segs.length; s++) {
          var a = map.latLngToContainerPoint(segs[s][0]);
          var b = map.latLngToContainerPoint(segs[s][1]);
          ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
        }
        ctx.stroke();
      }
    },
  });

  window.buildContours = buildContours;
  window.ContourLayer = ContourLayer;
})();
