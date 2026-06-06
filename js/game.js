/* game.js — round loop: deal -> place seeds -> pick -> simulate -> reveal -> score. */
(function () {
  'use strict';

  // ---- config ----
  var YEARS = []; for (var y = 1991; y <= 2020; y++) YEARS.push(y);
  var ROUND_MONTHS = [6, 7, 8, 9, 10, 11];   // one round per hurricane-season month
  var N_SEEDS = 4;
  var SEED_BOX = { latMin: 10, latMax: 24, lonMin: -78, lonMax: -20 };
  var SEED_COLORS = ['#00e5ff', '#ffb454', '#38d39f', '#ff5d6c'];
  var SEED_LABELS = ['A', 'B', 'C', 'D'];
  var MONTH_NAMES = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                     'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // ---- state ----
  var map, seedLayer, trackLayer, mpiLayer = null, flowLayer = null, shearLayer = null;
  var env = null, seeds = [], results = null, chosenIdx = -1, dealDate = null;

  var seedMarkers = [];

  // ---- DOM ----
  var $ = function (id) { return document.getElementById(id); };
  var elDealDate = $('deal-date'), elStatus = $('status');
  var stages = { intro: $('stage-intro'), pick: $('stage-pick'),
                 result: $('stage-result'), summary: $('stage-summary') };

  // ---- game state (one round per hurricane-season month, June–November) ----
  var ROUNDS = ROUND_MONTHS.length;   // 6
  var game = { round: 0, year: 0, total: 0, totalAce: 0, rows: [] };
  var animToken = 0;   // invalidates a superseded animation loop

  function showStage(name) {
    Object.keys(stages).forEach(function (k) { stages[k].classList.toggle('hidden', k !== name); });
    // The valid-time clock belongs to the live map stages only.
    var clk = $('map-clock');
    if (clk) clk.classList.toggle('hidden', !(name === 'pick' || name === 'result'));
  }

  // Valid-time clock: deal date + `hr` hours into the integration.
  function updateClock(hr) {
    var clk = $('map-clock');
    if (!clk || !dealDate) return;
    var d = new Date(Date.UTC(dealDate.year, dealDate.month - 1, dealDate.day));
    d.setUTCHours(d.getUTCHours() + Math.round(hr));
    clk.innerHTML = MONTH_NAMES[d.getUTCMonth() + 1] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear() +
      ' <span class="mc-day">· day ' + (hr / 24).toFixed(1) + '</span>';
  }
  function status(msg, isErr) {
    elStatus.textContent = msg || '';
    elStatus.classList.toggle('error', !!isErr);
  }

  function colorForV(v) {
    if (v < 34) return '#4aa3ff';
    if (v < 64) return '#38d39f';
    if (v < 83) return '#ffe24a';
    if (v < 96) return '#ffb454';
    if (v < 113) return '#ff7a45';
    if (v < 137) return '#ff4d6d';
    return '#ff2bd1';
  }

  // ---- map ----
  function initMap() {
    map = L.map('map', { worldCopyJump: true, minZoom: 2, maxZoom: 8 })
      .setView([22, -52], 4);
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OpenStreetMap &copy; CARTO &middot; ERA5 via TC-ATLAS',
      subdomains: 'abcd', maxZoom: 8,
    }).addTo(map);
    seedLayer = L.layerGroup().addTo(map);
    trackLayer = L.layerGroup().addTo(map);
  }

  function seedIcon(i, selected) {
    return L.divIcon({
      className: '', iconSize: [26, 26], iconAnchor: [13, 26],
      html: '<div class="seed-pin' + (selected ? ' selected' : '') +
            '" style="background:' + SEED_COLORS[i] + '"><span>' + SEED_LABELS[i] + '</span></div>',
    });
  }

  // ---- deal ----
  function rand(a, b) { return a + Math.random() * (b - a); }
  function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }

  function dealRound() {
    status('Dealing… fetching ERA5 fields');
    resetRound();
    // Month is fixed by the round (Jun→Nov); the year is random each round, so
    // each round is an independent real example of that month's climatology.
    var year = pick(YEARS), month = ROUND_MONTHS[game.round - 1];
    $('round-label').textContent = 'Round ' + game.round + ' / ' + ROUNDS + ' · ' + MONTH_NAMES[month];

    ERA5.loadManifest().then(function (man) {
      var nDays = man.daily['shear/' + year + '_' + (month < 10 ? '0' : '') + month].nDays;
      var day = 1 + ((Math.random() * nDays) | 0);
      var startDayIdx = day - 1;
      dealDate = { year: year, month: month, day: day };
      elDealDate.textContent = MONTH_NAMES[month] + ' ' + day + ', ' + year;

      // Load this month + the next so a storm can be integrated across the
      // month boundary until it dissipates, on a contiguous time axis.
      // Steering is precomputed (steeru/steerv = 0.75*V850 + 0.25*V200).
      return Promise.all([
        ERA5.loadDailyFieldSpan('steeru', year, month, 2),
        ERA5.loadDailyFieldSpan('steerv', year, month, 2),
        ERA5.loadDailyFieldSpan('shear', year, month, 2),
        ERA5.loadSST(month),
      ]).then(function (f) {
        env = { steeru: f[0], steerv: f[1], shear: f[2],
                sst: f[3], startDayIdx: startDayIdx };
        placeSeeds();
        renderFlow();
        renderShear();
        renderMpi();
        updateClock(0);
        status('');
        showStage('pick');
      });
    }).catch(function (e) {
      console.error(e);
      status('Failed to load ERA5 data: ' + e.message, true);
    });
  }

  function isOcean(lat, lon) {
    var k = ERA5.bilinear(env.sst.values, env.sst.grid, lat, lon);
    return isFinite(k) && (k - 273.15) > 25; // ocean & not too cold
  }

  function placeSeeds() {
    seeds = [];
    var tries = 0;
    while (seeds.length < N_SEEDS && tries < 500) {
      tries++;
      var lat = rand(SEED_BOX.latMin, SEED_BOX.latMax);
      var lon = rand(SEED_BOX.lonMin, SEED_BOX.lonMax);
      if (!isOcean(lat, lon)) continue;
      var ok = seeds.every(function (s) {
        return Math.hypot(s.lat - lat, s.lon - lon) > 6; // spread out
      });
      if (ok) seeds.push({ lat: lat, lon: lon });
    }
    renderSeedMarkers();
    renderSeedList();
  }

  function renderSeedMarkers() {
    seedLayer.clearLayers(); seedMarkers = [];
    seeds.forEach(function (s, i) {
      var m = L.marker([s.lat, s.lon], { icon: seedIcon(i, false) }).addTo(seedLayer);
      m.on('click', function () { selectSeed(i); });
      seedMarkers.push(m);
    });
    var grp = L.featureGroup(seedMarkers);
    if (seedMarkers.length) map.fitBounds(grp.getBounds().pad(0.6), { animate: false });
  }

  function fmtLoc(s) {
    return Math.abs(s.lat).toFixed(1) + '°N, ' + Math.abs(s.lon).toFixed(1) + '°W';
  }

  function renderSeedList() {
    var ul = $('seed-list'); ul.innerHTML = '';
    seeds.forEach(function (s, i) {
      var li = document.createElement('li');
      li.className = 'seed-item'; li.dataset.idx = i;
      li.innerHTML = '<span class="seed-dot" style="background:' + SEED_COLORS[i] + '"></span>' +
        '<span><span class="seed-label">Seed ' + SEED_LABELS[i] + '</span>' +
        '<br><span class="seed-loc">' + fmtLoc(s) + '</span></span>';
      li.addEventListener('click', function () { selectSeed(i); });
      ul.appendChild(li);
    });
  }

  function selectSeed(i) {
    chosenIdx = i;
    seedMarkers.forEach(function (m, k) { m.setIcon(seedIcon(k, k === i)); });
    Array.prototype.forEach.call($('seed-list').children, function (li, k) {
      li.classList.toggle('selected', k === i);
    });
    $('run-btn').disabled = false;
  }

  // ---- steering-flow particle layer (reuses the in-memory wind fields) ----
  function renderFlow() {
    if (!$('tog-flow').checked) {
      if (flowLayer && map.hasLayer(flowLayer)) map.removeLayer(flowLayer);
      return;
    }
    if (!flowLayer) flowLayer = new ParticleLayer();
    flowLayer.setField(env).setTime(env.startDayIdx);
    if (!map.hasLayer(flowLayer)) flowLayer.addTo(map);
  }

  // ---- shaded environment fields (global, drawn BELOW the flow, nullschool style) ----
  // Both shear and MPI are smooth filled rasters covering the data extent; only
  // one shows at a time. Coastlines are drawn on top so land stays legible.
  var FIELD_BBOX = { n: 60, s: 0, w: -180, e: 180 };  // NH-band pack extent (0–60N, all lon)
  var D2R = Math.PI / 180;
  function mercY(lat) { return Math.log(Math.tan(Math.PI / 4 + lat * D2R / 2)); }
  function latOfMercY(y) { return (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / D2R; }

  function fieldPane() {
    if (!map.getPane('fieldPane')) {
      var p = map.createPane('fieldPane');
      p.style.zIndex = 300; p.style.pointerEvents = 'none';   // below flow (350)
    }
    return 'fieldPane';
  }

  // Build a Mercator-warped shaded raster so it lands geographically correct on
  // the Web-Mercator map (rows linear in mercator-y; L.imageOverlay stretches it
  // linearly in projected space). sample(lat,lon)->value; color(value)->[r,g,b,a].
  function shadeFieldUrl(sample, color) {
    var b = FIELD_BBOX, W = 360;
    var yN = mercY(b.n), yS = mercY(b.s);
    var H = Math.round(W * (yN - yS) / ((b.e - b.w) * D2R));   // keep ~square pixels
    var cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    var ctx = cv.getContext('2d'), img = ctx.createImageData(W, H);
    for (var j = 0; j < H; j++) {
      var lat = latOfMercY(yN + (yS - yN) * j / (H - 1));
      for (var i = 0; i < W; i++) {
        var lon = b.w + (b.e - b.w) * i / (W - 1);
        var c = color(sample(lat, lon));
        var o = (j * W + i) * 4;
        img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = c[3];
      }
    }
    ctx.putImageData(img, 0, 0);
    return cv.toDataURL();
  }
  function fieldBounds() { return [[FIELD_BBOX.s, FIELD_BBOX.w], [FIELD_BBOX.n, FIELD_BBOX.e]]; }

  // Diverging shear ramp (kt): blue (favorable) below 20, red (hostile) above.
  var _SHEAR_STOPS = [
    [0, [37, 99, 175]], [10, [110, 168, 214]], [20, [205, 214, 224]],
    [30, [233, 128, 74]], [40, [192, 57, 43]],
  ];
  function lerp(a, b, t) { return [Math.round(a[0] + (b[0] - a[0]) * t), Math.round(a[1] + (b[1] - a[1]) * t), Math.round(a[2] + (b[2] - a[2]) * t)]; }
  function rampColor(stops, x) {
    if (x <= stops[0][0]) return stops[0][1];
    for (var k = 1; k < stops.length; k++) {
      if (x <= stops[k][0]) {
        var t = (x - stops[k - 1][0]) / (stops[k][0] - stops[k - 1][0]);
        return lerp(stops[k - 1][1], stops[k][1], t);
      }
    }
    return stops[stops.length - 1][1];
  }
  // Shear: diverging "favorability" ramp — blue (favorable) below 20 kt, red
  // (hostile) above. Red = hostile shear.
  var FAV_GRAD = 'linear-gradient(to right, rgb(37,99,175), rgb(110,168,214), rgb(205,214,224), rgb(233,128,74), rgb(192,57,43))';
  function favColor(hostility) { var c = rampColor(_SHEAR_STOPS, Math.max(0, Math.min(1, hostility)) * 40); return [c[0], c[1], c[2], 255]; }
  function shearShade(kt) { if (!isFinite(kt)) return [0, 0, 0, 0]; return favColor(kt / 40); }

  // Ocean potential (MPI): a Turbo-style ramp so the field reads as a distinct
  // "heat" map (visually unmistakable from the shear ramp). Low → indigo/blue,
  // high → red. High MPI = stronger storms possible.
  var TURBO_STOPS = [
    [0.00, [48, 18, 59]], [0.13, [64, 90, 211]], [0.25, [38, 150, 245]],
    [0.38, [27, 209, 198]], [0.50, [90, 228, 122]], [0.63, [177, 224, 50]],
    [0.75, [240, 190, 40]], [0.88, [248, 113, 32]], [1.00, [203, 35, 28]],
  ];
  var TURBO_GRAD = 'linear-gradient(to right, rgb(48,18,59) 0%, rgb(64,90,211) 13%, rgb(38,150,245) 25%, rgb(27,209,198) 38%, rgb(90,228,122) 50%, rgb(177,224,50) 63%, rgb(240,190,40) 75%, rgb(248,113,32) 88%, rgb(203,35,28) 100%)';
  function mpiShade(pi) { if (pi.land) return [0, 0, 0, 0]; var c = rampColor(TURBO_STOPS, Math.max(0, Math.min(1, pi.mpi / 160))); return [c[0], c[1], c[2], 255]; }

  function shearUrlAt(t) {
    return shadeFieldUrl(function (lat, lon) {
      var ms = ERA5.sampleTime(env.shear, t, lat, lon);
      return isFinite(ms) ? ms * 1.94384 : NaN;   // m/s -> kt
    }, shearShade);
  }

  // Coastlines (Natural Earth 110m via jsDelivr), drawn above the field so land
  // boundaries stay visible under the shading. Best-effort; absent if fetch fails.
  var _coastLayer = null, _coastPromise = null;
  function ensureCoastlines() {
    if (_coastLayer) return Promise.resolve(_coastLayer);
    if (_coastPromise) return _coastPromise;
    if (!map.getPane('coastPane')) {
      var p = map.createPane('coastPane'); p.style.zIndex = 320; p.style.pointerEvents = 'none';
    }
    _coastPromise = fetch('https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_110m_coastline.geojson')
      .then(function (r) { return r.json(); })
      .then(function (gj) {
        _coastLayer = L.geoJSON(gj, { pane: 'coastPane', interactive: false,
          style: { color: '#e3eaf6', weight: 0.8, opacity: 0.65, fill: false } });
        return _coastLayer;
      }).catch(function () { return null; });
    return _coastPromise;
  }
  function showCoastlines(on) {
    if (on) ensureCoastlines().then(function (l) { if (l && !map.hasLayer(l)) l.addTo(map); });
    else if (_coastLayer && map.hasLayer(_coastLayer)) map.removeLayer(_coastLayer);
  }

  // On-map colorbar reflecting whichever field is active (title + gradient + ticks).
  function updateMapLegend() {
    var el = $('map-legend');
    var kind = $('tog-shear').checked ? 'shear' : ($('tog-mpi').checked ? 'mpi' : null);
    if (!kind) { el.classList.add('hidden'); return; }
    // Shear: diverging blue(favorable)→red(hostile), ticks 0→40.
    // MPI: Turbo heat ramp, low→high (weaker→stronger storms possible), ticks 0→160.
    var cfg = kind === 'shear'
      ? { title: '200–850 hPa shear', unit: 'kt', ticks: ['0', '20', '40+'], grad: FAV_GRAD, sem: ['favorable', 'hostile'] }
      : { title: 'Ocean potential (MPI)', unit: 'kt', ticks: ['0', '80', '160'], grad: TURBO_GRAD, sem: ['weaker', 'stronger'] };
    el.innerHTML = '<div class="ml-title">' + cfg.title + ' <span class="ml-unit">(' + cfg.unit + ')</span></div>' +
      '<div class="ml-bar" style="background:' + cfg.grad + '"></div>' +
      '<div class="ml-ticks"><span>' + cfg.ticks.join('</span><span>') + '</span></div>' +
      '<div class="ml-sem"><span>' + cfg.sem[0] + '</span><span>' + cfg.sem[1] + '</span></div>';
    el.classList.remove('hidden');
  }
  function afterFieldToggle() {
    var anyField = $('tog-shear').checked || $('tog-mpi').checked;
    updateMapLegend();
    showCoastlines(anyField);
  }

  function renderShear() {
    var on = $('tog-shear').checked;
    if (on && mpiLayer && map.hasLayer(mpiLayer)) { $('tog-mpi').checked = false; map.removeLayer(mpiLayer); }
    if (!on) { if (shearLayer && map.hasLayer(shearLayer)) map.removeLayer(shearLayer); afterFieldToggle(); return; }
    var url = shearUrlAt(env.startDayIdx);
    if (shearLayer) shearLayer.setUrl(url);
    else shearLayer = L.imageOverlay(url, fieldBounds(), { opacity: 0.62, pane: fieldPane() });
    if (!map.hasLayer(shearLayer)) shearLayer.addTo(map);
    afterFieldToggle();
  }

  function renderMpi() {
    var on = $('tog-mpi').checked;
    if (on && shearLayer && map.hasLayer(shearLayer)) { $('tog-shear').checked = false; map.removeLayer(shearLayer); }
    if (!on) { if (mpiLayer && map.hasLayer(mpiLayer)) map.removeLayer(mpiLayer); afterFieldToggle(); return; }
    var url = shadeFieldUrl(function (lat, lon) { return MPI.atPoint(env.sst, lat, lon); }, mpiShade);
    if (mpiLayer) mpiLayer.setUrl(url);
    else mpiLayer = L.imageOverlay(url, fieldBounds(), { opacity: 0.55, pane: fieldPane() });
    if (!map.hasLayer(mpiLayer)) mpiLayer.addTo(map);
    afterFieldToggle();
  }

  // ---- simulate + reveal ----
  function runSimulation() {
    if (chosenIdx < 0) return;
    $('run-btn').disabled = true;
    status('Integrating storms…');
    setTimeout(function () { // let UI paint
      results = Model.runSeeds(env, seeds);
      status('');
      showStage('result');
      revealResults();
      animateTrack(chosenIdx);
    }, 30);
  }

  function bestIdx() {
    var bi = 0; for (var i = 1; i < results.length; i++) if (results[i].ace > results[bi].ace) bi = i;
    return bi;
  }

  function drawTrackPolyline(i, upto, faint) {
    var r = results[i], pts = r.track;
    var end = upto == null ? pts.length : upto;
    for (var k = 1; k < end; k++) {
      var seg = [[pts[k - 1].lat, pts[k - 1].lon], [pts[k].lat, pts[k].lon]];
      L.polyline(seg, {
        color: faint ? '#5b6b8c' : colorForV(pts[k].v),
        weight: faint ? 1.5 : 3.5, opacity: faint ? 0.5 : 0.95,
      }).addTo(trackLayer);
    }
  }

  var HRS_PER_FRAME = 0.7;   // ~1 day per ~1.1 s at 30 fps
  var FRAME_MS = 33;
  var SHEAR_REBUILD_HR = 12; // re-shade shear every 12 sim-hours

  function animateTrack(i) {
    var token = ++animToken;                 // supersede any running animation
    trackLayer.clearLayers();
    results.forEach(function (r, k) { if (k !== i) drawTrackPolyline(k, null, true); });

    var pts = results[i].track;
    var head = L.circleMarker([pts[0].lat, pts[0].lon],
      { radius: 6, color: '#fff', weight: 2, fillColor: colorForV(pts[0].v), fillOpacity: 1 }).addTo(trackLayer);
    // Reset the evolving overlays + clock to the start time.
    if (flowLayer && map.hasLayer(flowLayer)) flowLayer.setTime(env.startDayIdx);
    if (shearLayer) shearLayer.setUrl(shearUrlAt(env.startDayIdx));
    updateClock(0);

    var maxHr = pts[pts.length - 1].hr, simHr = 0, drawn = 1, lastMs = 0, lastShearHr = 0;
    function frame(ts) {
      if (token !== animToken) return;       // a newer animation took over
      if (ts - lastMs < FRAME_MS) { requestAnimationFrame(frame); return; }
      lastMs = ts;
      simHr = Math.min(maxHr, simHr + HRS_PER_FRAME);
      var upto = Math.min(pts.length, Math.floor(simHr) + 1);
      for (var s = drawn; s < upto; s++) {
        L.polyline([[pts[s - 1].lat, pts[s - 1].lon], [pts[s].lat, pts[s].lon]],
          { color: colorForV(pts[s].v), weight: 3.5, opacity: 0.95 }).addTo(trackLayer);
      }
      drawn = upto;
      var p = pts[Math.min(pts.length - 1, upto - 1)];
      head.setLatLng([p.lat, p.lon]);
      head.setStyle({ fillColor: colorForV(p.v), radius: 5 + p.v / 22 });
      head.bindTooltip('Day ' + (p.hr / 24).toFixed(1) + ' · ' + p.cat + ' · ' + Math.round(p.v) + ' kt',
        { className: 'track-tip', permanent: false });
      // Evolve the steering flow + shaded shear field + clock forward with the storm.
      updateClock(p.hr);
      if (flowLayer && map.hasLayer(flowLayer)) flowLayer.setTime(env.startDayIdx + p.hr / 24);
      if (shearLayer && p.hr - lastShearHr >= SHEAR_REBUILD_HR) {
        lastShearHr = p.hr; shearLayer.setUrl(shearUrlAt(env.startDayIdx + p.hr / 24));
      }
      if (simHr < maxHr) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  function revealResults() {
    var bi = bestIdx(), chosen = results[chosenIdx], best = results[bi];
    var pct = best.ace > 0 ? Math.round(100 * chosen.ace / best.ace) : 100;

    // Record this round's score and update the running total.
    game.rows.push({
      round: game.round, date: elDealDate.textContent, label: SEED_LABELS[chosenIdx],
      ace: chosen.ace, bestAce: best.ace, cat: chosen.peakCat, peakV: chosen.peakV, points: pct,
    });
    game.total += pct; game.totalAce += chosen.ace;
    updateScoreBadge();

    // Was there actually a "monster" to miss? Only if the best seed became a
    // hurricane — otherwise it was a hostile round and missing isn't on you.
    var hadMonster = best.peakV >= 64;
    var v = $('verdict'), cls, msg;
    if (chosenIdx === bi) {
      cls = 'win';
      msg = hadMonster ? '🎯 Bullseye — you picked the best seed!'
                       : '🎯 Best of a quiet bunch — you found the strongest!';
    } else if (!hadMonster) {
      cls = 'ok'; msg = '😐 Quiet round — nothing really spun up.';
    } else if (pct >= 75) {
      cls = 'ok'; msg = '👍 Close — a strong pick.';
    } else {
      cls = 'miss'; msg = '🌬️ Missed the monster.';
    }
    v.className = 'verdict ' + cls; v.textContent = msg;

    $('score-line').innerHTML = 'Your seed ' + SEED_LABELS[chosenIdx] + ' made <b>' +
      chosen.ace.toFixed(1) + ' ACE</b> — ' + pct + '% of the best (seed ' + SEED_LABELS[bi] + ', ' +
      best.ace.toFixed(1) + ') → <b>+' + pct + ' pts</b>.';

    $('next-btn').textContent = game.round < ROUNDS ? 'Next round →' : 'See final results 🏆';

    var ul = $('result-list'); ul.innerHTML = '';
    results.map(function (r, i) { return { r: r, i: i }; })
      .sort(function (a, b2) { return b2.r.ace - a.r.ace; })
      .forEach(function (o) {
        var r = o.r, i = o.i, li = document.createElement('li');
        li.className = 'result-item' + (i === bi ? ' best' : '') + (i === chosenIdx ? ' chosen' : '');
        li.innerHTML = '<span class="seed-dot" style="background:' + SEED_COLORS[i] + '"></span>' +
          '<span><b>Seed ' + SEED_LABELS[i] + '</b> ' +
          '<span class="result-tag">peak ' + (r.peakCat.length === 1 ? 'Cat ' : '') + r.peakCat +
          ' · ' + Math.round(r.peakV) + ' kt</span></span>' +
          '<span class="result-ace">' + r.ace.toFixed(1) + ' ACE</span>';
        ul.appendChild(li);
      });

    $('teach').innerHTML = teachText(chosen, best, chosenIdx, bi);
    drawIntensityChart();
  }

  function describe(r) {
    if (r.endReason === 'left-basin') return 'crossed Central America into the East Pacific ' +
      '— out of the Atlantic basin, so its ACE there doesn’t count';
    if (r.peakV < 34) return 'never organized past a depression';
    if (r.madeLandfall && r.peakV < 85) return 'made landfall and spun down before maturing';
    if (r.maxShear > 18 && r.peakV < 85) return 'ran into hostile shear (~' + Math.round(r.maxShear) + ' m/s)';
    if (r.recurved) return 'recurved into the open North Atlantic';
    if (r.peakV >= 96) return 'sat over warm, low-shear water and roared to a major ' +
      'hurricane (Cat ' + r.peakCat + ', ' + Math.round(r.peakV) + ' kt)';
    if (r.peakV >= 64) return 'became a Cat ' + r.peakCat + ' hurricane (' +
      Math.round(r.peakV) + ' kt)';
    return 'held on as a ' + Math.round(r.peakV) + '-kt tropical storm';
  }

  function teachText(chosen, best, ci, bi) {
    var hadMonster = best.peakV >= 64;
    if (!hadMonster) {
      // No seed reached hurricane strength — a hostile round, not a bad pick.
      return 'A hostile round — every seed ran into shear, dry air, or land, so even the ' +
        'best (<b>seed ' + SEED_LABELS[bi] + '</b>) only reached ' + Math.round(best.peakV) +
        ' kt. No monster to be had this time; some weeks the basin just won’t cooperate.';
    }
    if (ci === bi) {
      return '<b>Seed ' + SEED_LABELS[ci] + '</b> ' + describe(chosen) +
        ', and no other seed found a better environment. Warm SST + weak shear + a long ' +
        'fetch over open ocean is the ACE recipe.';
    }
    return '<b>Your seed ' + SEED_LABELS[ci] + '</b> ' + describe(chosen) +
      '. Meanwhile <b>seed ' + SEED_LABELS[bi] + '</b> ' + describe(best) +
      ' — that’s where the environment was kindest.';
  }

  function drawIntensityChart() {
    var cv = $('intensity-chart'), w = cv.width, h = cv.height, ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    // Dynamic x-axis: span the longest track in this round (rounded to days).
    var maxTrackHr = 24;
    results.forEach(function (r) { maxTrackHr = Math.max(maxTrackHr, r.track[r.track.length - 1].hr); });
    var maxHr = Math.ceil(maxTrackHr / 24) * 24, maxV = 160, maxSh = 40; // maxSh in kt
    var padL = 28, padB = 16, padT = 8, padR = 6;
    function X(hr) { return padL + (w - padL - padR) * hr / maxHr; }
    function Y(v) { return padT + (h - padT - padB) * (1 - v / maxV); }
    function Ysh(kt) { return padT + (h - padT - padB) * (1 - kt / maxSh); }

    ctx.strokeStyle = '#243352'; ctx.fillStyle = '#5b6b8c'; ctx.font = '9px sans-serif'; ctx.lineWidth = 1;
    [34, 64, 96, 137].forEach(function (lv) {
      ctx.beginPath(); ctx.moveTo(padL, Y(lv)); ctx.lineTo(w - padR, Y(lv)); ctx.stroke();
      ctx.fillText(lv + 'kt', 2, Y(lv) + 3);
    });

    // Optional: shear (kt) the storm experienced, as a neutral dashed line on a
    // 0-40 kt scale. Kept colour-neutral so it never reads as a V (intensity)
    // segment, which is coloured by Saffir-Simpson category.
    var showShear = $('tog-track-shear') && $('tog-track-shear').checked;
    var cpts = results[chosenIdx].track;
    if (showShear) {
      ctx.setLineDash([4, 3]); ctx.strokeStyle = 'rgba(214,224,242,0.85)'; ctx.lineWidth = 1.4;
      ctx.beginPath();
      cpts.forEach(function (p, k) {
        var x = X(p.hr), y = Ysh(p.shear * 1.94384);    // m/s -> kt
        k ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(214,224,242,0.95)';
      ctx.fillText('40kt', w - padR - 22, Ysh(40) + 8); ctx.fillText('shear', w - padR - 32, h - 4);
    }

    // Faint context tracks for the other seeds.
    results.forEach(function (r, i) {
      if (i === chosenIdx) return;
      ctx.strokeStyle = '#39466a'; ctx.lineWidth = 1; ctx.beginPath();
      r.track.forEach(function (p, k) { var x = X(p.hr), yv = Y(p.v); k ? ctx.lineTo(x, yv) : ctx.moveTo(x, yv); });
      ctx.stroke();
    });

    // Chosen storm, colored by intensity.
    ctx.lineWidth = 2.4;
    for (var k = 1; k < cpts.length; k++) {
      ctx.strokeStyle = colorForV(cpts[k].v); ctx.beginPath();
      ctx.moveTo(X(cpts[k - 1].hr), Y(cpts[k - 1].v)); ctx.lineTo(X(cpts[k].hr), Y(cpts[k].v)); ctx.stroke();
    }
    ctx.fillStyle = '#93a4c4';
    ctx.fillText('day 0', X(0) + 2, h - 4);
    ctx.fillText('day ' + (maxHr / 24), X(maxHr) - 30, h - 4);
  }

  // ---- reset ----
  function resetRound() {
    env = null; seeds = []; results = null; chosenIdx = -1;
    animToken++;                                    // stop any running animation
    if (seedLayer) seedLayer.clearLayers();
    if (trackLayer) trackLayer.clearLayers();
    // Detach the heat fields (rebuilt for the new month by renderShear/renderMpi).
    if (mpiLayer && map.hasLayer(mpiLayer)) map.removeLayer(mpiLayer);
    if (shearLayer && map.hasLayer(shearLayer)) map.removeLayer(shearLayer);
    $('run-btn').disabled = true;
  }

  // ---- game flow ----
  function updateScoreBadge() {
    var b = $('score-badge');
    b.classList.remove('hidden');
    b.textContent = game.totalAce.toFixed(1) + ' ACE';   // headline score = summed ACE
  }

  function startGame() {
    game = { round: 1, total: 0, totalAce: 0, rows: [] };
    updateScoreBadge();
    dealRound();
  }

  function nextOrFinish() {
    if (game.round < ROUNDS) { game.round += 1; dealRound(); }
    else showSummary();
  }

  function replayAnimation() {
    if (results && chosenIdx >= 0) animateTrack(chosenIdx);
  }

  function showSummary() {
    animToken++;
    var BEST_KEY = 'seedstorm_best_ace';
    var prevBest = parseFloat(window.localStorage.getItem(BEST_KEY) || '0');
    var isBest = game.totalAce > prevBest;
    if (isBest) window.localStorage.setItem(BEST_KEY, game.totalAce.toFixed(1));
    var avgPct = Math.round(game.total / ROUNDS);

    $('summary-total').innerHTML = 'You scored <b>' + game.totalAce.toFixed(1) + ' ACE</b>' +
      ' &nbsp;·&nbsp; <span class="muted">picked ' + avgPct + '% of the best on average</span>';

    var ul = $('summary-list'); ul.innerHTML = '';
    game.rows.forEach(function (r) {
      var li = document.createElement('li');
      li.className = 'summary-row';
      li.innerHTML = '<span><b>R' + r.round + '</b> · ' + r.date + '</span>' +
        '<span class="result-tag">seed ' + r.label + ' · ' +
        (r.cat.length === 1 ? 'Cat ' : '') + r.cat + ' · ' + r.points + '% of best</span>' +
        '<span class="sr-pts">' + r.ace.toFixed(1) + ' ACE</span>';
      ul.appendChild(li);
    });

    $('leaderboard').innerHTML = isBest
      ? '🏆 New personal best! <b>' + game.totalAce.toFixed(1) + ' ACE</b>'
      : 'Personal best: <b>' + Math.max(prevBest, game.totalAce).toFixed(1) + ' ACE</b> &nbsp;·&nbsp; ' +
        '(global leaderboard coming soon)';
    showStage('summary');
  }

  // ---- wire up ----
  function init() {
    initMap();
    $('start-btn').addEventListener('click', startGame);   // intro -> begin 5 rounds
    $('deal-btn').addEventListener('click', startGame);     // topbar "New game" -> restart
    $('run-btn').addEventListener('click', runSimulation);  // "Choose this seed"
    $('next-btn').addEventListener('click', nextOrFinish);  // "Next round" / "See final results"
    $('replay-btn').addEventListener('click', replayAnimation);
    $('again-btn').addEventListener('click', startGame);    // summary -> play again
    // Independent layers: flow (base) + optional shear contours + optional MPI.
    $('tog-flow').addEventListener('change', function () { if (env) renderFlow(); });
    $('tog-shear').addEventListener('change', function () { if (env) renderShear(); });
    $('tog-mpi').addEventListener('change', function () { if (env) renderMpi(); });
    $('tog-track-shear').addEventListener('change', function () { if (results) drawIntensityChart(); });
    showStage('intro');
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
