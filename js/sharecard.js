/* sharecard.js — client-side PNG recap cards for sharing (no backend).
 *
 * ShareCard.storm(opts) renders a 1200×630 (drawn at 1.5×) card: the storm's
 * track over its real shear environment + coastlines on the left, headline
 * stats and the intensity curve on the right. ShareCard.game(opts) renders a
 * six-round game recap. Both resolve to a PNG Blob for the Web Share API
 * (files) or a download fallback — so shares carry a picture, not a bare link.
 *
 * game.js passes in its own colour ramps/samplers (colorForV, shearShade,
 * shearAt, landAt) so the card always matches the in-game look.
 */
(function () {
  'use strict';

  var S = 1.5, W = 1200, H = 630;       // design units × supersample
  var INK = '#E6EFE9', INK_DIM = '#AEC3B6', INK_FAINT = '#8BB0A1';
  var ACCENT = '#2DBDA0', GRID = 'rgba(36,51,82,.9)';
  var FONT = '"DM Sans", -apple-system, sans-serif';
  var MONO = '"JetBrains Mono", ui-monospace, monospace';
  // Dark map base the field is blended onto (≈ the in-game basemap under 62% field).
  var SEA = [13, 31, 27], LAND = [7, 20, 17];

  var _fonts = null;
  function prep() {
    if (_fonts) return _fonts;
    var specs = ['700 56px ' + FONT, '700 15px ' + FONT, '600 16px ' + FONT,
                 '400 15px ' + FONT, '500 13px ' + MONO];
    var load = Promise.all(specs.map(function (s) {
      return document.fonts && document.fonts.load ? document.fonts.load(s).catch(function () {}) : Promise.resolve();
    })).catch(function () {});
    _fonts = Promise.race([load, new Promise(function (r) { setTimeout(r, 1200); })]);
    return _fonts;
  }

  function makeCanvas() {
    var cv = document.createElement('canvas');
    cv.width = W * S; cv.height = H * S;
    var ctx = cv.getContext('2d');
    ctx.scale(S, S);
    return { cv: cv, ctx: ctx };
  }
  function toBlob(cv) {
    return new Promise(function (res, rej) {
      cv.toBlob(function (b) { b ? res(b) : rej(new Error('toBlob failed')); }, 'image/png');
    });
  }
  function rr(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
  function bg(ctx) {
    var g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#0A1F1A'); g.addColorStop(1, '#061612');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // faint oversized swirl, top-right
    ctx.save(); ctx.translate(W - 150, 90); ctx.strokeStyle = 'rgba(45,189,160,.06)'; ctx.lineCap = 'round';
    [150, 110, 75].forEach(function (r, i) {
      ctx.lineWidth = 26 - i * 6;
      ctx.beginPath(); ctx.arc(0, 0, r, Math.PI * (0.15 + i * 0.5), Math.PI * (0.95 + i * 0.5)); ctx.stroke();
    });
    ctx.restore();
  }
  function swirlGlyph(ctx, x, y, r, color) {
    ctx.save(); ctx.translate(x, y);
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineCap = 'round';
    ctx.shadowColor = color; ctx.shadowBlur = 12;
    ctx.lineWidth = r * 0.22;
    ctx.beginPath(); ctx.arc(0, 0, r, -Math.PI / 2, 0); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, r, Math.PI / 2, Math.PI); ctx.stroke();
    ctx.lineWidth = r * 0.19;
    ctx.beginPath(); ctx.arc(0, 0, r * 0.62, Math.PI, Math.PI * 1.5); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, r * 0.62, 0, Math.PI * 0.5); ctx.stroke();
    ctx.beginPath(); ctx.arc(0, 0, r * 0.3, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0; ctx.fillStyle = '#08160f';
    ctx.beginPath(); ctx.arc(0, 0, r * 0.11, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }
  function eyebrow(ctx, x, y, text) {
    ctx.font = '700 15px ' + FONT; ctx.fillStyle = ACCENT; ctx.textAlign = 'left';
    try { ctx.letterSpacing = '3px'; } catch (e) {}
    ctx.fillText(text.toUpperCase(), x, y);
    try { ctx.letterSpacing = '0px'; } catch (e) {}
  }
  function footer(ctx, x, y, url) {
    ctx.textAlign = 'left';
    ctx.font = '600 17px ' + FONT; ctx.fillStyle = INK;
    ctx.fillText('Can you out-forecast me?', x, y);
    ctx.font = '500 14px ' + MONO; ctx.fillStyle = ACCENT;
    ctx.fillText(url, x, y + 24);
  }
  function wrapText(ctx, text, x, y, maxW, lh) {
    var words = text.split(' '), line = '', yy = y;
    for (var i = 0; i < words.length; i++) {
      var t = line ? line + ' ' + words[i] : words[i];
      if (ctx.measureText(t).width > maxW && line) { ctx.fillText(line, x, yy); line = words[i]; yy += lh; }
      else line = t;
    }
    if (line) ctx.fillText(line, x, yy);
    return yy + lh;
  }

  // ---- storm card ----------------------------------------------------------
  function drawEnvironment(ctx, o, prj, inv, x, y, w, h) {
    // Half-res offscreen ImageData (smooth-upscaled): shear shading over a dark
    // base, land darkened via the high-res mask — matches the in-game look.
    var ow = Math.round(w / 2), oh = Math.round(h / 2);
    var off = document.createElement('canvas'); off.width = ow; off.height = oh;
    var octx = off.getContext('2d'), img = octx.createImageData(ow, oh), d = img.data;
    for (var j = 0; j < oh; j++) {
      for (var i = 0; i < ow; i++) {
        var ll = inv((i + 0.5) / ow, (j + 0.5) / oh);
        var c = SEA;
        if (o.shearAt) {
          var col = o.shearColor(o.shearAt(ll.lat, ll.lon));
          if (col[3] > 0) c = [SEA[0] + (col[0] - SEA[0]) * 0.62,
                              SEA[1] + (col[1] - SEA[1]) * 0.62,
                              SEA[2] + (col[2] - SEA[2]) * 0.62];
        }
        if (o.landAt && o.landAt(ll.lat, ll.lon) > 0.5) {
          c = [c[0] + (LAND[0] - c[0]) * 0.62, c[1] + (LAND[1] - c[1]) * 0.62, c[2] + (LAND[2] - c[2]) * 0.62];
        }
        var p = (j * ow + i) * 4;
        d[p] = c[0]; d[p + 1] = c[1]; d[p + 2] = c[2]; d[p + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, x, y, w, h);
  }
  function drawCoast(ctx, gj, prj, bb) {
    if (!gj || !gj.features) return;
    ctx.strokeStyle = 'rgba(227,234,246,.5)'; ctx.lineWidth = 1; ctx.lineJoin = 'round';
    var m = 2;   // degree margin around the bbox
    gj.features.forEach(function (f) {
      var g = f.geometry; if (!g) return;
      var lines = g.type === 'LineString' ? [g.coordinates] : g.type === 'MultiLineString' ? g.coordinates : [];
      lines.forEach(function (line) {
        ctx.beginPath();
        var pen = false;
        for (var k = 0; k < line.length; k++) {
          var lon = line[k][0], lat = line[k][1];
          if (lat < bb.s - m || lat > bb.n + m || lon < bb.w - m || lon > bb.e + m) { pen = false; continue; }
          var pt = prj(lat, lon);
          if (pen) ctx.lineTo(pt.x, pt.y); else { ctx.moveTo(pt.x, pt.y); pen = true; }
        }
        ctx.stroke();
      });
    });
  }
  function drawTrack(ctx, o, prj) {
    var pts = o.track;
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    var runCol = null;
    for (var k = 1; k < pts.length; k++) {
      var col = o.colorForV(pts[k].v);
      if (col !== runCol) {
        if (runCol) ctx.stroke();
        ctx.beginPath();
        var p0 = prj(pts[k - 1].lat, pts[k - 1].lon);
        ctx.moveTo(p0.x, p0.y);
        ctx.strokeStyle = col; ctx.lineWidth = 4.5;
        ctx.shadowColor = col; ctx.shadowBlur = 9;
        runCol = col;
      }
      var p = prj(pts[k].lat, pts[k].lon);
      ctx.lineTo(p.x, p.y);
    }
    if (runCol) ctx.stroke();
    ctx.shadowBlur = 0;
    // seed origin
    var s0 = prj(pts[0].lat, pts[0].lon);
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(s0.x, s0.y, 4, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(s0.x, s0.y, 7.5, 0, Math.PI * 2); ctx.stroke();
    // swirl at peak intensity
    var pk = 0;
    for (var q = 1; q < pts.length; q++) if (pts[q].v > pts[pk].v) pk = q;
    var pp = prj(pts[pk].lat, pts[pk].lon);
    swirlGlyph(ctx, pp.x, pp.y, 13 + o.peakV / 10, o.colorForV(o.peakV));
  }
  function drawCurve(ctx, o, x, y, w, h) {
    var pts = o.track, maxHr = Math.max(24, pts[pts.length - 1].hr), maxV = 160;
    var X = function (hr) { return x + w * hr / maxHr; };
    var Y = function (v) { return y + h * (1 - v / maxV); };
    ctx.textAlign = 'right'; ctx.font = '400 11px ' + FONT;
    [34, 64, 96, 137].forEach(function (lv) {
      ctx.strokeStyle = GRID; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, Y(lv)); ctx.lineTo(x + w, Y(lv)); ctx.stroke();
      ctx.fillStyle = '#687c9f'; ctx.fillText(lv + ' kt', x - 6, Y(lv) + 4);
    });
    var grad = ctx.createLinearGradient(0, y, 0, y + h);
    grad.addColorStop(0, 'rgba(61,130,246,.28)'); grad.addColorStop(1, 'rgba(61,130,246,.02)');
    ctx.fillStyle = grad; ctx.beginPath(); ctx.moveTo(X(pts[0].hr), y + h);
    pts.forEach(function (p) { ctx.lineTo(X(p.hr), Y(p.v)); });
    ctx.lineTo(X(pts[pts.length - 1].hr), y + h); ctx.closePath(); ctx.fill();
    ctx.lineCap = 'round'; ctx.lineWidth = 3;
    var runCol = null;
    for (var k = 1; k < pts.length; k++) {
      var col = o.colorForV(pts[k].v);
      if (col !== runCol) {
        if (runCol) ctx.stroke();
        ctx.beginPath(); ctx.moveTo(X(pts[k - 1].hr), Y(pts[k - 1].v));
        ctx.strokeStyle = col; runCol = col;
      }
      ctx.lineTo(X(pts[k].hr), Y(pts[k].v));
    }
    if (runCol) ctx.stroke();
    ctx.fillStyle = '#9fb1d0'; ctx.font = '400 12px ' + FONT;
    ctx.textAlign = 'left'; ctx.fillText('day 0', x, y + h + 18);
    ctx.textAlign = 'right'; ctx.fillText('day ' + Math.ceil(maxHr / 24), x + w, y + h + 18);
  }

  function storm(o) {
    return prep().then(function () {
      var c = makeCanvas(), ctx = c.ctx;
      bg(ctx);

      // --- map panel ---
      var mx = 36, my = 36, mw = 680, mh = 558;
      // bbox: track + seed, padded, expanded to the panel aspect (lon scaled by cos lat)
      var lats = o.track.map(function (p) { return p.lat; }).concat([o.seed.lat]);
      var lons = o.track.map(function (p) { return p.lon; }).concat([o.seed.lon]);
      var bb = { s: Math.min.apply(null, lats), n: Math.max.apply(null, lats),
                 w: Math.min.apply(null, lons), e: Math.max.apply(null, lons) };
      var padLat = Math.max(2.5, (bb.n - bb.s) * 0.22), padLon = Math.max(3, (bb.e - bb.w) * 0.16);
      bb = { s: bb.s - padLat, n: bb.n + padLat, w: bb.w - padLon, e: bb.e + padLon };
      var midLat = (bb.s + bb.n) / 2, cosM = Math.max(0.2, Math.cos(midLat * Math.PI / 180));
      var spanX = (bb.e - bb.w) * cosM, spanY = bb.n - bb.s, want = mw / mh;
      if (spanX / spanY < want) {       // too tall → widen
        var addLon = (spanY * want / cosM - (bb.e - bb.w)) / 2; bb.w -= addLon; bb.e += addLon;
      } else {                          // too wide → heighten
        var addLat = (spanX / want - spanY) / 2; bb.s -= addLat; bb.n += addLat;
      }
      var prj = function (lat, lon) {
        return { x: mx + mw * (lon - bb.w) / (bb.e - bb.w),
                 y: my + mh * (bb.n - lat) / (bb.n - bb.s) };
      };
      var inv = function (fx, fy) {
        return { lon: bb.w + (bb.e - bb.w) * fx, lat: bb.n - (bb.n - bb.s) * fy };
      };
      ctx.save();
      rr(ctx, mx, my, mw, mh, 16); ctx.clip();
      ctx.fillStyle = 'rgb(' + SEA.join(',') + ')'; ctx.fillRect(mx, my, mw, mh);
      drawEnvironment(ctx, o, prj, inv, mx, my, mw, mh);
      drawCoast(ctx, o.coast, prj, bb);
      drawTrack(ctx, o, prj);
      ctx.restore();
      rr(ctx, mx, my, mw, mh, 16);
      ctx.strokeStyle = 'rgba(33,89,70,.9)'; ctx.lineWidth = 1.5; ctx.stroke();

      // --- stats column ---
      var sx = 756, sw = W - sx - 36;
      eyebrow(ctx, sx, 70, 'Seed the Storm');
      ctx.textAlign = 'left';
      ctx.font = '700 54px ' + FONT; ctx.fillStyle = INK;
      var headline = o.objective === 'vmax' ? Math.round(o.peakV) + ' kt' : o.ace.toFixed(1) + ' ACE';
      ctx.fillText(headline, sx, 128);
      var cat = o.peakCat && o.peakCat.length === 1 ? 'Cat ' + o.peakCat + ' hurricane' : o.peakCat;
      var days = (o.track[o.track.length - 1].hr / 24).toFixed(1);
      ctx.font = '600 17px ' + FONT; ctx.fillStyle = o.colorForV(o.peakV);
      ctx.fillText(cat + ' · peak ' + Math.round(o.peakV) + ' kt · ' + days + ' days', sx, 162);
      ctx.font = '400 15px ' + FONT; ctx.fillStyle = INK_FAINT;
      ctx.fillText('Seeded ' + o.dateLabel + ' · ' + o.basinLabel + ' · real ERA5 environment', sx, 190);
      var yy = 218;
      if (o.climoText) {
        ctx.font = '400 15px ' + FONT; ctx.fillStyle = ACCENT;
        yy = wrapText(ctx, o.climoText, sx, yy, sw, 21) + 6;
      }
      drawCurve(ctx, o, sx + 40, Math.max(260, yy + 16), sw - 46, 230);
      footer(ctx, sx, 576, o.url);
      return toBlob(c.cv);
    });
  }

  // ---- game recap card -----------------------------------------------------
  function game(o) {
    return prep().then(function () {
      var c = makeCanvas(), ctx = c.ctx;
      bg(ctx);
      var lx = 56;
      eyebrow(ctx, lx, 88, 'Seed the Storm · Final results');
      ctx.textAlign = 'left';
      ctx.font = '700 64px ' + FONT; ctx.fillStyle = INK;
      var headline = o.objective === 'vmax' ? Math.round(o.bestPeakKt) + ' kt' : o.totalAce.toFixed(1) + ' ACE';
      ctx.fillText(headline, lx, 168);
      ctx.font = '600 19px ' + FONT; ctx.fillStyle = INK_DIM;
      ctx.fillText(o.objective === 'vmax' ? 'strongest storm of the game' : 'banked across six storms', lx, 204);
      ctx.font = '400 16px ' + FONT; ctx.fillStyle = INK_FAINT;
      ctx.fillText(o.modeLabel + ' · picked ' + o.avgPct + '% of the best seed on average', lx, 236);
      swirlGlyph(ctx, lx + 60, 330, 46, ACCENT);
      footer(ctx, lx, 540, o.url);

      // round rows, right side
      var rx = 520, rw = W - rx - 56, rh = 74, gap = 14, ry = 56;
      o.rows.forEach(function (r, i) {
        var y = ry + i * (rh + gap);
        rr(ctx, rx, y, rw, rh, 12);
        ctx.fillStyle = 'rgba(18,53,36,.85)'; ctx.fill();
        ctx.strokeStyle = 'rgba(33,89,70,.8)'; ctx.lineWidth = 1; ctx.stroke();
        ctx.textAlign = 'left';
        ctx.font = '500 13px ' + MONO; ctx.fillStyle = INK_FAINT;
        ctx.fillText('R' + r.round, rx + 20, y + 30);
        ctx.font = '600 16px ' + FONT; ctx.fillStyle = INK;
        ctx.fillText(r.date, rx + 56, y + 31);
        ctx.fillStyle = r.seedColor;
        ctx.beginPath(); ctx.arc(rx + 26, y + 50, 5, 0, Math.PI * 2); ctx.fill();
        ctx.font = '400 13.5px ' + FONT; ctx.fillStyle = INK_FAINT;
        var cat = r.cat && r.cat.length === 1 ? 'Cat ' + r.cat : r.cat;
        ctx.fillText('seed ' + r.label + ' · ' + cat + ' · ' + r.points + '% of best', rx + 40, y + 54);
        ctx.textAlign = 'right';
        ctx.font = '700 20px ' + FONT; ctx.fillStyle = o.colorForV(r.peakV);
        ctx.fillText(o.objective === 'vmax' ? Math.round(r.peakV) + ' kt' : r.ace.toFixed(1) + ' ACE',
          rx + rw - 20, y + 45);
      });
      return toBlob(c.cv);
    });
  }

  window.ShareCard = { storm: storm, game: game };
})();
