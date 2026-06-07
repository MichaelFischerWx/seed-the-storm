/* game.js — round loop: deal -> place seeds -> pick -> simulate -> reveal -> score. */
(function () {
  'use strict';

  // ---- config ----
  var YEARS = []; for (var y = 1991; y <= 2020; y++) YEARS.push(y);
  var N_SEEDS = 4;
  var SEED_COLORS = ['#5FD0E6', '#E8C26A', '#A98AC7', '#E0795F'];
  var SEED_LABELS = ['A', 'B', 'C', 'D'];
  var MONTH_NAMES = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                     'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Northern-Hemisphere basins. `months` = the 6 rounds' months (data currently
  // supports Jun–Nov start months for all basins; NIO's true Apr–Jun/Oct–Dec
  // season drops in here once the pack is extended). `box` bounds seed placement;
  // `excludeEPac` makes Atlantic storms that cross into the East Pacific stop
  // counting (their ACE belongs to a different basin). `view` frames the map.
  var BASINS = {
    atl:  { key: 'atl',  name: 'N. Atlantic', short: 'ATL',  months: [6, 7, 8, 9, 10, 11],
            box: { latMin: 7, latMax: 34, lonMin: -98, lonMax: -12 }, view: { center: [24, -54], zoom: 4.4 }, excludeEPac: true },
    epac: { key: 'epac', name: 'E. Pacific',  short: 'EPAC', months: [6, 7, 8, 9, 10, 11],
            box: { latMin: 8, latMax: 24, lonMin: -138, lonMax: -92 }, view: { center: [15, -114], zoom: 4.3 } },
    wpac: { key: 'wpac', name: 'W. Pacific',  short: 'WPAC', months: [6, 7, 8, 9, 10, 11],
            box: { latMin: 5, latMax: 30, lonMin: 122, lonMax: 168 }, view: { center: [18, 142], zoom: 4.1 } },
    nio:  { key: 'nio',  name: 'N. Indian',   short: 'NIO',  months: [6, 7, 8, 9, 10, 11],
            box: { latMin: 6, latMax: 23, lonMin: 55, lonMax: 95 }, view: { center: [14, 76], zoom: 4.6 } },
  };
  var BASIN_KEYS = ['atl', 'epac', 'wpac', 'nio'];
  var MODE_LABEL = { atl: 'Atlantic', epac: 'E. Pacific', wpac: 'W. Pacific', nio: 'N. Indian', nh: 'Random NH' };
  var MODES = ['atl', 'epac', 'wpac', 'nio', 'nh'];
  var selectedMode = 'atl';

  // ---- state ----
  var map, seedLayer, trackLayer, mpiLayer = null, flowLayer = null, shearLayer = null;
  var env = null, seeds = [], results = null, chosenIdx = -1, dealDate = null;

  var seedMarkers = [];
  var attractToken = 0, attractLayer = null, attractCap = null;   // home-screen preview

  // ---- DOM ----
  var $ = function (id) { return document.getElementById(id); };
  var elDealDate = $('deal-date'), elStatus = $('status');
  var stages = { intro: $('stage-intro'), pick: $('stage-pick'),
                 result: $('stage-result'), summary: $('stage-summary') };

  // ---- game state (6 rounds, one per in-season month) ----
  var ROUNDS = 6;
  var game = { round: 0, year: 0, total: 0, totalAce: 0, rows: [], mode: 'atl' };
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
    elStatus.classList.toggle('error', !!isErr);
    elStatus.innerHTML = '';
    if (!msg) return;
    if (!isErr) { var sp = document.createElement('span'); sp.className = 'spinner'; elStatus.appendChild(sp); }
    var t = document.createElement('span'); t.textContent = msg; elStatus.appendChild(t);
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
    // Lock the view to the data band (0–60 °N, all lon) so the field always
    // fills the frame and the edges read as the map's frame, not missing data.
    map = L.map('map', {
      worldCopyJump: false, minZoom: 4, maxZoom: 8, zoomSnap: 0.5, zoomDelta: 0.5,
      maxBounds: [[0, -180], [60, 180]], maxBoundsViscosity: 1.0,
    }).setView([26, -52], 4.5);
    map.attributionControl.setPrefix(false);   // drop the "Leaflet" + flag prefix
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OSM &middot; CARTO &middot; ERA5/TC-ATLAS',
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

  // Google Analytics (GA4) custom event — no-ops when gtag isn't loaded (e.g.
  // local previews, or before the snippet runs). Lets us see basin engagement.
  function track(event, params) {
    if (typeof window.gtag === 'function') window.gtag('event', event, params || {});
  }

  function dealRound() {
    status('Dealing… fetching ERA5 fields');
    resetRound();
    // Pick the basin for this round. Fixed-basin modes step through that basin's
    // 6 months in order; Random-NH mode draws a random basin + month each round.
    var basin, month;
    if (game.mode === 'nh') {
      basin = BASINS[pick(BASIN_KEYS)];
      month = pick(basin.months);
    } else {
      basin = BASINS[game.mode];
      month = basin.months[game.round - 1];
    }
    var year = pick(YEARS);
    $('round-label').textContent = 'Round ' + game.round + ' / ' + ROUNDS + ' · ' + MONTH_NAMES[month];
    $('basin-name').textContent = basin.name + ' · ';
    track('basin_round', { mode: game.mode, basin: basin.key, month: MONTH_NAMES[month], round: game.round });

    ERA5.loadManifest().then(function (man) {
      var nDays = man.daily['shear/' + year + '_' + (month < 10 ? '0' : '') + month].nDays;
      var day = 1 + ((Math.random() * nDays) | 0);
      var startDayIdx = day - 1;
      dealDate = { year: year, month: month, day: day, basin: basin.key };
      elDealDate.textContent = MONTH_NAMES[month] + ' ' + day + ', ' + year;
      if (basin.view) map.setView(basin.view.center, basin.view.zoom, { animate: false });

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
                sst: f[3], startDayIdx: startDayIdx, excludeEPac: !!basin.excludeEPac };
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

  // Climatological genesis hot-spots by basin & month: each a weighted Gaussian
  // blob {lat, lon, sd, w}. Seeds are drawn from this mixture so they land in
  // realistic, month-appropriate spots. Approximate (educational weighting), not
  // an official climatology. ATL migrates Gulf/Caribbean (Jun) → MDR off Africa
  // (Aug–Sep) → Caribbean (Oct–Nov); EPAC sits off Mexico/Cent. America; WPAC in
  // the monsoon trough 125–160°E; NIO in the Bay of Bengal + Arabian Sea (sparse
  // in the Jul–Aug monsoon, active Oct–Nov post-monsoon).
  var BASIN_GENESIS = {
    atl: {
      6:  [{ lat: 25, lon: -90, sd: 3, w: 3 }, { lat: 18, lon: -83, sd: 3, w: 2 }, { lat: 28, lon: -78, sd: 3, w: 2 }, { lat: 14, lon: -60, sd: 3, w: 1 }],
      7:  [{ lat: 25, lon: -88, sd: 3, w: 2 }, { lat: 16, lon: -70, sd: 3, w: 2 }, { lat: 27, lon: -72, sd: 3, w: 2 }, { lat: 14, lon: -45, sd: 4, w: 2 }, { lat: 13, lon: -30, sd: 3, w: 1 }],
      8:  [{ lat: 13, lon: -35, sd: 4, w: 3 }, { lat: 12, lon: -23, sd: 3, w: 2 }, { lat: 15, lon: -55, sd: 4, w: 2 }, { lat: 17, lon: -68, sd: 3, w: 2 }, { lat: 25, lon: -88, sd: 3, w: 1.5 }, { lat: 27, lon: -68, sd: 3, w: 1.5 }],
      9:  [{ lat: 13, lon: -30, sd: 4, w: 3 }, { lat: 14, lon: -45, sd: 4, w: 3 }, { lat: 12, lon: -22, sd: 3, w: 2 }, { lat: 16, lon: -60, sd: 4, w: 2 }, { lat: 18, lon: -72, sd: 3, w: 2 }, { lat: 25, lon: -86, sd: 3, w: 1.5 }, { lat: 28, lon: -66, sd: 3, w: 1.5 }],
      10: [{ lat: 15, lon: -80, sd: 3, w: 3 }, { lat: 13, lon: -83, sd: 3, w: 2 }, { lat: 18, lon: -68, sd: 3, w: 2 }, { lat: 27, lon: -70, sd: 3, w: 2 }, { lat: 25, lon: -90, sd: 3, w: 1.5 }, { lat: 14, lon: -45, sd: 4, w: 1 }],
      11: [{ lat: 14, lon: -78, sd: 3, w: 3 }, { lat: 15, lon: -65, sd: 3, w: 2 }, { lat: 27, lon: -62, sd: 4, w: 1.5 }],
    },
    epac: {
      6:  [{ lat: 12, lon: -100, sd: 3, w: 3 }, { lat: 11, lon: -94, sd: 3, w: 2 }, { lat: 13, lon: -108, sd: 3, w: 2 }],
      7:  [{ lat: 13, lon: -106, sd: 3, w: 3 }, { lat: 12, lon: -98, sd: 3, w: 2 }, { lat: 14, lon: -114, sd: 4, w: 2 }, { lat: 15, lon: -122, sd: 4, w: 1 }],
      8:  [{ lat: 14, lon: -110, sd: 4, w: 3 }, { lat: 13, lon: -102, sd: 3, w: 2 }, { lat: 15, lon: -120, sd: 4, w: 2 }, { lat: 16, lon: -128, sd: 4, w: 1 }],
      9:  [{ lat: 14, lon: -112, sd: 4, w: 3 }, { lat: 13, lon: -104, sd: 3, w: 2 }, { lat: 15, lon: -122, sd: 4, w: 2 }, { lat: 12, lon: -97, sd: 3, w: 2 }],
      10: [{ lat: 13, lon: -106, sd: 3, w: 3 }, { lat: 12, lon: -100, sd: 3, w: 2 }, { lat: 14, lon: -112, sd: 3, w: 2 }],
      11: [{ lat: 12, lon: -102, sd: 3, w: 3 }, { lat: 11, lon: -98, sd: 3, w: 2 }, { lat: 13, lon: -108, sd: 3, w: 1 }],
    },
    wpac: {
      6:  [{ lat: 13, lon: 135, sd: 4, w: 3 }, { lat: 15, lon: 128, sd: 4, w: 2 }, { lat: 11, lon: 142, sd: 4, w: 2 }, { lat: 16, lon: 150, sd: 4, w: 1 }],
      7:  [{ lat: 16, lon: 134, sd: 4, w: 3 }, { lat: 18, lon: 128, sd: 4, w: 2 }, { lat: 14, lon: 145, sd: 4, w: 2 }, { lat: 19, lon: 140, sd: 4, w: 2 }, { lat: 13, lon: 155, sd: 4, w: 1 }],
      8:  [{ lat: 18, lon: 132, sd: 4, w: 3 }, { lat: 20, lon: 128, sd: 4, w: 2 }, { lat: 16, lon: 142, sd: 4, w: 2 }, { lat: 19, lon: 150, sd: 4, w: 2 }, { lat: 15, lon: 158, sd: 4, w: 1 }],
      9:  [{ lat: 17, lon: 134, sd: 4, w: 3 }, { lat: 19, lon: 130, sd: 4, w: 2 }, { lat: 15, lon: 144, sd: 4, w: 2 }, { lat: 18, lon: 152, sd: 4, w: 2 }, { lat: 14, lon: 160, sd: 4, w: 1 }],
      10: [{ lat: 15, lon: 135, sd: 4, w: 3 }, { lat: 13, lon: 143, sd: 4, w: 2 }, { lat: 16, lon: 128, sd: 4, w: 2 }, { lat: 12, lon: 152, sd: 4, w: 2 }, { lat: 14, lon: 160, sd: 4, w: 1 }],
      11: [{ lat: 13, lon: 138, sd: 4, w: 3 }, { lat: 11, lon: 145, sd: 4, w: 2 }, { lat: 14, lon: 132, sd: 4, w: 2 }, { lat: 10, lon: 152, sd: 4, w: 2 }],
    },
    nio: {
      6:  [{ lat: 16, lon: 65, sd: 3, w: 2 }, { lat: 13, lon: 68, sd: 3, w: 2 }, { lat: 17, lon: 88, sd: 3, w: 2 }, { lat: 14, lon: 90, sd: 3, w: 1 }],
      7:  [{ lat: 19, lon: 88, sd: 3, w: 2 }, { lat: 20, lon: 86, sd: 3, w: 1 }],
      8:  [{ lat: 20, lon: 88, sd: 3, w: 2 }, { lat: 19, lon: 86, sd: 3, w: 1 }],
      9:  [{ lat: 18, lon: 89, sd: 3, w: 2 }, { lat: 16, lon: 90, sd: 3, w: 2 }, { lat: 19, lon: 87, sd: 3, w: 1 }],
      10: [{ lat: 14, lon: 87, sd: 3, w: 3 }, { lat: 15, lon: 90, sd: 3, w: 2 }, { lat: 13, lon: 65, sd: 3, w: 2 }, { lat: 15, lon: 68, sd: 3, w: 1 }],
      11: [{ lat: 12, lon: 84, sd: 3, w: 3 }, { lat: 13, lon: 88, sd: 3, w: 2 }, { lat: 11, lon: 90, sd: 3, w: 2 }, { lat: 13, lon: 66, sd: 3, w: 1 }],
    },
  };
  function gauss() { return Math.sqrt(-2 * Math.log(Math.random() + 1e-9)) * Math.cos(2 * Math.PI * Math.random()); }
  function sampleGenesis(basinKey, month) {
    var byMonth = BASIN_GENESIS[basinKey] || BASIN_GENESIS.atl;
    var blobs = byMonth[month] || byMonth[9] || byMonth[Object.keys(byMonth)[0]];
    var tot = 0; blobs.forEach(function (b) { tot += b.w; });
    var r = Math.random() * tot, b = blobs[0];
    for (var i = 0; i < blobs.length; i++) { r -= blobs[i].w; if (r <= 0) { b = blobs[i]; break; } }
    return { lat: b.lat + gauss() * b.sd, lon: b.lon + gauss() * b.sd };
  }
  function farEnough(lat, lon) { return seeds.every(function (s) { return Math.hypot(s.lat - lat, s.lon - lon) > 6; }); }

  function placeSeeds() {
    seeds = [];
    var basin = BASINS[dealDate.basin], box = basin.box, month = dealDate.month, tries = 0;
    function inBox(lat, lon) { return lat >= box.latMin && lat <= box.latMax && lon >= box.lonMin && lon <= box.lonMax; }
    // Sample from the basin/month genesis climatology (over warm ocean, spread out).
    while (seeds.length < N_SEEDS && tries < 1200) {
      tries++;
      var p = sampleGenesis(basin.key, month);
      if (!inBox(p.lat, p.lon)) continue;
      if (!isOcean(p.lat, p.lon) || !farEnough(p.lat, p.lon)) continue;
      seeds.push({ lat: p.lat, lon: p.lon });
    }
    // Fallback (rare): top up with broad random draws inside the basin box.
    while (seeds.length < N_SEEDS && tries < 2000) {
      tries++;
      var lat = rand(box.latMin + 2, box.latMax - 2), lon = rand(box.lonMin + 4, box.lonMax - 4);
      if (isOcean(lat, lon) && farEnough(lat, lon)) seeds.push({ lat: lat, lon: lon });
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
    if (seedMarkers.length) map.fitBounds(grp.getBounds().pad(0.25), { animate: false, maxZoom: 5, padding: [24, 24] });
  }

  function fmtLoc(s) {
    return Math.abs(s.lat).toFixed(1) + '°' + (s.lat < 0 ? 'S' : 'N') + ', ' +
      Math.abs(s.lon).toFixed(1) + '°' + (s.lon < 0 ? 'W' : 'E');
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
  function updateMapLegend(forceKind) {
    var el = $('map-legend');
    var kind = forceKind || ($('tog-shear').checked ? 'shear' : ($('tog-mpi').checked ? 'mpi' : null));
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

    // Did any seed actually reach hurricane strength? If not, it was a hostile
    // round and a lower score isn't on the player.
    var hadHurricane = best.peakV >= 64;
    var v = $('verdict'), cls, msg, icon;
    if (chosenIdx === bi) {
      cls = 'win';
      if (hadHurricane) { icon = 'ic-target'; msg = 'Bullseye — you picked the best seed!'; }
      else { icon = 'ic-trophy'; msg = 'Best of a quiet bunch — you found the strongest!'; }
    } else if (!hadHurricane) {
      cls = 'ok'; icon = 'ic-neutral'; msg = 'Quiet round — nothing really spun up.';
    } else if (pct >= 75) {
      cls = 'ok'; icon = 'ic-check'; msg = 'Close — a strong pick.';
    } else {
      cls = 'miss'; icon = 'ic-wind'; msg = 'A stronger storm was in reach.';
    }
    v.className = 'verdict ' + cls;
    v.innerHTML = '<svg class="v-ic"><use href="#' + icon + '"/></svg>';
    var vmsg = document.createElement('span'); vmsg.textContent = msg; v.appendChild(vmsg);

    $('score-line').innerHTML = 'Your seed ' + SEED_LABELS[chosenIdx] + ' made <b>' +
      chosen.ace.toFixed(1) + ' ACE</b> — ' + pct + '% of the best (seed ' + SEED_LABELS[bi] + ', ' +
      best.ace.toFixed(1) + ') → <b>+' + pct + ' pts</b>.';

    $('next-btn').textContent = game.round < ROUNDS ? 'Next round →' : 'See final results';

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

    var kt = Math.round(r.peakV);
    var peak = r.peakV >= 96 ? 'a major hurricane (Cat ' + r.peakCat + ', ' + kt + ' kt)'
             : r.peakV >= 64 ? 'a Cat ' + r.peakCat + ' hurricane (' + kt + ' kt)'
             : 'a ' + kt + '-kt tropical storm';

    // Landfall is the headline if it happened — a storm that hit land isn't a
    // clean recurve, so this is checked before the recurve branch.
    if (r.madeLandfall) {
      return r.peakV >= 64 ? 'peaked as ' + peak + ' and made landfall'
                           : 'made landfall and spun down before maturing';
    }
    if (r.maxShear > 18 && r.peakV < 85) return 'ran into hostile shear (~' +
      Math.round(r.maxShear) + ' m/s) and never matured';
    if (r.recurved) return 'reached ' + peak + ', recurving into the open North Atlantic';
    if (r.peakV >= 96) return 'sat over warm, low-shear water and roared to ' + peak;
    if (r.peakV >= 64) return 'became ' + peak;
    return 'held on as ' + peak;
  }

  function teachText(chosen, best, ci, bi) {
    var hadHurricane = best.peakV >= 64;
    if (!hadHurricane) {
      // No seed reached hurricane strength — a hostile round, not a bad pick.
      return 'A hostile round — every seed ran into shear, dry air, or land, so even the ' +
        'best (<b>seed ' + SEED_LABELS[bi] + '</b>) only reached ' + Math.round(best.peakV) +
        ' kt. No hurricane in the cards this time; some weeks the basin just won’t cooperate.';
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

  // Redraw the inset chart (and the expanded one if open).
  function drawIntensityChart() {
    renderChart($('intensity-chart'));
    if (!$('chart-modal').classList.contains('hidden')) renderChart($('chart-modal-canvas'));
  }

  // Draw the intensity (+ optional shear) chart crisply into any canvas, scaling
  // type/line weights to the canvas size so it reads well small or expanded.
  function renderChart(cv) {
    if (!results || chosenIdx < 0) return;
    var dpr = window.devicePixelRatio || 1;
    var rect = cv.getBoundingClientRect();
    var w = Math.max(220, Math.round(rect.width)), h = Math.max(120, Math.round(rect.height));
    cv.width = w * dpr; cv.height = h * dpr;
    var ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, w, h);
    var big = w > 520;
    var fs = big ? 13 : 10, lwV = big ? 3.4 : 2.4;
    var padL = big ? 54 : 44, padR = big ? 46 : 34, padT = big ? 26 : 12, padB = big ? 26 : 16;

    var maxTrackHr = 24;
    results.forEach(function (r) { maxTrackHr = Math.max(maxTrackHr, r.track[r.track.length - 1].hr); });
    var maxHr = Math.ceil(maxTrackHr / 24) * 24, maxV = 160, maxSh = 40;
    function X(hr) { return padL + (w - padL - padR) * hr / maxHr; }
    function Y(v) { return padT + (h - padT - padB) * (1 - v / maxV); }
    function Ysh(kt) { return padT + (h - padT - padB) * (1 - kt / maxSh); }
    ctx.font = fs + "px 'DM Sans', system-ui, sans-serif"; ctx.textBaseline = 'middle';

    // Category gridlines + left (intensity) axis.
    ctx.strokeStyle = 'rgba(36,51,82,.85)'; ctx.fillStyle = '#687c9f'; ctx.lineWidth = 1;
    [34, 64, 96, 137].forEach(function (lv) {
      ctx.beginPath(); ctx.moveTo(padL, Y(lv)); ctx.lineTo(w - padR, Y(lv)); ctx.stroke();
      ctx.textAlign = 'right'; ctx.fillText(lv + ' kt', padL - 5, Y(lv));
    });

    var showShear = $('tog-track-shear') && $('tog-track-shear').checked;
    var showMpi = $('tog-track-mpi') && $('tog-track-mpi').checked;
    var cpts = results[chosenIdx].track;

    // Right (shear) axis ticks, drawn only when the shear line is on.
    if (showShear) {
      ctx.fillStyle = 'rgba(196,210,236,.8)'; ctx.textAlign = 'left';
      [0, 20, 40].forEach(function (s) { ctx.fillText(s, w - padR + 5, Ysh(s)); });
    }

    // Faint context tracks for the other seeds.
    results.forEach(function (r, i) {
      if (i === chosenIdx) return;
      ctx.strokeStyle = 'rgba(57,70,106,.9)'; ctx.lineWidth = big ? 1.4 : 1; ctx.beginPath();
      r.track.forEach(function (p, k) { var x = X(p.hr), yv = Y(p.v); k ? ctx.lineTo(x, yv) : ctx.moveTo(x, yv); });
      ctx.stroke();
    });

    // Gradient area fill under the chosen V curve.
    var baseY = Y(0), grad = ctx.createLinearGradient(0, padT, 0, baseY);
    grad.addColorStop(0, 'rgba(61,130,246,0.30)'); grad.addColorStop(1, 'rgba(61,130,246,0.02)');
    ctx.fillStyle = grad; ctx.beginPath(); ctx.moveTo(X(cpts[0].hr), baseY);
    for (var a = 0; a < cpts.length; a++) ctx.lineTo(X(cpts[a].hr), Y(cpts[a].v));
    ctx.lineTo(X(cpts[cpts.length - 1].hr), baseY); ctx.closePath(); ctx.fill();

    // Shear (kt) the storm experienced — neutral dashed line (0–40 kt scale).
    if (showShear) {
      ctx.setLineDash([5, 4]); ctx.strokeStyle = 'rgba(214,224,242,0.85)'; ctx.lineWidth = big ? 2 : 1.4;
      ctx.beginPath();
      cpts.forEach(function (p, k) { var x = X(p.hr), y = Ysh(p.shear * 1.94384); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.stroke(); ctx.setLineDash([]);
    }

    // Potential intensity (MPI, kt) — the ceiling the storm relaxes toward.
    // Same left axis as V, so the gap to the intensity curve is the unrealized
    // potential (lost to shear, dry air, land, or simply too little time).
    if (showMpi) {
      ctx.setLineDash([2, 3]); ctx.strokeStyle = 'rgba(232,194,106,0.9)'; ctx.lineWidth = big ? 2 : 1.5;
      ctx.beginPath();
      cpts.forEach(function (p, k) { var x = X(p.hr), y = Y(Math.min(maxV, p.mpi)); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.stroke(); ctx.setLineDash([]);
    }

    // Chosen storm V, coloured by Saffir–Simpson category.
    ctx.lineWidth = lwV; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (var k = 1; k < cpts.length; k++) {
      ctx.strokeStyle = colorForV(cpts[k].v); ctx.beginPath();
      ctx.moveTo(X(cpts[k - 1].hr), Y(cpts[k - 1].v)); ctx.lineTo(X(cpts[k].hr), Y(cpts[k].v)); ctx.stroke();
    }

    // Day axis (bottom).
    ctx.fillStyle = '#9fb1d0'; ctx.textAlign = 'left'; ctx.fillText('day 0', X(0), h - padB / 2);
    ctx.textAlign = 'right'; ctx.fillText('day ' + (maxHr / 24), w - padR, h - padB / 2);

    // Legend (top-left): intensity swatch + shear dash.
    ctx.textAlign = 'left';
    var lx = padL, ly = padT - (big ? 14 : 6);
    ctx.strokeStyle = '#ff9a3c'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(lx + 16, ly); ctx.stroke();
    ctx.fillStyle = '#9fb1d0'; ctx.fillText('intensity (kt)', lx + 22, ly);
    var lx2 = lx + (big ? 130 : 104);
    if (showShear) {
      ctx.setLineDash([5, 4]); ctx.strokeStyle = 'rgba(214,224,242,0.85)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(lx2, ly); ctx.lineTo(lx2 + 16, ly); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#9fb1d0'; ctx.fillText('shear (kt)', lx2 + 22, ly);
      lx2 += (big ? 96 : 78);
    }
    if (showMpi) {
      ctx.setLineDash([2, 3]); ctx.strokeStyle = 'rgba(232,194,106,0.9)'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(lx2, ly); ctx.lineTo(lx2 + 16, ly); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#9fb1d0'; ctx.fillText('MPI (kt)', lx2 + 22, ly);
    }
  }

  // ---- home-screen attract mode ----
  // Before the first round we show a LIVE sample environment (flowing steering +
  // shear field for a peak-season date) with the month's genesis hot-spots glowing,
  // so the landing previews exactly what the player works with — no blank map.
  function genesisPane() {
    if (!map.getPane('genesisPane')) {
      var p = map.createPane('genesisPane'); p.style.zIndex = 360; p.style.pointerEvents = 'none';
    }
    return 'genesisPane';
  }
  function renderGenesisHints(month) {
    if (attractLayer) { map.removeLayer(attractLayer); attractLayer = null; }
    attractLayer = L.layerGroup();
    (MONTH_GENESIS[month] || []).forEach(function (b) {
      L.circle([b.lat, b.lon], {
        pane: genesisPane(), radius: b.sd * 120000, interactive: false,
        color: '#2DBDA0', weight: 1, opacity: 0.38, dashArray: '3 6',
        fillColor: '#2DBDA0', fillOpacity: 0.06 + 0.015 * b.w,
      }).addTo(attractLayer);
    });
    attractLayer.addTo(map);
  }
  function showAttractCaption(month, year) {
    hideAttractCaption();
    attractCap = document.createElement('div');
    attractCap.className = 'attract-cap';
    attractCap.innerHTML = '<b>Sample environment · ' + MONTH_NAMES[month] + ' ' + year + '</b>' +
      '<span class="ac-sub">Green rings mark where storms tend to brew this month. Press <b>Start</b> to play.</span>';
    $('map').appendChild(attractCap);
  }
  function hideAttractCaption() {
    if (attractCap && attractCap.parentNode) attractCap.parentNode.removeChild(attractCap);
    attractCap = null;
  }
  function stopAttract() {
    attractToken++;
    hideAttractCaption();
    if (attractLayer && map.hasLayer(attractLayer)) map.removeLayer(attractLayer);
    attractLayer = null;
  }
  function startAttract() {
    var token = ++attractToken;
    ERA5.loadManifest().then(function (man) {
      if (token !== attractToken) return null;
      var year = pick(YEARS), month = 9;                       // Atlantic peak season
      var key = 'shear/' + year + '_0' + month;
      var nDays = (man.daily[key] || {}).nDays || 30;
      var day = Math.min(nDays, 10);
      return Promise.all([
        ERA5.loadDailyFieldSpan('steeru', year, month, 1),
        ERA5.loadDailyFieldSpan('steerv', year, month, 1),
        ERA5.loadDailyFieldSpan('shear', year, month, 1),
        ERA5.loadSST(month),
      ]).then(function (f) {
        if (token !== attractToken) return;
        env = { steeru: f[0], steerv: f[1], shear: f[2], sst: f[3], startDayIdx: day - 1 };
        if (!flowLayer) flowLayer = new ParticleLayer();
        flowLayer.setField(env).setTime(env.startDayIdx);
        if (!map.hasLayer(flowLayer)) flowLayer.addTo(map);
        var url = shearUrlAt(env.startDayIdx);
        if (shearLayer) shearLayer.setUrl(url);
        else shearLayer = L.imageOverlay(url, fieldBounds(), { opacity: 0.55, pane: fieldPane() });
        if (!map.hasLayer(shearLayer)) shearLayer.addTo(map);
        showCoastlines(true);
        // No colorbar on the home screen — it belongs to gameplay and would
        // just cover the preview (especially on mobile). It appears once a
        // round is dealt (renderShear → updateMapLegend).
        renderGenesisHints(month);
        showAttractCaption(month, year);
      });
    }).catch(function (e) { console.warn('attract preview unavailable:', e && e.message); });
  }

  // ---- reset ----
  function resetRound() {
    stopAttract();                                  // tear down the home-screen preview
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
    $('score-badge').classList.remove('hidden');
    $('score-badge-val').textContent = game.totalAce.toFixed(1) + ' ACE';   // headline score = summed ACE
  }

  function startGame() {
    game = { round: 1, total: 0, totalAce: 0, rows: [], mode: selectedMode };
    track('game_start', { mode: selectedMode });
    updateScoreBadge();
    dealRound();
  }

  // Return to the intro / basin picker and restore the live attract preview.
  function goHome() {
    resetRound();
    $('score-badge').classList.add('hidden');
    showStage('intro');
    startAttract();
  }

  function nextOrFinish() {
    if (game.round < ROUNDS) { game.round += 1; dealRound(); }
    else showSummary();
  }

  function replayAnimation() {
    if (results && chosenIdx >= 0) animateTrack(chosenIdx);
  }

  function openChartModal() {
    if (!results || chosenIdx < 0) return;
    $('chart-modal').classList.remove('hidden');
    renderChart($('chart-modal-canvas'));
  }
  function closeChartModal() { $('chart-modal').classList.add('hidden'); }

  function showSummary() {
    animToken++;
    var BEST_KEY = 'seedstorm_best_ace';
    var prevBest = parseFloat(window.localStorage.getItem(BEST_KEY) || '0');
    var isBest = game.totalAce > prevBest;
    if (isBest) window.localStorage.setItem(BEST_KEY, game.totalAce.toFixed(1));
    var avgPct = Math.round(game.total / ROUNDS);
    track('game_complete', { mode: game.mode, total_ace: Number(game.totalAce.toFixed(1)), best_storm_ace: Number(bestStormAce().toFixed(1)), avg_pct: avgPct });

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

    renderLeaderboard(game.totalAce, avgPct, isBest, prevBest);
    showStage('summary');
  }

  // ---- leaderboard (optional global board via Supabase; see js/leaderboard.js) ----
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // The best single-storm ACE this game = the highest chosen-seed ACE across rounds.
  function bestStormAce() {
    return game.rows.reduce(function (m, r) { return Math.max(m, r.ace); }, 0);
  }
  var lbMetric = 'total';                 // 'total' | 'storm'
  var lbViewMode = 'atl';                  // which basin board is displayed
  var lbCache = {};                        // mode -> { total:[], storm:[] }
  var lbMine = null;                       // {name, total, storm, mode} to highlight your row

  function lbVal(r, metric) { return metric === 'storm' ? r.best_storm_ace : r.total_ace; }
  function renderLbList() {
    var ol = $('lb-list'), board = lbCache[lbViewMode];
    if (!board) { ol.classList.add('hidden'); ol.innerHTML = ''; return; }   // still loading
    var rows = board[lbMetric] || [];
    if (!rows.length) {
      ol.classList.remove('hidden');
      ol.innerHTML = '<li class="lb-empty">No scores yet — be the first!</li>';
      return;
    }
    ol.innerHTML = rows.map(function (r, i) {
      var me = lbMine && lbMine.mode === lbViewMode && r.name === lbMine.name &&
        Math.abs(Number(lbVal(r, lbMetric)) - lbMine[lbMetric]) < 0.05;
      return '<li class="lb-entry' + (me ? ' me' : '') + '">' +
        '<span class="lb-rank">' + (i + 1) + '</span>' +
        '<span class="lb-name">' + escapeHtml(r.name) + '</span>' +
        '<span class="lb-ace">' + Number(lbVal(r, lbMetric)).toFixed(1) + ' ACE</span></li>';
    }).join('');
    ol.classList.remove('hidden');
  }
  function loadBoards(mode) {
    if (lbCache[mode]) { if (mode === lbViewMode) renderLbList(); return Promise.resolve(); }
    return Promise.all([Leaderboard.top('total', mode, 20), Leaderboard.top('storm', mode, 20)])
      .then(function (res) { lbCache[mode] = { total: res[0], storm: res[1] }; if (mode === lbViewMode) renderLbList(); });
  }
  function setLbMetric(metric) {
    lbMetric = metric;
    [].forEach.call(document.querySelectorAll('.lb-tab'), function (b) {
      b.classList.toggle('is-active', b.getAttribute('data-metric') === metric);
    });
    renderLbList();
  }
  function setLbViewMode(mode) {
    lbViewMode = mode;
    if ($('lb-basin').value !== mode) $('lb-basin').value = mode;
    renderLbList();          // show cached (or loading) immediately…
    loadBoards(mode);        // …then fill in
  }
  function renderLeaderboard(total, avgPct, isBest, prevBest) {
    // Personal best line (always shown — works with no backend).
    $('leaderboard').innerHTML = isBest
      ? '<svg class="lb-ic"><use href="#ic-trophy"/></svg> New personal best! <b>' + total.toFixed(1) + ' ACE</b>'
      : 'Personal best: <b>' + Math.max(prevBest, total).toFixed(1) + ' ACE</b>';

    var sub = $('lb-submit'), controls = $('lb-controls');
    if (!window.Leaderboard || !Leaderboard.configured()) {
      sub.classList.add('hidden'); controls.classList.add('hidden'); $('lb-list').classList.add('hidden'); return;
    }
    lbMine = null; lbCache = {};
    sub.classList.remove('hidden'); sub.classList.remove('done');
    var msg = $('lb-msg'); msg.textContent = ''; msg.className = 'lb-msg';
    var nm = $('lb-name'); nm.value = ''; nm.disabled = false;
    $('lb-submit-btn').disabled = false;
    controls.classList.remove('hidden');
    setLbMetric('total');
    setLbViewMode(game.mode);   // default to the basin you just played
  }
  function submitScore() {
    if (!window.Leaderboard || !Leaderboard.configured() || $('lb-name').disabled) return;
    var name = $('lb-name').value, msg = $('lb-msg');
    var err = Leaderboard.validName(name);
    if (err) { msg.textContent = err; msg.className = 'lb-msg err'; return; }
    $('lb-submit-btn').disabled = true;
    msg.textContent = 'Submitting…'; msg.className = 'lb-msg';
    var avgPct = Math.round(game.total / ROUNDS), storm = bestStormAce(), mode = game.mode;
    Leaderboard.submit(name, game.totalAce, storm, avgPct, mode).then(function () {
      msg.textContent = 'Added to the board!'; msg.className = 'lb-msg ok';
      $('lb-submit').classList.add('done'); $('lb-name').disabled = true;
      track('score_submit', { mode: mode, total_ace: Number(game.totalAce.toFixed(1)), best_storm_ace: Number(storm.toFixed(1)) });
      lbMine = { name: name.trim(), total: Number(game.totalAce.toFixed(1)), storm: Number(storm.toFixed(1)), mode: mode };
      delete lbCache[mode];          // refetch so your new row appears
      setLbViewMode(mode);
    }).catch(function (e) {
      msg.textContent = e.message || 'Could not submit.'; msg.className = 'lb-msg err';
      $('lb-submit-btn').disabled = false;
    });
  }

  // ---- wire up ----
  function init() {
    initMap();
    $('start-btn').addEventListener('click', startGame);   // intro -> begin the game in the chosen basin
    $('deal-btn').addEventListener('click', goHome);        // topbar "New game" -> back to basin pick
    $('run-btn').addEventListener('click', runSimulation);  // "Choose this seed"
    $('next-btn').addEventListener('click', nextOrFinish);  // "Next round" / "See final results"
    $('replay-btn').addEventListener('click', replayAnimation);
    $('again-btn').addEventListener('click', startGame);    // summary -> play again (same basin)
    $('lb-submit-btn').addEventListener('click', submitScore);
    $('lb-name').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submitScore(); } });
    // basin mode picker (intro)
    [].forEach.call(document.querySelectorAll('.mode-opt'), function (b) {
      b.addEventListener('click', function () {
        selectedMode = b.getAttribute('data-mode');
        [].forEach.call(document.querySelectorAll('.mode-opt'), function (o) {
          o.classList.toggle('is-active', o === b);
        });
      });
    });
    $('lb-basin').addEventListener('change', function () { setLbViewMode(this.value); });
    [].forEach.call(document.querySelectorAll('.lb-tab'), function (b) {
      b.addEventListener('click', function () { setLbMetric(b.getAttribute('data-metric')); });
    });
    // Independent layers: flow (base) + optional shear contours + optional MPI.
    $('tog-flow').addEventListener('change', function () { if (env) renderFlow(); });
    $('tog-shear').addEventListener('change', function () { if (env) renderShear(); });
    $('tog-mpi').addEventListener('change', function () { if (env) renderMpi(); });
    $('tog-track-shear').addEventListener('change', function () { if (results) drawIntensityChart(); });
    $('tog-track-mpi').addEventListener('change', function () { if (results) drawIntensityChart(); });
    $('chart-expand').addEventListener('click', openChartModal);
    $('chart-modal-close').addEventListener('click', closeChartModal);
    $('chart-modal').addEventListener('click', function (e) { if (e.target === this) closeChartModal(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeChartModal(); });
    window.addEventListener('resize', function () {
      if (map) map.invalidateSize({ animate: false });   // keep the map filling its box on rotate/resize
      if (results && chosenIdx >= 0) drawIntensityChart();
    });
    showStage('intro');
    startAttract();   // live sample environment behind the "How to play" intro
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
