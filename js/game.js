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
  var selectedObjective = 'ace';   // 'ace' (max total ACE) | 'vmax' (max peak intensity)

  // ---- state ----
  var map, seedLayer, trackLayer, mpiLayer = null, flowLayer = null, shearLayer = null;
  var env = null, seeds = [], results = null, chosenIdx = -1, dealDate = null;
  var viewIdx = -1;   // which seed's evolution is being VISUALISED (≠ chosenIdx, which is locked for scoring)

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
  var userPanned = false;   // set when the player drags/zooms → stop auto-following
  var sharedMode = false;   // true while viewing a shared storm/game from a link
  var nextRound = null;     // {basinKey, year, month} prefetched during a reveal → instant next deal

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
      // minZoom 3 lets the pick-stage fitBounds zoom out far enough to frame all
      // four seeds even when they're spread wide across a basin on a narrow phone.
      worldCopyJump: false, minZoom: 3, maxZoom: 8, zoomSnap: 0.5, zoomDelta: 0.5,
      // South edge sits a bit below the 0°N data band so framing a deep-tropics
      // seed (with bottom padding to clear the legend) isn't shoved back north
      // by the bounds clamp — which was tucking sub-10°N seeds under the legend.
      maxBounds: [[-12, -180], [60, 180]], maxBoundsViscosity: 1.0,
    }).setView([26, -52], 4.5);
    map.attributionControl.setPrefix(false);   // drop the "Leaflet" + flag prefix
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      attribution: '&copy; OSM &middot; CARTO &middot; ERA5/TC-ATLAS',
      subdomains: 'abcd', maxZoom: 8,
    }).addTo(map);
    seedLayer = L.layerGroup().addTo(map);
    trackLayer = L.layerGroup().addTo(map);
    // A manual drag/zoom during playback stops the map auto-following the storm
    // (don't fight the user). panTo(animate:false) fires neither of these events.
    map.on('dragstart zoomstart', function () { userPanned = true; });
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

  // Load the full environment bundle for a (basin, year, month) and frame the
  // start day. Steering is precomputed (steeru/steerv = 0.75*V850 + 0.25*V200).
  // Loads this month + the next so a storm can integrate across the month
  // boundary until it dissipates, on a contiguous time axis. Shared by the
  // round dealer and the shared-storm replay link.
  function loadEnv(basinKey, year, month, startDayIdx) {
    var basin = BASINS[basinKey] || BASINS.atl;
    return Promise.all([
      ERA5.loadDailyFieldSpan('steeru', year, month, 2),
      ERA5.loadDailyFieldSpan('steerv', year, month, 2),
      ERA5.loadDailyFieldSpan('shear', year, month, 2),
      ERA5.loadSST(month),
      ERA5.loadLandMask(),
      ERA5.loadMPI(year, month),
    ]).then(function (f) {
      return { steeru: f[0], steerv: f[1], shear: f[2], sst: f[3], landmask: f[4],
               mpi: f[5], startDayIdx: startDayIdx, excludeEPac: !!basin.excludeEPac };
    });
  }

  // Pre-pick the NEXT round and warm its field fetches (fetchDecode caches by
  // URL) so that pressing "Next round" deals from cache instead of waiting on
  // the network. Stored in nextRound for dealRound to consume verbatim.
  function prefetchNext() {
    var basin, month;
    if (game.mode === 'nh') { basin = BASINS[pick(BASIN_KEYS)]; month = pick(basin.months); }
    else { basin = BASINS[game.mode]; month = basin.months[game.round]; }   // 0-based index of round+1
    var year = pick(YEARS);
    // Keep the assembled env (not just the warm tile cache): dealRound reuses it
    // verbatim, so the 2-month span concatenation happens ONCE per round here,
    // not again at deal time. Only startDayIdx differs, and that's a scalar.
    var envP = loadEnv(basin.key, year, month, 0);
    envP.catch(function () {});                                             // silence unhandled-rejection
    nextRound = { basinKey: basin.key, month: month, year: year, envP: envP };
  }

  function dealRound() {
    status('Dealing… fetching ERA5 fields');
    resetRound();
    // Pick the basin for this round. Fixed-basin modes step through that basin's
    // 6 months in order; Random-NH mode draws a random basin + month each round.
    // If the previous reveal already prefetched this round, reuse it verbatim so
    // its fields are served warm from the fetch cache (no deal lag).
    var basin, month, year, prefetchedEnvP = null;
    if (nextRound) {
      basin = BASINS[nextRound.basinKey]; month = nextRound.month; year = nextRound.year;
      prefetchedEnvP = nextRound.envP;   // reuse the env assembled during the last reveal
      nextRound = null;
    } else if (game.mode === 'nh') {
      basin = BASINS[pick(BASIN_KEYS)]; month = pick(basin.months); year = pick(YEARS);
    } else {
      basin = BASINS[game.mode]; month = basin.months[game.round - 1]; year = pick(YEARS);
    }
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

      // Reuse the env assembled during the prefetch if we have it (a failed
      // prefetch falls back to a fresh, retrying load); otherwise load now.
      // Either way the storm integrates across the month boundary on a
      // contiguous time axis.
      var envP = prefetchedEnvP
        ? prefetchedEnvP.catch(function () { return loadEnv(basin.key, year, month, startDayIdx); })
        : loadEnv(basin.key, year, month, startDayIdx);
      return envP.then(function (e) {
        env = e;
        env.startDayIdx = startDayIdx;            // prefetch used day 0; set this round's real start day
        env.excludeEPac = !!basin.excludeEPac;
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
      // Before the run: pick this seed. After the reveal: watch its storm.
      m.on('click', function () { if (results) viewSeed(i); else selectSeed(i); });
      seedMarkers.push(m);
    });
    // Frame ALL seeds with comfortable margins. Reserve the top for the clock
    // and ~100 px at the bottom for the field legend (~90 px tall, bottom-left)
    // so deep-tropics seeds are never tucked behind it or jammed at the edge.
    var grp = L.featureGroup(seedMarkers);
    if (seedMarkers.length) {
      map.fitBounds(grp.getBounds().pad(0.12), {
        animate: false, maxZoom: 5,
        paddingTopLeft: [24, 46], paddingBottomRight: [24, 100],
      });
    }
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
    if (results) return;        // round already run — the pick is locked (use viewSeed to watch others)
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
  // Both shear and MPI are smooth filled FieldLayers (js/fields.js) sampled at
  // viewport resolution — crisp on retina phones; only one shows at a time.
  // Coastlines are drawn on top so land stays legible.
  function fieldPane() {
    if (!map.getPane('fieldPane')) {
      var p = map.createPane('fieldPane');
      p.style.zIndex = 300; p.style.pointerEvents = 'none';   // below flow (350)
    }
    return 'fieldPane';
  }

  // Field samplers read the module-level `env` (swapped each round), so the
  // layers persist across rounds and just re-shade. NaN -> transparent.
  function shearSample(lat, lon, t) {
    if (!env || !env.shear) return NaN;
    var ms = ERA5.sampleTime(env.shear, t, lat, lon);
    return isFinite(ms) ? ms * 1.94384 : NaN;   // m/s -> kt
  }
  function mpiSample(lat, lon) {
    if (!env) return NaN;
    return env.mpi ? ERA5.bilinear(env.mpi.values, env.mpi.grid, lat, lon)
                   : MPI.atPoint(env.sst, lat, lon).mpi;   // NaN over land/cold
  }
  function ensureShearLayer() {
    if (!shearLayer) shearLayer = new FieldLayer({ sample: shearSample, color: shearShade, opacity: 0.62, pane: fieldPane() });
    return shearLayer;
  }
  function ensureMpiLayer() {
    if (!mpiLayer) mpiLayer = new FieldLayer({ sample: mpiSample, color: mpiShade, opacity: 0.55, pane: fieldPane() });
    return mpiLayer;
  }

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
  function mpiShade(v) { if (!isFinite(v)) return [0, 0, 0, 0]; var c = rampColor(TURBO_STOPS, Math.max(0, Math.min(1, v / 160))); return [c[0], c[1], c[2], 255]; }

  // Coastlines (Natural Earth 50m via jsDelivr — 110m was visibly blocky at the
  // game's zooms), drawn above the field so land boundaries stay visible under
  // the shading. Best-effort; absent if fetch fails.
  var _coastLayer = null, _coastPromise = null;
  function ensureCoastlines() {
    if (_coastLayer) return Promise.resolve(_coastLayer);
    if (_coastPromise) return _coastPromise;
    if (!map.getPane('coastPane')) {
      var p = map.createPane('coastPane'); p.style.zIndex = 320; p.style.pointerEvents = 'none';
    }
    _coastPromise = fetch('https://cdn.jsdelivr.net/gh/nvkelso/natural-earth-vector@master/geojson/ne_50m_coastline.geojson')
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
    ensureShearLayer().setTime(env.startDayIdx);     // no-op redraw if not on the map yet
    if (!map.hasLayer(shearLayer)) shearLayer.addTo(map);
    afterFieldToggle();
  }

  function renderMpi() {
    var on = $('tog-mpi').checked;
    if (on && shearLayer && map.hasLayer(shearLayer)) { $('tog-shear').checked = false; map.removeLayer(shearLayer); }
    if (!on) { if (mpiLayer && map.hasLayer(mpiLayer)) map.removeLayer(mpiLayer); afterFieldToggle(); return; }
    ensureMpiLayer().setTime(0);                      // MPI is monthly — time-independent
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

  // The quantity the player is optimizing this game.
  function objVal(r) { return game.objective === 'vmax' ? r.peakV : r.ace; }
  function catLabel(cat) { return cat && cat.length === 1 ? 'Cat ' + cat : cat; }
  function bestIdx() {
    var bi = 0; for (var i = 1; i < results.length; i++) if (objVal(results[i]) > objVal(results[bi])) bi = i;
    return bi;
  }

  function drawTrackPolyline(i, upto, faint) {
    var r = results[i], pts = r.track;
    var end = upto == null ? pts.length : upto;
    // Non-chosen tracks: one dashed polyline in the SEED's colour (matches its
    // pin + result-list dot), bright enough to read but clearly secondary to the
    // chosen storm's solid, category-coloured line.
    if (faint) {
      var ll = [];
      for (var k = 0; k < end; k++) ll.push([pts[k].lat, pts[k].lon]);
      if (ll.length > 1) {
        L.polyline(ll, { color: SEED_COLORS[i], weight: 2.5, opacity: 0.6,
          dashArray: '3 5', interactive: false }).addTo(trackLayer);
        var ep = pts[end - 1];
        L.circleMarker([ep.lat, ep.lon], { radius: 4, color: '#0c2420', weight: 1.5,
          fillColor: SEED_COLORS[i], fillOpacity: 0.85, interactive: false }).addTo(trackLayer);
      }
      return;
    }
    for (var s = 1; s < end; s++) {
      var seg = [[pts[s - 1].lat, pts[s - 1].lon], [pts[s].lat, pts[s].lon]];
      L.polyline(seg, { color: colorForV(pts[s].v), weight: 3.5, opacity: 0.95 }).addTo(trackLayer);
    }
  }

  // Switch the VISUALISATION to another seed's storm (map animation + intensity
  // chart) without touching the score — lets the player compare evolutions after
  // the round is locked in.
  function viewSeed(k) {
    if (!results || k < 0 || k >= results.length || k === viewIdx) return;
    markViewing(k);
    drawIntensityChart();   // redraw with seed k as the bold curve (renderChart reads viewIdx)
    animateTrack(k);        // replay seed k on the map
  }
  function markViewing(k) {
    viewIdx = k;
    Array.prototype.forEach.call($('result-list').children, function (li) {
      li.classList.toggle('viewing', Number(li.dataset.idx) === viewIdx);
    });
  }

  var HRS_PER_FRAME = 0.7;   // ~1 day per ~1.1 s at 30 fps
  var FRAME_MS = 33;
  var SHEAR_REBUILD_HR = 12; // re-shade shear every 12 sim-hours
  var animHook = null;       // optional per-frame callback(hr, v) — drives the tutorial captions
  var tutorialActive = false;
  var TUTORIAL_HRS_PER_FRAME = 0.32;   // slower so the demo's captions are readable (~15 s)

  // The storm "head": a glowing cyclone glyph that spins faster and grows as
  // the storm intensifies (180°-symmetric swirl, so the rotation reads cleanly).
  var STORM_HEAD_HTML =
    '<div class="storm-head"><svg class="sh-swirl" viewBox="-20 -20 40 40" aria-hidden="true">' +
    '<g fill="none" stroke="currentColor" stroke-linecap="round">' +
    '<path d="M 0 -14 A 14 14 0 0 1 14 0" stroke-width="3"/>' +
    '<path d="M 0 14 A 14 14 0 0 1 -14 0" stroke-width="3"/>' +
    '<path d="M -9 0 A 9 9 0 0 1 0 -9" stroke-width="2.6" opacity=".75"/>' +
    '<path d="M 9 0 A 9 9 0 0 1 0 9" stroke-width="2.6" opacity=".75"/>' +
    '</g><circle r="4" fill="currentColor"/><circle r="1.5" fill="#08160f"/></svg></div>';
  function makeStormHead(p) {
    var mk = L.marker([p.lat, p.lon], {
      icon: L.divIcon({ className: '', iconSize: [44, 44], iconAnchor: [22, 22], html: STORM_HEAD_HTML }),
      interactive: false, keyboard: false,
    }).addTo(trackLayer);
    mk._el = mk.getElement() && mk.getElement().firstChild;   // the .storm-head div
    styleStormHead(mk, p.v);
    return mk;
  }
  function styleStormHead(mk, v) {
    var el = mk._el; if (!el) return;
    el.style.color = colorForV(v);
    el.style.transform = 'scale(' + (0.55 + v / 150).toFixed(3) + ')';
    el.style.setProperty('--spin', Math.max(0.9, 7 - v / 24).toFixed(2) + 's');
  }

  // Expanding ring at the storm's position when it jumps a Saffir–Simpson
  // category (+ a haptic tick where supported).
  var CAT_T = [64, 83, 96, 113, 137];
  function catStep(v) { var c = 0; for (var k = 0; k < CAT_T.length; k++) if (v >= CAT_T[k]) c = k + 1; return c; }
  function catPulse(lat, lon, color) {
    var mk = L.marker([lat, lon], {
      icon: L.divIcon({ className: '', iconSize: [12, 12], iconAnchor: [6, 6],
        html: '<span class="cat-pulse" style="color:' + color + '"></span>' }),
      interactive: false, keyboard: false,
    }).addTo(trackLayer);
    setTimeout(function () { if (trackLayer.hasLayer(mk)) trackLayer.removeLayer(mk); }, 950);
    if (navigator.vibrate) { try { navigator.vibrate(16); } catch (e) {} }
  }

  // Incremental category-coloured track writer: extends one polyline per
  // colour run instead of one per hour segment (a long track was hundreds of
  // SVG paths — heavy on mobile).
  function trackPen(weight) {
    var line = null, color = null;
    return function (p0, p1) {
      var col = colorForV(p1.v);
      if (!line || col !== color) {
        line = L.polyline([[p0.lat, p0.lon], [p1.lat, p1.lon]],
          { color: col, weight: weight || 3.5, opacity: 0.95, interactive: false }).addTo(trackLayer);
        color = col;
      } else line.addLatLng([p1.lat, p1.lon]);
    };
  }

  function animateTrack(i) {
    var token = ++animToken;                 // supersede any running animation
    viewIdx = i;                             // this seed is now the one being visualised
    trackLayer.clearLayers();
    results.forEach(function (r, k) { if (k !== i) drawTrackPolyline(k, null, true); });

    // Follow the storm on small/narrow maps (mobile), where it otherwise drifts
    // off-screen; on wide desktop maps the whole field is visible, so following
    // would just slide the other seeds' tracks out of view. Yields to the user.
    var follow = map.getSize().x < 640, lastPanMs = 0;
    userPanned = false;

    var pts = results[i].track;
    var head = makeStormHead(pts[0]);
    var pen = trackPen();
    var lastCat = catStep(pts[0].v);
    // Reset the evolving overlays + clock to the start time, and hand the
    // particle layer the storm so the flow spirals into it as it spins up.
    if (flowLayer && map.hasLayer(flowLayer)) {
      flowLayer.setTime(env.startDayIdx);
      flowLayer.setStorm({ lat: pts[0].lat, lon: pts[0].lon, v: pts[0].v });
    }
    if (shearLayer) shearLayer.setTime(env.startDayIdx);
    updateClock(0);
    setChartCursor(0);

    var maxHr = pts[pts.length - 1].hr, simHr = 0, drawn = 1, lastMs = 0, lastShearHr = 0;
    function frame(ts) {
      if (token !== animToken) return;       // a newer animation took over
      if (ts - lastMs < FRAME_MS) { requestAnimationFrame(frame); return; }
      lastMs = ts;
      simHr = Math.min(maxHr, simHr + (tutorialActive ? TUTORIAL_HRS_PER_FRAME : HRS_PER_FRAME));
      var upto = Math.min(pts.length, Math.floor(simHr) + 1);
      for (var s = drawn; s < upto; s++) pen(pts[s - 1], pts[s]);
      drawn = upto;
      var p = pts[Math.min(pts.length - 1, upto - 1)];
      head.setLatLng([p.lat, p.lon]);
      styleStormHead(head, p.v);
      var cs = catStep(p.v);
      if (cs > lastCat) catPulse(p.lat, p.lon, colorForV(p.v));
      lastCat = cs;
      // Evolve the steering flow + shaded shear field + clock + chart cursor.
      updateClock(p.hr);
      setChartCursor(p.hr);
      if (animHook) animHook(p.hr, p.v);   // tutorial caption driver
      if (flowLayer && map.hasLayer(flowLayer)) {
        flowLayer.setTime(env.startDayIdx + p.hr / 24);
        flowLayer.setStorm({ lat: p.lat, lon: p.lon, v: p.v });
      }
      if (shearLayer && p.hr - lastShearHr >= SHEAR_REBUILD_HR) {
        lastShearHr = p.hr; shearLayer.setTime(env.startDayIdx + p.hr / 24);
      }
      // Smoothly keep the storm in view: only glide-recentre (animated pan)
      // when it drifts into the outer 30% of the frame. Far fewer pans than a
      // per-frame nudge, so the motion reads as one smooth camera move AND the
      // flow layer (which clears+reseeds on every map move) isn't torn down
      // constantly — both causes of the old jumpiness.
      if (follow && !userPanned && ts - lastPanMs > 850) {
        var cp = map.latLngToContainerPoint([p.lat, p.lon]), sz = map.getSize();
        var mx = sz.x * 0.30, my = sz.y * 0.30;
        if (cp.x < mx || cp.x > sz.x - mx || cp.y < my || cp.y > sz.y - my) {
          lastPanMs = ts;
          map.panTo([p.lat, p.lon], { animate: true, duration: 0.9, easeLinearity: 0.4 });
        }
      }
      if (simHr < maxHr) { requestAnimationFrame(frame); return; }
      if (flowLayer) flowLayer.setStorm(null);   // dissipated — release the vortex
      if (follow && !userPanned) {
        // Pull back to the whole journey once it finishes playing.
        var b = L.latLngBounds(pts.map(function (q) { return [q.lat, q.lon]; }));
        map.fitBounds(b.pad(0.3), { animate: true, maxZoom: 6 });
      }
    }
    requestAnimationFrame(frame);
  }

  function revealResults() {
    var bi = bestIdx(), chosen = results[chosenIdx], best = results[bi];
    var vmax = game.objective === 'vmax';
    var cv = objVal(chosen), bv = objVal(best);
    var pct = bv > 0 ? Math.round(100 * cv / bv) : 100;

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

    $('score-line').innerHTML = vmax
      ? 'Your seed ' + SEED_LABELS[chosenIdx] + ' peaked at <b>' + Math.round(chosen.peakV) + ' kt</b> (' +
        catLabel(chosen.peakCat) + ') — ' + pct + '% of the best (seed ' + SEED_LABELS[bi] + ', ' +
        Math.round(best.peakV) + ' kt) → <b>+' + pct + ' pts</b>.'
      : 'Your seed ' + SEED_LABELS[chosenIdx] + ' made <b>' + chosen.ace.toFixed(1) + ' ACE</b> — ' + pct +
        '% of the best (seed ' + SEED_LABELS[bi] + ', ' + best.ace.toFixed(1) + ') → <b>+' + pct + ' pts</b>.';

    renderClimoLine(chosen);

    $('next-btn').textContent = game.round < ROUNDS ? 'Next round →' : 'See final results';
    if (game.round < ROUNDS) prefetchNext();   // warm the next round's fields while the player reads

    viewIdx = chosenIdx;   // start by viewing your own pick; tapping a row switches the view
    $('result-hint').classList.remove('hidden');
    var ul = $('result-list'); ul.innerHTML = '';
    results.map(function (r, i) { return { r: r, i: i }; })
      .sort(function (a, b2) { return objVal(b2.r) - objVal(a.r); })   // rank by the objective
      .forEach(function (o) {
        var r = o.r, i = o.i, li = document.createElement('li');
        li.className = 'result-item' + (i === bi ? ' best' : '') + (i === chosenIdx ? ' chosen' : '') +
          (i === viewIdx ? ' viewing' : '');
        li.dataset.idx = i;
        li.innerHTML = '<span class="seed-dot" style="background:' + SEED_COLORS[i] + '"></span>' +
          '<span><b>Seed ' + SEED_LABELS[i] + '</b> ' +
          '<span class="result-tag">peak ' + (r.peakCat.length === 1 ? 'Cat ' : '') + r.peakCat +
          ' · ' + Math.round(r.peakV) + ' kt</span></span>' +
          '<span class="result-ace">' + (vmax ? Math.round(r.peakV) + ' kt' : r.ace.toFixed(1) + ' ACE') + '</span>';
        li.addEventListener('click', function () { viewSeed(i); });   // watch this seed's storm (score stays locked)
        ul.appendChild(li);
      });

    $('teach').innerHTML = teachText(chosen, best, chosenIdx, bi);
    renderCompare();
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
    if (r.peakV >= 96) return 'sat over warm, low-shear water and intensified into ' + peak;
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
      var recipe = game.objective === 'vmax'
        ? 'Warm SST + weak shear is the rapid-intensification recipe.'
        : 'Warm SST + weak shear + a long fetch over open ocean is the ACE recipe.';
      return '<b>Seed ' + SEED_LABELS[ci] + '</b> ' + describe(chosen) +
        ', and no other seed found a better environment. ' + recipe;
    }
    var head = '<b>Your seed ' + SEED_LABELS[ci] + '</b> ' + describe(chosen) + '. ';
    // ACE rewards a storm's WHOLE LIFE, not its peak — so a strong storm that
    // makes landfall (or peaks early and fades) can score less than a weaker,
    // longer-lived one. When that's what happened, teach it directly rather
    // than claiming the weaker winner had the "kindest" environment (it didn't).
    if (game.objective === 'ace' && chosen.peakV > best.peakV + 5) {
      return head + 'But ACE rewards a storm’s whole life, not its peak — the weaker ' +
        '<b>seed ' + SEED_LABELS[bi] + '</b> lasted longer and banked more energy over time.';
    }
    // Otherwise the winner genuinely did better; only call the environment
    // "kindest" when it actually reached major-hurricane strength.
    var tail = best.peakV >= 96 ? ' — that’s where the environment was kindest.'
                                : ' — enough to edge out your pick.';
    return head + 'Meanwhile <b>seed ' + SEED_LABELS[bi] + '</b> ' + describe(best) + tail;
  }

  // ---- post-reveal head-to-head ----
  // Lay the chosen seed's environment next to the winner's (or, if you won, the
  // runner-up's). Every number is a simple mean/sum over the storm's FULL life
  // cycle — purely descriptive, NOT a causal attribution. We show the two side
  // by side and let the player draw the lesson.
  function trackDiag(r) {
    var pts = r.track, n = pts.length, shSum = 0, mpiSum = 0, hoursWater = 0, lfHr = null;
    for (var i = 0; i < n; i++) {
      shSum += pts[i].shear; mpiSum += pts[i].mpi;                 // shear in m/s, mpi in kt
      if (i > 0 && !pts[i - 1].land) hoursWater += pts[i].hr - pts[i - 1].hr;
      if (lfHr === null && pts[i].land) lfHr = pts[i].hr;
    }
    return { n: n, daysWater: hoursWater / 24, meanShearKt: (shSum / Math.max(1, n)) * 1.94384,
             meanMpiKt: mpiSum / Math.max(1, n), landfallHr: lfHr };
  }
  function runnerUpIdx(winner) {
    var ru = -1;
    for (var i = 0; i < results.length; i++) {
      if (i === winner) continue;
      if (ru < 0 || objVal(results[i]) > objVal(results[ru])) ru = i;
    }
    return ru;
  }
  function landfallStr(hr) { return hr === null ? 'none' : 'day ' + (hr / 24).toFixed(1); }

  // Neutral narration of how the higher-scoring seed's environment differed from
  // the lower one's — lists only meaningful gaps, never says "because".
  function compareSentence(hiLabel, loLabel, dh, dl) {
    var parts = [];
    var dW = dh.daysWater - dl.daysWater;
    if (Math.abs(dW) >= 0.5) parts.push('spent ' + Math.abs(dW).toFixed(1) + (dW > 0 ? ' more' : ' fewer') + ' days over water');
    var dS = dh.meanShearKt - dl.meanShearKt;
    if (Math.abs(dS) >= 2) parts.push('saw ' + Math.round(Math.abs(dS)) + ' kt ' + (dS < 0 ? 'less' : 'more') + ' shear on average');
    var dM = dh.meanMpiKt - dl.meanMpiKt;
    if (Math.abs(dM) >= 5) parts.push('sat under a ' + Math.round(Math.abs(dM)) + '-kt ' + (dM > 0 ? 'higher' : 'lower') + ' ocean-potential ceiling');
    if (dh.landfallHr === null && dl.landfallHr !== null) parts.push('stayed offshore, while Seed ' + loLabel + ' made landfall on ' + landfallStr(dl.landfallHr));
    else if (dh.landfallHr !== null && dl.landfallHr === null) parts.push('made landfall on ' + landfallStr(dh.landfallHr) + ', while Seed ' + loLabel + ' stayed offshore');
    else if (dh.landfallHr !== null && dl.landfallHr !== null) {
      var dd = (dh.landfallHr - dl.landfallHr) / 24;
      if (Math.abs(dd) >= 0.5) parts.push((dd > 0 ? 'held off landfall ' : 'made landfall ') + Math.abs(dd).toFixed(1) + ' days ' + (dd > 0 ? 'longer' : 'sooner'));
    }
    if (!parts.length) return 'Seeds ' + hiLabel + ' and ' + loLabel + ' saw nearly identical environments — it was a close call.';
    var joined = parts.length === 1 ? parts[0] : parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
    return 'Seed ' + hiLabel + ' ' + joined + '.';
  }

  function renderCompare() {
    var el = $('compare'); if (!el) return;
    var bi = bestIdx(), ci = chosenIdx, hi, lo;     // hi = higher-scoring of the pair, lo = lower
    if (ci === bi) { var ru = runnerUpIdx(bi); if (ru < 0) { el.classList.add('hidden'); el.innerHTML = ''; return; } hi = ci; lo = ru; }
    else { hi = bi; lo = ci; }
    var dHi = trackDiag(results[hi]), dLo = trackDiag(results[lo]);
    // A seed that left the basin / domain at genesis has no sampled environment
    // (empty track) — the side-by-side numbers would be a misleading row of
    // zeros, and the teach text already narrates that case. Skip the panel.
    if (dHi.n < 2 || dLo.n < 2) { el.classList.add('hidden'); el.innerHTML = ''; return; }
    var yourIdx = ci, otherIdx = (ci === bi) ? lo : bi;          // player's seed always in the first column
    var dYour = (yourIdx === hi) ? dHi : dLo, dOther = (otherIdx === hi) ? dHi : dLo;
    var tag = function (idx) {
      var t = '';
      if (idx === bi) t += ' <span class="cmp-tag">strongest</span>';
      if (idx === ci) t += ' <span class="cmp-tag your">your pick</span>';
      return t;
    };
    var col = function (idx) { return '<span class="seed-dot" style="background:' + SEED_COLORS[idx] + '"></span>Seed ' + SEED_LABELS[idx]; };
    var row = function (label, a, b) { return '<tr><td>' + label + '</td><td>' + a + '</td><td>' + b + '</td></tr>'; };
    el.innerHTML =
      '<div class="cmp-head">How they compared</div>' +
      '<p class="cmp-line">' + compareSentence(SEED_LABELS[hi], SEED_LABELS[lo], dHi, dLo) + '</p>' +
      '<table class="cmp-table"><thead><tr><th></th>' +
        '<th>' + col(yourIdx) + tag(yourIdx) + '</th>' +
        '<th>' + col(otherIdx) + tag(otherIdx) + '</th></tr></thead><tbody>' +
        row('Days over water', dYour.daysWater.toFixed(1), dOther.daysWater.toFixed(1)) +
        row('Mean shear', Math.round(dYour.meanShearKt) + ' kt', Math.round(dOther.meanShearKt) + ' kt') +
        row('Ocean potential', Math.round(dYour.meanMpiKt) + ' kt', Math.round(dOther.meanMpiKt) + ' kt') +
        row('First landfall', landfallStr(dYour.landfallHr), landfallStr(dOther.landfallHr)) +
      '</tbody></table>' +
      '<p class="cmp-note">Averages over each storm’s full life cycle.</p>';
    el.classList.remove('hidden');
  }

  // ---- climatological context (real IBTrACS per-storm percentiles) ----
  // Where does this storm's ACE (or peak intensity) fall among REAL storms that
  // formed in the same basin & month, 1991–2020? Anchors are an inverse-CDF
  // (value at each 5th percentile); we invert it to turn a value into a
  // percentile. Computed with the SAME ACE definition the game uses, so it's a
  // fair comparison (see migrate/build_climo_percentiles.py).
  var climo = null;
  function ordinal(n) { var s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); }
  function pctOf(x, anchors, pcts) {
    if (!anchors || !anchors.length) return null;
    if (x <= anchors[0]) return pcts[0];
    for (var k = 1; k < anchors.length; k++) {
      if (x <= anchors[k]) {
        var lo = anchors[k - 1], hi = anchors[k];
        if (hi <= lo) return pcts[k];                 // flat CDF region → snap up
        return pcts[k - 1] + (pcts[k] - pcts[k - 1]) * (x - lo) / (hi - lo);
      }
    }
    return pcts[pcts.length - 1];
  }
  function renderClimoLine(r) {
    var el = $('climo-line'); if (!el) return;
    function hide() { el.classList.add('hidden'); el.innerHTML = ''; }
    if (!climo || !climo.basins || !dealDate || !r) return hide();
    if (r.peakV < 34) return hide();                   // never a tropical storm — nothing to rank
    var bm = (climo.basins[dealDate.basin] || {})[String(dealDate.month)];
    if (!bm) return hide();                            // sparse/absent basin-month (e.g. N. Indian midsummer)
    var vmax = game.objective === 'vmax';
    var val = vmax ? r.peakV : r.ace;
    var pct = pctOf(val, vmax ? bm.lmi : bm.ace, climo.pcts);
    if (pct == null) return hide();
    var pr = Math.max(1, Math.min(99, Math.round(pct)));
    var label = MONTH_NAMES[dealDate.month] + ' ' + (MODE_LABEL[dealDate.basin] || '');
    var yrs = climo.years ? '’' + String(climo.years[0]).slice(2) + '–’' + String(climo.years[1]).slice(2) : '';
    var what = vmax ? (Math.round(val) + '-kt peak') : (val.toFixed(1) + ' ACE');
    el.innerHTML = '<svg class="cl-ic"><use href="#ic-trophy"/></svg> That <b>' + what +
      '</b> ranks around the <b>' + ordinal(pr) + ' percentile</b> of real ' + label +
      ' storms <span class="muted">(' + yrs + ')</span>.';
    el.classList.remove('hidden');
  }

  // Redraw the inset chart (and the expanded one if open).
  // Moving vertical time-cursor over the inset intensity chart during playback.
  var chartGeom = null;
  function setChartCursor(hr) {
    var g = chartGeom, el = $('chart-cursor');
    if (!g || !el) return;
    var x = g.padL + (g.w - g.padL - g.padR) * Math.max(0, Math.min(hr, g.maxHr)) / g.maxHr;
    el.style.left = x + 'px'; el.style.top = g.padT + 'px';
    el.style.height = (g.h - g.padT - g.padB) + 'px';
    el.classList.remove('hidden');
  }
  function hideChartCursor() { var el = $('chart-cursor'); if (el) el.classList.add('hidden'); }

  function drawIntensityChart() {
    renderChart($('intensity-chart'));
    if (!$('chart-modal').classList.contains('hidden')) renderChart($('chart-modal-canvas'));
  }

  // Draw the intensity (+ optional shear) chart crisply into any canvas, scaling
  // type/line weights to the canvas size so it reads well small or expanded.
  function renderChart(cv) {
    if (!results || chosenIdx < 0) return;
    var vi = viewIdx >= 0 ? viewIdx : chosenIdx;   // the seed whose curve is bold (may differ from the pick)
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
    // Remember the inset's geometry so the animation time-cursor can align to it.
    if (cv === $('intensity-chart')) chartGeom = { padL: padL, padR: padR, padT: padT, padB: padB, w: w, h: h, maxHr: maxHr };
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
    var cpts = results[vi].track;

    // Right (shear) axis ticks, drawn only when the shear line is on.
    if (showShear) {
      ctx.fillStyle = 'rgba(196,210,236,.8)'; ctx.textAlign = 'left';
      [0, 20, 40].forEach(function (s) { ctx.fillText(s, w - padR + 5, Ysh(s)); });
    }

    // Faint context tracks for the other seeds.
    results.forEach(function (r, i) {
      if (i === vi) return;
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
    ((BASIN_GENESIS.atl || {})[month] || []).forEach(function (b) {
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
        ensureShearLayer().setTime(env.startDayIdx);
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
    env = null; seeds = []; results = null; chosenIdx = -1; viewIdx = -1;
    animToken++;                                    // stop any running animation
    if (flowLayer) flowLayer.setStorm(null);        // no storm — no vortex in the flow
    if (seedLayer) seedLayer.clearLayers();
    if (trackLayer) trackLayer.clearLayers();
    // Detach the heat fields (rebuilt for the new month by renderShear/renderMpi).
    if (mpiLayer && map.hasLayer(mpiLayer)) map.removeLayer(mpiLayer);
    if (shearLayer && map.hasLayer(shearLayer)) map.removeLayer(shearLayer);
    $('run-btn').disabled = true;
  }

  // ---- game flow ----
  function bestPeakKt() { return game.rows.reduce(function (m, r) { return Math.max(m, r.peakV); }, 0); }
  function updateScoreBadge() {
    $('score-badge').classList.remove('hidden');
    $('score-badge-val').textContent = game.objective === 'vmax'
      ? Math.round(bestPeakKt()) + ' kt'        // headline = strongest single storm so far
      : game.totalAce.toFixed(1) + ' ACE';      // headline = summed ACE
  }

  function startGame() {
    nextRound = null;   // no stale prefetch from a previous game/basin
    game = { round: 1, total: 0, totalAce: 0, rows: [], mode: selectedMode, objective: selectedObjective };
    track('game_start', { mode: selectedMode, objective: selectedObjective });
    updateScoreBadge();
    dealRound();
  }

  // Return to the intro / basin picker and restore the live attract preview.
  function goHome() {
    sharedMode = false;
    nextRound = null;
    if (tutorialActive) { tutorialActive = false; document.getElementById('app').classList.remove('tut-mode'); resetFieldToggles(); }
    restoreSharedUI();
    resetRound();
    $('score-badge').classList.add('hidden');
    showStage('intro');
    startAttract();
  }

  // ---- first-load tutorial -------------------------------------------------
  // A stepped (you click through), skippable walkthrough of one real, hand-
  // picked storm: it intensifies under high MPI + low shear, then weakens in
  // strong shear. Runs ON the pick-stage layout so the REAL Wind-shear /
  // Ocean-potential toggles are visible — the active one is highlighted each
  // step — teaching where those controls are. Deterministic scenario, verified
  // (35 kt → Cat 4 114 kt under ~4 kt shear → dissipates at ~71 kt shear).
  var TUT_SCN = { b: 'atl', y: 2005, m: 9, d: 6, la: 24, lo: -66 };
  var TUT_BEATS = [
    { hr: 0,   field: 'mpi',   html: 'A weak disturbance (~35 kt) sits over a deep warm pool. Sea-surface temperature sets the <b>maximum potential intensity (MPI)</b> — the ceiling on how strong a storm can get. The highlighted <b>Ocean&nbsp;potential</b> layer maps it; here it’s very high.' },
    { hr: 36,  field: 'shear', html: '<b>Vertical wind shear is weak</b> — the calm blue on the highlighted <b>Wind&nbsp;shear</b> layer. With little shear the vortex stays vertically stacked and convection wraps the core, so it intensifies rapidly.' },
    { hr: 88,  field: 'shear', html: 'Over warm water and low shear it <b>rapidly intensifies into a major hurricane</b>, climbing toward its potential intensity. High MPI + low shear is the classic rapid-intensification recipe.' },
    { hr: 116, field: 'shear', html: 'Recurving poleward, it runs into <b>strong deep-layer shear</b> (red). Shear tilts and <b>ventilates</b> the vortex — fluxing dry, low-entropy air into the core — so it weakens.' },
    { hr: 150, field: 'shear', html: 'Shear and cooler water win; it drops below hurricane strength. <b>Your goal:</b> seed the storm where MPI is high and vertical shear stays low.' },
  ];
  var tutStep = 0;

  // Highlight the real toggle button this step is about (Wind shear / Ocean potential).
  function tutHighlight(field) {
    [].forEach.call(document.querySelectorAll('#stage-pick .env-toggles label'), function (l) { l.classList.remove('tut-hi'); });
    var box = $(field === 'mpi' ? 'tog-mpi' : 'tog-shear');
    var lab = box && box.closest('label');
    if (lab) lab.classList.add('tut-hi');
  }

  // Render the storm frozen at the current step: track drawn up to that hour,
  // the field shaded for that time, the right toggle on + highlighted.
  function tutShowStep() {
    if (!results || !results[0]) return;
    var b = TUT_BEATS[tutStep], pts = results[0].track;
    $('tog-mpi').checked = (b.field === 'mpi');
    $('tog-shear').checked = (b.field === 'shear');
    renderMpi(); renderShear();
    var end = 1; while (end < pts.length && pts[end].hr <= b.hr) end++;
    var p = pts[Math.min(pts.length - 1, end - 1)];
    var dayF = env.startDayIdx + p.hr / 24;
    if (shearLayer && b.field === 'shear') shearLayer.setTime(dayF);   // field AT this time (blue→red)
    if (flowLayer && map.hasLayer(flowLayer)) {
      flowLayer.setTime(dayF);
      flowLayer.setStorm({ lat: p.lat, lon: p.lon, v: p.v });   // flow spirals into the frozen storm
    }
    trackLayer.clearLayers();
    var pen = trackPen();
    for (var s = 1; s < end; s++) pen(pts[s - 1], pts[s]);
    makeStormHead(p).bindTooltip(catLabel(p.cat) + ' · ' + Math.round(p.v) + ' kt',
      { permanent: true, direction: 'top', className: 'track-tip', offset: [0, -18] });
    updateClock(p.hr);
    $('tut-caption').innerHTML = b.html;
    $('tut-progress').textContent = (tutStep + 1) + ' / ' + TUT_BEATS.length;
    tutHighlight(b.field);
    $('tut-back').disabled = (tutStep === 0);
    var last = tutStep === TUT_BEATS.length - 1;
    $('tut-next').classList.toggle('hidden', last);
    $('tut-play').classList.toggle('hidden', !last);
  }
  function tutNext() { if (tutStep < TUT_BEATS.length - 1) { tutStep++; tutShowStep(); } }
  function tutBack() { if (tutStep > 0) { tutStep--; tutShowStep(); } }

  function runTutorial() {
    tutorialActive = true; tutStep = 0;
    var basin = BASINS[TUT_SCN.b];
    game = { round: 0, total: 0, totalAce: 0, rows: [], mode: basin.key, objective: 'ace' };
    $('score-badge').classList.add('hidden');
    $('basin-name').textContent = ''; $('round-label').textContent = 'How it works';
    document.getElementById('app').classList.add('tut-mode');   // CSS shows #tut-panel + toggles, hides seed bits
    showStage('pick');
    $('tut-caption').textContent = 'Loading a sample storm…';
    $('tut-progress').textContent = '';
    $('tut-next').classList.add('hidden'); $('tut-play').classList.add('hidden'); $('tut-back').disabled = true;
    loadEnv(basin.key, TUT_SCN.y, TUT_SCN.m, TUT_SCN.d - 1).then(function (e) {
      if (!tutorialActive) return;                 // skipped while loading
      env = e; env.startDayIdx = TUT_SCN.d - 1; env.excludeEPac = !!basin.excludeEPac;
      seeds = [{ lat: TUT_SCN.la, lon: TUT_SCN.lo }];
      chosenIdx = 0; viewIdx = 0;
      results = Model.runSeeds(env, seeds);
      dealDate = { year: TUT_SCN.y, month: TUT_SCN.m, day: TUT_SCN.d, basin: basin.key };
      if (seedLayer) seedLayer.clearLayers();
      if (basin.view) map.setView(basin.view.center, basin.view.zoom, { animate: false });
      $('tog-flow').checked = true; renderFlow();
      tutStep = 0; tutShowStep();
    }).catch(function (err) { console.error(err); endTutorial(); });
  }

  function endTutorial() {
    tutorialActive = false;
    document.getElementById('app').classList.remove('tut-mode');
    [].forEach.call(document.querySelectorAll('#stage-pick .env-toggles label'), function (l) { l.classList.remove('tut-hi'); });
    resetFieldToggles();   // the demo flipped these; restore the game default (shear on)
    try { window.localStorage.setItem('seedstorm_tutorial_seen', '1'); } catch (e) {}
    goHome();
  }

  // Default field-overlay state for normal play (shear shown, ocean-potential off).
  function resetFieldToggles() {
    $('tog-flow').checked = true;
    $('tog-shear').checked = true;
    $('tog-mpi').checked = false;
  }

  // Undo any DOM tweaks made by the shared-view renderers so normal play looks right.
  function restoreSharedUI() {
    $('share-storm-btn').classList.remove('hidden');
    $('share-game-btn').classList.remove('hidden');
    $('next-btn').textContent = 'Next round →';
    $('again-btn').textContent = 'Play again';
    var h2 = stages.summary.querySelector('h2'); if (h2) h2.textContent = 'Final results';
  }

  function nextOrFinish() {
    if (sharedMode) { goHome(); return; }           // shared storm → "Play Seed the Storm"
    if (game.round < ROUNDS) { game.round += 1; dealRound(); }
    else showSummary();
  }

  function replayAnimation() {
    // Replay whichever seed is currently being viewed (defaults to your pick).
    if (results && chosenIdx >= 0) animateTrack(viewIdx >= 0 ? viewIdx : chosenIdx);
  }

  function openChartModal() {
    if (!results || chosenIdx < 0) return;
    $('chart-modal').classList.remove('hidden');
    renderChart($('chart-modal-canvas'));
  }
  function closeChartModal() { $('chart-modal').classList.add('hidden'); }

  function showSummary() {
    animToken++;
    restoreSharedUI();                                  // undo any shared-view DOM tweaks
    $('leaderboard').classList.remove('hidden');
    var vmax = game.objective === 'vmax';
    var headline = vmax ? bestPeakKt() : game.totalAce;     // peak kt or summed ACE
    var BEST_KEY = vmax ? 'seedstorm_best_peak' : 'seedstorm_best_ace';
    var prevBest = parseFloat(window.localStorage.getItem(BEST_KEY) || '0');
    var isBest = headline > prevBest;
    if (isBest) window.localStorage.setItem(BEST_KEY, headline.toFixed(1));
    var avgPct = Math.round(game.total / ROUNDS);
    track('game_complete', { mode: game.mode, objective: game.objective,
      total_ace: Number(game.totalAce.toFixed(1)), best_storm_ace: Number(bestStormAce().toFixed(1)),
      best_peak_kt: Number(bestPeakKt().toFixed(1)), avg_pct: avgPct });

    $('summary-total').innerHTML = vmax
      ? 'Your strongest storm: <b>' + Math.round(headline) + ' kt</b> (' + catLabel(Model.catOf(headline)) + ')' +
        ' &nbsp;·&nbsp; <span class="muted">picked ' + avgPct + '% of the best on average</span>'
      : 'You scored <b>' + game.totalAce.toFixed(1) + ' ACE</b>' +
        ' &nbsp;·&nbsp; <span class="muted">picked ' + avgPct + '% of the best on average</span>';

    var ul = $('summary-list'); ul.innerHTML = '';
    game.rows.forEach(function (r) {
      var li = document.createElement('li');
      li.className = 'summary-row';
      li.innerHTML = '<span><b>R' + r.round + '</b> · ' + r.date + '</span>' +
        '<span class="result-tag">seed ' + r.label + ' · ' +
        (r.cat.length === 1 ? 'Cat ' : '') + r.cat + ' · ' + r.points + '% of best</span>' +
        '<span class="sr-pts">' + (vmax ? Math.round(r.peakV) + ' kt' : r.ace.toFixed(1) + ' ACE') + '</span>';
      ul.appendChild(li);
    });

    renderLeaderboard(headline, avgPct, isBest, prevBest);
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
  var lbBoard = 'total';                   // 'total' | 'storm' (ACE games) | 'peak' (Vmax games)
  var lbViewMode = 'atl';                  // which basin board is displayed
  var lbCache = {};                        // mode -> { total:[], storm:[], peak:[] }
  var lbMine = null;                       // { name, mode, objective, total, storm, peak }
  var lbRowId = null;                       // id of this game's recorded (anonymous) row, to claim with a name

  var LB_COL = { total: 'total_ace', storm: 'best_storm_ace', peak: 'best_peak_kt' };
  function lbCell(r) { return Number(r[LB_COL[lbBoard]]); }
  function lbFmt(v) { return lbBoard === 'peak' ? Math.round(v) + ' kt' : Number(v).toFixed(1) + ' ACE'; }
  function renderLbList() {
    var ol = $('lb-list'), board = lbCache[lbViewMode];
    if (!board) { ol.classList.add('hidden'); ol.innerHTML = ''; return; }   // still loading
    var rows = board[lbBoard] || [];
    if (!rows.length) {
      ol.classList.remove('hidden');
      ol.innerHTML = '<li class="lb-empty">No scores yet — be the first!</li>';
      return;
    }
    var boardObj = lbBoard === 'peak' ? 'vmax' : 'ace', tol = lbBoard === 'peak' ? 1 : 0.05;
    ol.innerHTML = rows.map(function (r, i) {
      var me = lbMine && lbMine.mode === lbViewMode && lbMine.objective === boardObj &&
        r.name === lbMine.name && Math.abs(lbCell(r) - lbMine[lbBoard]) < tol;
      return '<li class="lb-entry' + (me ? ' me' : '') + '">' +
        '<span class="lb-pos">' + (i + 1) + '</span>' +
        '<span class="lb-name">' + escapeHtml(r.name) + '</span>' +
        '<span class="lb-ace">' + lbFmt(lbCell(r)) + '</span></li>';
    }).join('');
    ol.classList.remove('hidden');
  }
  function loadBoards(mode) {
    if (lbCache[mode]) { if (mode === lbViewMode) renderLbList(); return Promise.resolve(); }
    return Promise.all([Leaderboard.top('total', mode, 20), Leaderboard.top('storm', mode, 20), Leaderboard.top('peak', mode, 20)])
      .then(function (res) { lbCache[mode] = { total: res[0], storm: res[1], peak: res[2] }; if (mode === lbViewMode) renderLbList(); });
  }
  function setLbBoard(board) {
    lbBoard = board;
    [].forEach.call(document.querySelectorAll('.lb-tab'), function (b) {
      b.classList.toggle('is-active', b.getAttribute('data-board') === board);
    });
    renderLbList();
  }
  function setLbViewMode(mode) {
    lbViewMode = mode;
    if ($('lb-basin').value !== mode) $('lb-basin').value = mode;
    renderLbList();          // show cached (or loading) immediately…
    loadBoards(mode);        // …then fill in
  }
  function renderLeaderboard(headline, avgPct, isBest, prevBest) {
    var vmax = game.objective === 'vmax';
    var fmt = function (x) { return vmax ? Math.round(x) + ' kt' : Number(x).toFixed(1) + ' ACE'; };
    // Personal best line (always shown — works with no backend).
    $('leaderboard').innerHTML = isBest
      ? '<svg class="lb-ic"><use href="#ic-trophy"/></svg> New personal best! <b>' + fmt(headline) + '</b>'
      : 'Personal best: <b>' + fmt(Math.max(prevBest, headline)) + '</b>';

    var sub = $('lb-submit'), controls = $('lb-controls'), rankEl = $('lb-rank');
    if (!window.Leaderboard || !Leaderboard.configured()) {
      sub.classList.add('hidden'); controls.classList.add('hidden'); $('lb-list').classList.add('hidden');
      rankEl.classList.add('hidden'); return;
    }
    lbMine = null; lbCache = {}; lbRowId = null;
    sub.classList.remove('hidden'); sub.classList.remove('done');
    var msg = $('lb-msg'); msg.textContent = ''; msg.className = 'lb-msg';
    var nm = $('lb-name'); nm.value = ''; nm.disabled = false;
    $('lb-submit-btn').disabled = false;
    controls.classList.remove('hidden');
    setLbBoard(vmax ? 'peak' : 'total');     // default to the board matching your objective
    setLbViewMode(game.mode);                // default to the basin you just played

    // Record this game anonymously, then show where it ranks (today + all-time)
    // within the same basin × objective. Naming the board (below) is opt-in.
    rankEl.classList.remove('hidden');
    rankEl.innerHTML = '<span class="spinner"></span> Recording your game…';
    var metrics = { totalAce: game.totalAce, bestStormAce: bestStormAce(), bestPeakKt: bestPeakKt() };
    Leaderboard.record(game.mode, game.objective, metrics, avgPct).then(function (id) {
      lbRowId = id;
      return Leaderboard.rank(game.mode, game.objective, vmax ? metrics.bestPeakKt : metrics.totalAce);
    }).then(function (rk) {
      if (!rk) { rankEl.classList.add('hidden'); return; }
      var line = function (label, r) {
        var top = r.total > 0 ? Math.max(1, Math.round(100 * r.rank / r.total)) : 100;
        return label + ' <b>#' + r.rank.toLocaleString() + '</b> of ' + r.total.toLocaleString() +
          ' <span class="muted">(top ' + top + '%)</span>';
      };
      rankEl.innerHTML = '<svg class="lb-ic"><use href="#ic-trophy"/></svg> ' +
        line('Today', rk.today) + ' &nbsp;·&nbsp; ' + line('All-time', rk.all);
    }).catch(function () { rankEl.classList.add('hidden'); });
  }
  function submitScore() {
    if (!window.Leaderboard || !Leaderboard.configured() || $('lb-name').disabled) return;
    var name = $('lb-name').value, msg = $('lb-msg');
    var err = Leaderboard.validName(name);
    if (err) { msg.textContent = err; msg.className = 'lb-msg err'; return; }
    if (lbRowId == null) { msg.textContent = 'Still recording your game — one moment…'; msg.className = 'lb-msg'; return; }
    $('lb-submit-btn').disabled = true;
    msg.textContent = 'Saving…'; msg.className = 'lb-msg';
    var mode = game.mode, obj = game.objective;
    var m = { totalAce: game.totalAce, bestStormAce: bestStormAce(), bestPeakKt: bestPeakKt() };
    Leaderboard.claim(lbRowId, name).then(function () {           // attach name to our recorded row
      msg.textContent = 'On the board!'; msg.className = 'lb-msg ok';
      $('lb-submit').classList.add('done'); $('lb-name').disabled = true;
      track('score_submit', { mode: mode, objective: obj, total_ace: Number(m.totalAce.toFixed(1)),
        best_storm_ace: Number(m.bestStormAce.toFixed(1)), best_peak_kt: Number(m.bestPeakKt.toFixed(1)) });
      lbMine = { name: name.trim(), mode: mode, objective: obj,
        total: Number(m.totalAce.toFixed(1)), storm: Number(m.bestStormAce.toFixed(1)), peak: Number(m.bestPeakKt.toFixed(1)) };
      delete lbCache[mode];          // refetch so your named row appears
      setLbBoard(obj === 'vmax' ? 'peak' : 'total');
      setLbViewMode(mode);
    }).catch(function (e) {
      msg.textContent = e.message || 'Could not save.'; msg.className = 'lb-msg err';
      $('lb-submit-btn').disabled = false;
    });
  }

  // ---- share (expose the game via a URL) ----
  // Two flavors, both encoded into a URL hash (#share=<base64url JSON>):
  //   t:'s' — one storm: (basin, year, month, day, seed lat/lon). Opening the
  //           link re-runs that EXACT deterministic storm (the model has no RNG)
  //           and animates it, then invites the viewer to play.
  //   t:'g' — a finished game: a read-only recap card (per-round breakdown).
  // No backend, no per-result image — link preview falls back to the generic OG card.
  function b64uEnc(obj) {
    var s = btoa(unescape(encodeURIComponent(JSON.stringify(obj))));
    return s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function b64uDec(str) {
    var s = str.replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    return JSON.parse(decodeURIComponent(escape(atob(s))));
  }
  function shareLink(payload) { return location.origin + location.pathname + '#share=' + b64uEnc(payload); }

  function showToast(msg) {
    var t = $('toast'); if (!t) return;
    t.textContent = msg; t.classList.remove('hidden');
    requestAnimationFrame(function () { t.classList.add('show'); });
    clearTimeout(showToast._t);
    showToast._t = setTimeout(function () {
      t.classList.remove('show');
      setTimeout(function () { t.classList.add('hidden'); }, 320);
    }, 2400);
  }
  function fallbackCopy(url) {
    try {
      var ta = document.createElement('textarea');
      ta.value = url; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
      showToast('Link copied — paste it anywhere');
    } catch (e) { window.prompt('Copy this link:', url); }
  }
  function doShare(title, text, url) {
    if (navigator.share) { navigator.share({ title: title, text: text, url: url }).catch(function () {}); return; }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(url).then(function () { showToast('Link copied — paste it anywhere'); }, function () { fallbackCopy(url); });
    } else fallbackCopy(url);
  }

  function shareStorm() {
    if (!results || chosenIdx < 0 || !dealDate || !seeds[chosenIdx]) return;
    var r = results[chosenIdx], s = seeds[chosenIdx];
    var payload = { t: 's', b: dealDate.basin, y: dealDate.year, m: dealDate.month, d: dealDate.day,
                    la: Number(s.lat.toFixed(2)), lo: Number(s.lon.toFixed(2)) };
    var txt = 'I read the storm environment and spun up a ' + Math.round(r.peakV) + '-kt ' +
      catLabel(r.peakCat) + ' (' + r.ace.toFixed(1) + ' ACE) in Seed the Storm — can you forecast a stronger one?';
    track('share', { kind: 'storm', basin: dealDate.basin, peak_kt: Math.round(r.peakV) });
    doShare('Seed the Storm', txt, shareLink(payload));
  }
  function shareGame() {
    var vmax = game.objective === 'vmax';
    var rows = game.rows.map(function (r) {
      return { r: r.round, d: r.date, l: r.label, c: r.cat, a: Number(r.ace.toFixed(1)), v: Math.round(r.peakV), p: r.points };
    });
    var payload = { t: 'g', mode: game.mode, obj: game.objective,
                    total: Number(game.totalAce.toFixed(1)), peak: Math.round(bestPeakKt()),
                    avg: Math.round(game.total / ROUNDS), rows: rows };
    var head = vmax ? (Math.round(bestPeakKt()) + '-kt peak') : (game.totalAce.toFixed(1) + ' ACE');
    var txt = 'I scored ' + head + ' reading the storm environment in ' +
      (MODE_LABEL[game.mode] || 'Seed the Storm') + ' — can you beat my forecast?';
    track('share', { kind: 'game', mode: game.mode });
    doShare('Seed the Storm', txt, shareLink(payload));
  }

  // Re-run a single shared storm deterministically and animate it.
  function showSharedStorm(p) {
    var basin = BASINS[p.b] || BASINS.atl;
    sharedMode = true;
    track('shared_open', { kind: 'storm', basin: basin.key });   // someone opened a shared-storm link
    game = { round: 0, total: 0, totalAce: 0, rows: [], mode: basin.key, objective: 'ace' };
    $('basin-name').textContent = basin.name + ' · ';
    $('round-label').textContent = 'Shared storm';
    $('score-badge').classList.add('hidden');
    showStage('result');
    status('Loading shared storm…');
    dealDate = { year: p.y, month: p.m, day: p.d, basin: basin.key };
    elDealDate.textContent = MONTH_NAMES[p.m] + ' ' + p.d + ', ' + p.y;
    if (basin.view) map.setView(basin.view.center, basin.view.zoom, { animate: false });
    loadEnv(basin.key, p.y, p.m, p.d - 1).then(function (e) {
      env = e;
      seeds = [{ lat: p.la, lon: p.lo }];
      chosenIdx = 0;
      results = Model.runSeeds(env, seeds);
      renderFlow(); renderShear(); renderMpi();
      status('');
      revealShared(results[0]);
      animateTrack(0);
    }).catch(function (err) {
      console.error(err);
      status('Could not load the shared storm — starting a fresh game.', true);
      sharedMode = false; setTimeout(goHome, 1400);
    });
  }
  // A focused, score-free reveal for a shared storm (no "best seed" comparison).
  function revealShared(r) {
    var v = $('verdict');
    v.className = 'verdict win';
    v.innerHTML = '<svg class="v-ic"><use href="#ic-cyclone"/></svg>';
    var sp = document.createElement('span'); sp.textContent = 'Someone seeded this storm — watch it grow.'; v.appendChild(sp);
    $('score-line').innerHTML = 'Peaked at <b>' + Math.round(r.peakV) + ' kt</b> (' +
      catLabel(r.peakCat) + ') &nbsp;·&nbsp; <b>' + r.ace.toFixed(1) + ' ACE</b>';
    renderClimoLine(r);
    $('result-list').innerHTML = '';
    $('result-hint').classList.add('hidden');   // single shared storm — nothing else to compare against
    var cmp = $('compare'); if (cmp) { cmp.classList.add('hidden'); cmp.innerHTML = ''; }   // no head-to-head for a lone storm
    $('teach').innerHTML = 'This storm ' + describe(r) + '.';
    $('share-storm-btn').classList.add('hidden');     // (re-sharing handled from a fresh game)
    $('next-btn').textContent = 'Play Seed the Storm →';
    drawIntensityChart();
  }

  // Render a shared game as a read-only recap, reusing the summary stage.
  function showSharedGame(p) {
    sharedMode = true;
    track('shared_open', { kind: 'game', mode: p.mode || 'atl' });   // someone opened a shared-game link
    game = { round: 0, total: 0, totalAce: p.total || 0, rows: [], mode: p.mode || 'atl', objective: p.obj || 'ace' };
    var vmax = p.obj === 'vmax';
    $('score-badge').classList.add('hidden');
    var h2 = stages.summary.querySelector('h2'); if (h2) h2.textContent = 'A shared game';
    $('summary-total').innerHTML = (vmax
      ? 'They peaked at <b>' + p.peak + ' kt</b>'
      : 'They scored <b>' + Number(p.total).toFixed(1) + ' ACE</b>') +
      ' &nbsp;·&nbsp; <span class="muted">' + escapeHtml(MODE_LABEL[p.mode] || '') +
      ' · picked ' + p.avg + '% of the best on average</span>';
    var ul = $('summary-list'); ul.innerHTML = '';
    (p.rows || []).forEach(function (r) {
      var c = String(r.c), li = document.createElement('li');
      li.className = 'summary-row';
      li.innerHTML = '<span><b>R' + r.r + '</b> · ' + escapeHtml(String(r.d)) + '</span>' +
        '<span class="result-tag">seed ' + escapeHtml(String(r.l)) + ' · ' +
        (c.length === 1 ? 'Cat ' : '') + escapeHtml(c) + ' · ' + r.p + '% of best</span>' +
        '<span class="sr-pts">' + (vmax ? r.v + ' kt' : Number(r.a).toFixed(1) + ' ACE') + '</span>';
      ul.appendChild(li);
    });
    ['leaderboard', 'lb-rank', 'lb-submit', 'lb-controls', 'lb-list'].forEach(function (id) { $(id).classList.add('hidden'); });
    $('share-game-btn').classList.add('hidden');
    $('again-btn').textContent = 'Play your own →';
    showStage('summary');
  }

  // Parse a #share= link on load. Returns true if a shared view was launched.
  function readShare() {
    var m = (location.hash || '').match(/share=([^&]+)/);
    if (!m) return false;
    var p; try { p = b64uDec(m[1]); } catch (e) { return false; }
    if (!p || (p.t !== 's' && p.t !== 'g')) return false;
    // Drop the hash so Replay / New game don't re-trigger the shared view.
    try { history.replaceState(null, '', location.pathname + location.search); }
    catch (e) { location.hash = ''; }
    if (p.t === 's') showSharedStorm(p); else showSharedGame(p);
    return true;
  }

  // ---- wire up ----
  function init() {
    initMap();
    ERA5.loadClimo().then(function (c) { climo = c; });   // small JSON; powers the percentile line
    $('start-btn').addEventListener('click', startGame);   // intro -> begin the game in the chosen basin
    $('deal-btn').addEventListener('click', goHome);        // topbar "New game" -> back to basin pick
    $('run-btn').addEventListener('click', runSimulation);  // "Choose this seed"
    $('next-btn').addEventListener('click', nextOrFinish);  // "Next round" / "See final results"
    $('replay-btn').addEventListener('click', replayAnimation);
    $('share-storm-btn').addEventListener('click', shareStorm);   // result -> share this one storm
    $('share-game-btn').addEventListener('click', shareGame);     // summary -> share the whole game
    // "Play again" (or "Play your own →" after a shared-game card).
    $('again-btn').addEventListener('click', function () { if (sharedMode) goHome(); else startGame(); });
    $('lb-submit-btn').addEventListener('click', submitScore);
    $('lb-name').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submitScore(); } });
    // tutorial controls + the intro "How it works" replay link
    $('tut-back').addEventListener('click', tutBack);
    $('tut-next').addEventListener('click', tutNext);
    $('tut-skip').addEventListener('click', endTutorial);
    $('tut-play').addEventListener('click', endTutorial);
    $('how-it-works').addEventListener('click', function (e) { e.preventDefault(); runTutorial(); });
    // basin mode picker (intro)
    [].forEach.call(document.querySelectorAll('.mode-opt'), function (b) {
      b.addEventListener('click', function () {
        selectedMode = b.getAttribute('data-mode');
        [].forEach.call(document.querySelectorAll('.mode-opt'), function (o) {
          o.classList.toggle('is-active', o === b);
        });
      });
    });
    // objective picker (intro): maximize ACE vs peak intensity
    [].forEach.call(document.querySelectorAll('.obj-opt'), function (b) {
      b.addEventListener('click', function () {
        selectedObjective = b.getAttribute('data-obj');
        [].forEach.call(document.querySelectorAll('.obj-opt'), function (o) {
          o.classList.toggle('is-active', o === b);
        });
      });
    });
    $('lb-basin').addEventListener('change', function () { setLbViewMode(this.value); });
    [].forEach.call(document.querySelectorAll('.lb-tab'), function (b) {
      b.addEventListener('click', function () { setLbBoard(b.getAttribute('data-board')); });
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
    // A #share= link opens straight into the shared storm/game. Otherwise:
    // first-ever visit → the scripted tutorial; returning visitor → the normal
    // intro with the live sample-environment preview behind it.
    if (!readShare()) {
      var seenTut = false;
      try { seenTut = !!window.localStorage.getItem('seedstorm_tutorial_seen'); } catch (e) {}
      if (seenTut) { showStage('intro'); startAttract(); }
      else runTutorial();
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
