/* mpi.js — empirical maximum potential intensity (MPI) from SST.
 *
 * DeMaria & Kaplan (1994) Atlantic fit:
 *   V_pi(m/s) = A + B * exp(C * (T - T0)),  A=28.2, B=55.8, C=0.1813, T0=30C
 * The empirical fit only behaves above ~26C, so we taper it to zero between
 * 28C and 25C (a "cool-water cutoff") and treat land (SST = NaN) as MPI 0,
 * which drives the intensity ODE into decay over cold water and after landfall.
 */
(function () {
  'use strict';

  var A = 28.2, B = 55.8, C = 0.1813, T0 = 30.0; // m/s, degC
  var MS_TO_KT = 1.94384;
  // Monthly-mean climatology SST runs cooler than the daily warm pools / ocean
  // heat content that fuel the strongest storms, biasing MPI low. A small uplift
  // restores enough headroom for an occasional Cat 5 in the warmest, low-shear spots.
  var MPI_SCALE = 1.06;

  function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }

  // sstK: sea-surface temperature in Kelvin (NaN over land).
  // Returns { mpi: kt, sstC: degC, land: bool }.
  function vpotFromK(sstK) {
    if (!isFinite(sstK)) return { mpi: 0, sstC: NaN, land: true };
    var sstC = sstK - 273.15;
    var raw = A + B * Math.exp(C * (sstC - T0));          // m/s
    var cool = clamp((sstC - 23) / 4, 0, 1);              // 0 @23C -> 1 @27C
    return { mpi: raw * cool * MS_TO_KT * MPI_SCALE, sstC: sstC, land: false };
  }

  // Sample the monthly SST climatology grid at lat/lon, then convert to MPI.
  function atPoint(sstField, lat, lon) {
    var k = ERA5.bilinear(sstField.values, sstField.grid, lat, lon);
    return vpotFromK(k);
  }

  window.MPI = { vpotFromK: vpotFromK, atPoint: atPoint };
})();
