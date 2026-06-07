/* model.js — fast TC track + intensity integrator.
 *
 * Track: Beta-and-Advection (BAM). Storm advects with a deep-layer-mean
 *   steering wind (lower-troposphere-weighted blend of 850/200 hPa) plus an
 *   analytic beta-drift term (poleward + westward in the NH).
 * Intensity: logistic relaxation toward a shear-reduced MPI ceiling, with an
 *   explicit Kaplan-DeMaria-style decay over land / cold water.
 * Score: ACE = sum of V^2 (kt) over each 6 h with V >= 34 kt, in 10^4 kt^2.
 */
(function () {
  'use strict';

  var DEG_M = 111195;          // meters per degree latitude
  var DT_HR = 1;               // integration step (hours)
  var DT_S = DT_HR * 3600;
  var HORIZON_HR = 672;        // 28 days (integrate until dissipation; cheap)
  var DEG2RAD = Math.PI / 180;

  // Steering is precomputed (0.75*V850 + 0.25*V200 -> env.steeru/steerv) in the
  // regional pack, so the model reads it directly.
  // Beta drift: ~2 m/s toward ~320 deg (WNW) in the NH.
  var BETA_MS = 2.0, BETA_U = Math.sin(320 * DEG2RAD), BETA_V = Math.cos(320 * DEG2RAD);

  // --- Intensity: Logistic Growth Equation Model (LGEM; DeMaria 2009, MWR) ---
  //   Over water:  dV/dt = kappa*V - beta*V*(V/Vmpi)^n            (Eq. 3)
  //   Over land :  dV/dt = -alpha*(V - Vb)   (Kaplan-DeMaria)     (Eq. 10)
  // kappa is the time-dependent growth rate; in hostile environments it goes
  // negative and the storm decays. We use a reduced, shear-only kappa(S) (the
  // paper's full form is kappa(S, C, S*C); we lack a gridded convective-
  // instability field C, so the C terms are dropped).
  var V0 = 35;                 // seed intensity (kt) — an organized disturbance
  var BETA = 1 / 24;           // h^-1  (LGEM beta = 1/24 h^-1 = 1 day^-1)
  var N_EXP = 2.5;             // LGEM mortality exponent
  // kappa(shear): linear, kappa = KMAX at zero shear, zero-crossing near
  // 12.5 m/s (Fig. 8), negative beyond. KMAX = beta (=1 day^-1) so the steady
  // state (V_s = Vmpi*(kappa/beta)^(1/n)) tops out at exactly MPI in dead-calm
  // shear and never exceeds it. At mean shear (~9 m/s) V_s ~ 60% of MPI (paper:
  // "~58%"); the favorable corner (S~5) reaches ~82% -> Cat 3-4. The shear-only
  // line implicitly carries the dropped convective-instability (C) term.
  var KMAX = 1.0;              // day^-1, growth rate at zero shear (= beta)
  var SHEAR_ZERO = 15;         // m/s, shear at which kappa = 0 — storms intensify
                               // through moderate shear and begin to decay by ~12–15 m/s.
  var KS = KMAX / SHEAR_ZERO;  // day^-1 per m/s (kappa slope vs shear)
  var KAPPA_MIN = -1.0;        // day^-1 floor in extreme shear
  var ALPHA_LAND = 0.10;       // h^-1 inland-decay rate (low-latitude)
  var V_B = 14;                // kt, background wind the inland decay relaxes to
  var R_LAND = 0.9;            // coastline wind-reduction factor (Kaplan-DeMaria)
  var MPI_MIN = 30;            // kt; below this (cold water) use the decay branch
  var DV_CAP = 30;             // kt/hr cap on |dV| for numerical safety
  var V_DEAD = 15;             // dissipation threshold once weakening
  var ACE_MIN = 34;            // kt; tropical-storm threshold for ACE

  // Steering velocity (m/s) at a point/time, beta drift included. null if off-grid.
  function steeringAt(env, dayFloat, lat, lon) {
    var u = ERA5.sampleTime(env.steeru, dayFloat, lat, lon);
    var v = ERA5.sampleTime(env.steerv, dayFloat, lat, lon);
    if (!isFinite(u) || !isFinite(v)) return null;
    return { u: u + BETA_MS * BETA_U, v: v + BETA_MS * BETA_V };
  }

  // Position derivative in deg/hr given a steering velocity (m/s).
  function posDeriv(vel, lat) {
    var cosl = Math.cos(lat * DEG2RAD);
    if (cosl < 0.05) cosl = 0.05;
    return {
      dlat: vel.v * DT_S / DEG_M,
      dlon: vel.u * DT_S / (DEG_M * cosl),
    };
  }

  // One RK4 step for position. Returns {lat, lon} or null if it leaves the grid.
  function rk4(env, dayFloat, lat, lon) {
    var dDay = DT_HR / 24;
    var k1v = steeringAt(env, dayFloat, lat, lon); if (!k1v) return null;
    var k1 = posDeriv(k1v, lat);
    var k2v = steeringAt(env, dayFloat + dDay / 2, lat + k1.dlat / 2, lon + k1.dlon / 2);
    if (!k2v) return null; var k2 = posDeriv(k2v, lat + k1.dlat / 2);
    var k3v = steeringAt(env, dayFloat + dDay / 2, lat + k2.dlat / 2, lon + k2.dlon / 2);
    if (!k3v) return null; var k3 = posDeriv(k3v, lat + k2.dlat / 2);
    var k4v = steeringAt(env, dayFloat + dDay, lat + k3.dlat, lon + k3.dlon);
    if (!k4v) return null; var k4 = posDeriv(k4v, lat + k3.dlat);
    return {
      lat: lat + (k1.dlat + 2 * k2.dlat + 2 * k3.dlat + k4.dlat) / 6,
      lon: lon + (k1.dlon + 2 * k2.dlon + 2 * k3.dlon + k4.dlon) / 6,
    };
  }

  function catOf(v) {
    if (v < 34) return 'TD';
    if (v < 64) return 'TS';
    if (v < 83) return '1';
    if (v < 96) return '2';
    if (v < 113) return '3';
    if (v < 137) return '4';
    return '5';
  }

  // East-Pacific boundary: the Pacific coast of the Americas (lon as a function
  // of lat). A storm west of this in the tropics/subtropics has crossed out of
  // the Atlantic basin (e.g. over Central America / the Isthmus of Tehuantepec),
  // so it's no longer an Atlantic storm and its ACE shouldn't count.
  var _PAC_COAST = [[7, -81], [10, -84], [12, -87], [14, -89], [16, -92],
                    [18, -95], [20, -100], [22, -105], [25, -110]];
  function pacCoastLon(lat) {
    var t = _PAC_COAST;
    if (lat <= t[0][0]) return t[0][1];
    for (var k = 1; k < t.length; k++) {
      if (lat <= t[k][0]) {
        var f = (lat - t[k - 1][0]) / (t[k][0] - t[k - 1][0]);
        return t[k - 1][1] + f * (t[k][1] - t[k - 1][1]);
      }
    }
    return t[t.length - 1][1];
  }
  function inEastPacific(lat, lon) { return lat >= 6 && lat <= 28 && lon < pacCoastLon(lat); }

  // Integrate a single seed. seed = {lat, lon}. Returns full diagnostics.
  function integrate(env, seed) {
    var lat = seed.lat, lon = seed.lon, v = V0;
    var ace = 0, peakV = v, everStorm = false;
    var madeLandfall = false, maxShear = 0, recurved = false, weakening = false;
    var minLon = lon, endReason = 'horizon', overLand = false;
    var track = [];

    for (var hr = 0; hr <= HORIZON_HR; hr += DT_HR) {
      var dayFloat = env.startDayIdx + hr / 24;

      // Atlantic mode only: if the storm crosses into the East Pacific it has
      // left the basin — stop (its ACE there belongs to a different basin).
      if (env.excludeEPac && inEastPacific(lat, lon)) { endReason = 'left-basin'; break; }

      // Environment at the current point.
      var shear = ERA5.sampleTime(env.shear, dayFloat, lat, lon);
      if (!isFinite(shear)) shear = 0;
      // Real gridded potential intensity (kt) for this year-month — carries the
      // year's warm/cool anomaly (replaces the old empirical DeMaria-Kaplan).
      // NaN over land/cold → treat as 0 (drives the decay branch).
      var mpiKt = env.mpi ? ERA5.bilinear(env.mpi.values, env.mpi.grid, lat, lon) : (MPI.atPoint(env.sst, lat, lon).mpi);
      if (!isFinite(mpiKt)) mpiKt = 0;
      // Land fraction from the high-res (0.1°) mask if present.
      var lf = 0;
      if (env.landmask) {
        lf = ERA5.bilinear(env.landmask.values, env.landmask.grid, lat, lon);
        lf = isFinite(lf) ? Math.max(0, Math.min(1, lf)) : 0;
      }
      var onLand = lf >= 0.5;
      maxShear = Math.max(maxShear, shear);

      track.push({ hr: hr, lat: lat, lon: lon, v: v, cat: catOf(v),
                   shear: shear, mpi: mpiKt, landFrac: lf, land: onLand });

      if (v >= ACE_MIN) everStorm = true;
      if (everStorm && hr % 6 === 0) ace += v * v;   // 6-hourly ACE
      peakV = Math.max(peakV, v);
      if (lon < minLon) minLon = lon;
      if (lon > minLon + 2 && lat > 25) recurved = true; // turned back east at high lat

      // LGEM intensity update (forward Euler at dt = 1 h, per DeMaria 2009), with
      // graded land decay: the over-water tendency and the inland-decay tendency
      // are blended by the land fraction, so islands/coasts weaken storms in
      // proportion to how much land they're over.
      if (onLand) madeLandfall = true;
      var landDV = -ALPHA_LAND * (v - V_B);
      var waterDV;
      if (mpiKt < MPI_MIN) {
        waterDV = -ALPHA_LAND * (v - V_B);     // cold / no-MPI water also decays
      } else {
        // kappa(shear) goes negative above SHEAR_ZERO so the storm weakens
        // smoothly — storms begin to decay around 12–15 m/s of shear.
        var kappa = Math.max(KAPPA_MIN, KMAX - KS * shear) / 24; // h^-1
        var mort = BETA * v * Math.pow(v / mpiKt, N_EXP);
        waterDV = kappa * v - mort;
      }
      var dV = (1 - lf) * waterDV + lf * landDV;
      if (dV > DV_CAP) dV = DV_CAP; else if (dV < -DV_CAP) dV = -DV_CAP;
      var vNext = v + dV * DT_HR;
      // Kaplan-DeMaria coastline reduction on each land<->water crossing.
      if (onLand && !overLand) vNext *= R_LAND;
      else if (!onLand && overLand) vNext /= R_LAND;
      overLand = onLand;
      v = Math.max(8, vNext);
      if (v < peakV - 5) weakening = true;
      if (weakening && v < V_DEAD) { endReason = 'dissipated'; break; }

      // Advance position.
      var np = rk4(env, dayFloat, lat, lon);
      if (!np) { endReason = 'left-domain'; break; }
      lat = np.lat; lon = np.lon;
      if (lat > 58 || lat < 0) { endReason = 'left-domain'; break; }
    }

    return {
      seed: seed, track: track, ace: ace / 1e4, peakV: peakV, peakCat: catOf(peakV),
      madeLandfall: madeLandfall, maxShear: maxShear, recurved: recurved,
      endReason: endReason,
    };
  }

  function runSeeds(env, seeds) {
    return seeds.map(function (s) { return integrate(env, s); });
  }

  // Ambient deep-layer-mean steering wind (m/s), WITHOUT the storm-specific
  // beta drift — this is the environmental current to visualize as flow.
  // null if off-grid.
  function ambientUV(env, dayFloat, lat, lon) {
    var u = ERA5.sampleTime(env.steeru, dayFloat, lat, lon);
    var v = ERA5.sampleTime(env.steerv, dayFloat, lat, lon);
    if (!isFinite(u) || !isFinite(v)) return null;
    return { u: u, v: v };
  }

  window.Model = {
    integrate: integrate, runSeeds: runSeeds, catOf: catOf, ambientUV: ambientUV,
    HORIZON_HR: HORIZON_HR, V0: V0,
  };
})();
