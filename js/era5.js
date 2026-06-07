/* era5.js — client-side ERA5 tile fetch + decode + sampling.
 *
 * Reads the compact, regional (Atlantic-window) pack built by
 * migrate/build_atlantic_pack.py and committed under data/ (served same-origin
 * on GitHub Pages — zero egress, no CORS). f16-gz tiles: native
 * DecompressionStream('gzip') + uint16 dequantization against per-tile
 * vmin/vmax from data/manifest.json. Exposes a small global `ERA5`.
 *
 * data/manifest.json = {
 *   grid: {ny,nx,lat0,dlat,lon0,dlon}, nan: 65535,
 *   daily: { "<field>/<YYYY>_<MM>": {vmin,vmax,nDays}, … },   // field: steeru|steerv|shear
 *   sst:   { "<MM>": {vmin,vmax} }
 * }
 * Tiles: data/<field>/<YYYY>_<MM>.bin.gz  and  data/sst/<MM>.bin.gz
 */
(function () {
  'use strict';

  // Data lives in the repo by default (same-origin). Override the base via
  // window.SEEDSTORM_DATA.base if you ever host the pack elsewhere.
  var CFG = (typeof window !== 'undefined' && window.SEEDSTORM_DATA) || {};
  var BASE = CFG.base || 'data';
  // Cache-bust the data pack on each regeneration — tiles + manifest are fetched
  // by plain path, so a content change must bump this or returning visitors can
  // mix a cached old manifest with new tiles (vmin/vmax mismatch → garbage decode).
  // v2 = environmental (850-mb vortex-removed) shear/steering pack.
  // v3 = added 0.1° land-fraction mask (manifest gained a 'landmask' entry).
  // v4 = added gridded per-year-month MPI (manifest gained an 'mpi' entry).
  var DV = '?v=' + (CFG.version || '4');

  var NAN = 0xFFFF;
  var _manifest = null;     // Promise<manifest>
  var _cache = {};          // url -> Promise<Float32Array>

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  // GitHub Pages (Fastly) returns transient 503s — during a deploy, an edge
  // hiccup, or rate-limiting — and a single failed tile would otherwise sink a
  // whole round. Retry transient failures (network errors, 5xx, 429) with
  // exponential backoff; fail fast on 4xx (a genuinely missing file). Returns
  // the ok Response.
  function _retriable(status) { return !status || status >= 500 || status === 429; }
  function fetchOk(url, tries, delay) {
    tries = tries || 4; delay = delay || 500;
    return fetch(url).then(function (r) {
      if (r.ok) return r;
      var e = new Error('HTTP ' + r.status + ' for ' + url); e.status = r.status; throw e;
    }).catch(function (e) {
      if (tries <= 1 || !_retriable(e && e.status)) throw e;
      return new Promise(function (res) { setTimeout(res, delay); })
        .then(function () { return fetchOk(url, tries - 1, delay * 2); });
    });
  }

  function loadManifest() {
    if (_manifest) return _manifest;
    _manifest = fetchOk(BASE + '/manifest.json' + DV).then(function (r) { return r.json(); });
    _manifest.catch(function () { _manifest = null; });   // never cache a transient failure
    return _manifest;
  }

  // gzip + uint16 dequantize (with transient-failure retry; cache is never
  // poisoned by a failure, so a later request — e.g. the real deal after a
  // failed prefetch — can fetch fresh).
  function fetchDecode(url, vmin, vmax) {
    if (_cache[url]) return _cache[url];
    var range = (vmax - vmin) / 65534; // 65534 = 65535 - 1
    var p = fetchOk(url).then(function (r) {
      return new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    }).then(function (buf) {
      var u16 = new Uint16Array(buf), out = new Float32Array(u16.length);
      for (var i = 0; i < u16.length; i++) out[i] = u16[i] === NAN ? NaN : vmin + u16[i] * range;
      return out;
    });
    p.catch(function () { if (_cache[url] === p) delete _cache[url]; });
    _cache[url] = p;
    return p;
  }

  // Load one field-month as a flat Float32Array (nDays * ny * nx).
  // field: 'steeru' | 'steerv' | 'shear'
  function loadDailyField(field, year, month) {
    return loadManifest().then(function (man) {
      var key = field + '/' + year + '_' + pad2(month);
      var t = man.daily[key];
      if (!t) throw new Error('no daily tile ' + key);
      return fetchDecode(BASE + '/' + key + '.bin.gz' + DV, t.vmin, t.vmax).then(function (values) {
        return { field: field, values: values, nDays: t.nDays, grid: man.grid };
      });
    });
  }

  // Load `months` consecutive months and concatenate the daily frames onto one
  // contiguous time axis (so a storm can be integrated across a month boundary).
  function loadDailyFieldSpan(field, year, month, months) {
    var reqs = [];
    for (var k = 0; k < months; k++) {
      var m = month + k, y = year;
      while (m > 12) { m -= 12; y++; }
      reqs.push(loadDailyField(field, y, m));
    }
    return Promise.all(reqs).then(function (parts) {
      var grid = parts[0].grid, stride = grid.ny * grid.nx, total = 0;
      parts.forEach(function (p) { total += p.nDays; });
      var out = new Float32Array(total * stride), off = 0;
      parts.forEach(function (p) { out.set(p.values, off * stride); off += p.nDays; });
      return { field: field, values: out, nDays: total, grid: grid };
    });
  }

  // Monthly SST climatology grid (Kelvin). NaN over land.
  function loadSST(month) {
    return loadManifest().then(function (man) {
      var t = man.sst[pad2(month)];
      return fetchDecode(BASE + '/sst/' + pad2(month) + '.bin.gz' + DV, t.vmin, t.vmax).then(function (values) {
        return { values: values, grid: man.grid };
      });
    });
  }

  // Gridded potential intensity (kt) for a specific year-month — the real
  // (tcpyPI-style) MPI, so the intensity ceiling carries that year's anomaly.
  function loadMPI(year, month) {
    return loadManifest().then(function (man) {
      var key = year + '_' + pad2(month);
      var t = man.mpi && man.mpi[key];
      if (!t) return null;
      return fetchDecode(BASE + '/mpi/' + key + '.bin.gz' + DV, t.vmin, t.vmax).then(function (values) {
        return { values: values, grid: man.grid };
      });
    });
  }

  // High-resolution (0.1°) land-fraction grid for graded land decay (independent
  // of the coarse 1° SST). Resolves small islands. Returns null if absent.
  function loadLandMask() {
    return loadManifest().then(function (man) {
      var t = man.landmask;
      if (!t) return null;
      return fetchDecode(BASE + '/landmask.bin.gz' + DV, t.vmin, t.vmax).then(function (values) {
        return { values: values, grid: t.grid };
      });
    });
  }

  // Per-storm IBTrACS climatology (percentile anchors per basin × month).
  // Small plain JSON; cached after first fetch. null if unavailable.
  var _climo = null;
  function loadClimo() {
    if (_climo) return _climo;
    _climo = fetchOk(BASE + '/climo.json' + DV)
      .then(function (r) { return r.json(); })
      .catch(function () { _climo = null; return null; });   // optional; retry next time if it failed
    return _climo;
  }

  // NaN-safe bilinear sample. `values` is one grid frame (ny*nx).
  function bilinear(values, grid, lat, lon) {
    var fi = (lat - grid.lat0) / grid.dlat;   // fractional row
    var fj = (lon - grid.lon0) / grid.dlon;   // fractional col
    if (fi < 0 || fi > grid.ny - 1 || fj < 0 || fj > grid.nx - 1) return NaN;
    var i0 = Math.floor(fi), i1 = Math.min(grid.ny - 1, i0 + 1);
    var j0 = Math.floor(fj), j1 = Math.min(grid.nx - 1, j0 + 1);
    var di = fi - i0, dj = fj - j0;
    var v00 = values[i0 * grid.nx + j0], v01 = values[i0 * grid.nx + j1];
    var v10 = values[i1 * grid.nx + j0], v11 = values[i1 * grid.nx + j1];
    var any = !isFinite(v00) || !isFinite(v01) || !isFinite(v10) || !isFinite(v11);
    if (any) {
      var s = 0, n = 0, arr = [v00, v01, v10, v11];
      for (var k = 0; k < 4; k++) if (isFinite(arr[k])) { s += arr[k]; n++; }
      return n ? s / n : NaN;
    }
    var top = v00 * (1 - dj) + v01 * dj, bot = v10 * (1 - dj) + v11 * dj;
    return top * (1 - di) + bot * di;
  }

  // View into the flat monthly buffer for one day (no copy).
  function dayFrame(field, dayIdx) {
    var stride = field.grid.ny * field.grid.nx;
    var d = Math.max(0, Math.min(field.nDays - 1, dayIdx | 0));
    return field.values.subarray(d * stride, (d + 1) * stride);
  }

  // Sample a daily field at fractional day index (time-interp between 00Z frames).
  function sampleTime(field, dayFloat, lat, lon) {
    var d0 = Math.max(0, Math.min(field.nDays - 1, Math.floor(dayFloat)));
    var d1 = Math.min(field.nDays - 1, d0 + 1);
    var w = dayFloat - Math.floor(dayFloat);
    var v0 = bilinear(dayFrame(field, d0), field.grid, lat, lon);
    var v1 = bilinear(dayFrame(field, d1), field.grid, lat, lon);
    if (!isFinite(v0)) return v1;
    if (!isFinite(v1)) return v0;
    return v0 * (1 - w) + v1 * w;
  }

  window.ERA5 = {
    loadManifest: loadManifest,
    loadDailyField: loadDailyField,
    loadDailyFieldSpan: loadDailyFieldSpan,
    loadSST: loadSST,
    loadMPI: loadMPI,
    loadLandMask: loadLandMask,
    loadClimo: loadClimo,
    fetchDecode: fetchDecode,
    bilinear: bilinear,
    dayFrame: dayFrame,
    sampleTime: sampleTime,
  };
})();
