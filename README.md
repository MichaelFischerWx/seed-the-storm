# Seed the Storm 🌀

An educational, *82-0.com*-style guessing game for tropical cyclones.

A game is **6 rounds — one per hurricane-season month, June → November**, each
drawn from an independent random year. You see the climatological seasonal arc
(shear relaxing and storms strengthening toward the Aug–Oct peak, then fading by
November) while every round is a fresh real example of that month, so no single
quiet/active year dominates a game. Each round the map shows the **real ERA5
environment** for that month, with an animated steering-flow field.
Four candidate **TC seeds** drop onto the map — you pick the one you think will
spin up into the storm with the most **Accumulated Cyclone Energy (ACE)**. Every
seed is integrated forward through the real winds, shear, and ocean **until it
dissipates**; the chosen seed's track animates (with the steering flow and shear
field evolving in step), and the reveal shows how close you came to the best
pick. **Your score is the total ACE your six chosen seeds produced** — directly
comparable between players — with a personal-best stub for a future leaderboard.

Scope: **North Atlantic** only (other basins are a future extension).

## Controls

- **Start game** → deal round 1 (June). Per round: pick a seed, **Choose this
  seed** to simulate, watch it play, then **Next round →** (or **See final
  results 🏆** after round 6, November). **▶ Replay** re-runs the current
  animation. An on-map **valid-time clock** (top-centre) shows the forecast date
  and lead time, advancing as the storm integrates forward so you can see the
  steering flow and shear field evolve in step.
- Map layers: **Steering flow** (particles, on by default, independent) plus one
  optional **global** shaded background field, drawn *beneath* the flow
  (earth.nullschool style), Mercator-warped to land geographically exact, with
  **coastlines** drawn on top so land stays legible and an **on-map colorbar**
  (bottom-left) titled for the active field:
  - **Wind shear (kt)** — diverging ramp, blue (favorable) below 20 kt → red
    (hostile) above, capped at 40 kt.
  - **Ocean potential** — empirical MPI on a Turbo "heat" ramp (indigo = weak →
    red = strong), visually distinct from the shear ramp so you always know
    which field you're viewing.

  (Shear and Ocean potential are mutually exclusive — one heat field at a time.)
  On the result chart, **Shear along track** overlays the shear (kt) the storm
  experienced as a neutral dashed line against its Saffir–Simpson-coloured V curve.

## Run it

It's a static site, no build step:

```sh
python3 -m http.server 8091
open http://localhost:8091
```

Everything runs **client-side** (free compute), and the ERA5 data ships **in the
repo** under `data/` — served **same-origin** (no CORS) on GitHub Pages with
**zero egress cost**. No backend, no Cloudflare, no GCS at runtime.

## How it works

| File | Role |
|---|---|
| `js/era5.js` | Fetch + decode `f16-gz` ERA5 tiles (`DecompressionStream` + uint16 dequantize), bilinear sampling, time-interp between daily 00Z frames |
| `js/mpi.js`  | Empirical maximum potential intensity from SST (DeMaria–Kaplan 1994), land/cold-water mask |
| `js/model.js`| BAM track integrator (RK4 steering + beta drift) + LGEM intensity (DeMaria 2009) + ACE |
| `js/particles.js` | Animated wind-particle flow layer (Leaflet canvas overlay) on the steering field |
| `js/contours.js` | Marching-squares isolines + canvas contour layer (unused — shear is now a shaded field; kept for reuse) |
| `js/game.js` | Round loop: deal → place seeds → pick → simulate → animate → reveal → score |

### Data (committed NH pack, `data/`)

The game reads a compact **Northern-Hemisphere band** pack built once by
[`migrate/build_nh_pack.py`](migrate/build_nh_pack.py) and committed under
`data/` (≈790 MB):

- Region **lat 0–60 °N, all longitudes** at **1°** (61×360). The full-longitude
  band covers every NH basin (Atlantic, E/Central & W Pacific, N Indian) so the
  game can be extended to other basins without rebuilding; for now the seeds and
  scoring are North-Atlantic only.
- **3 daily fields** per (year, month) for months 06–12, 1991–2020:
  `steeru`, `steerv` (precomputed deep-layer steering = 0.75·V850 + 0.25·V200)
  and `shear` — all `f16-gz` with per-tile `vmin/vmax` in `data/manifest.json`.
- **12 monthly SST** climatology tiles (`data/sst/{MM}.bin.gz`); SST = NaN ⇒ land mask.

Provenance: derived from the public `gs://tc-atlas-ir-cache/era5_daily_1deg/`
winds+shear and `gs://gc-atlas-era5/.../sst/` climatology. To regenerate or
extend (more years/region), edit and re-run the pipeline:
```sh
python3 migrate/build_nh_pack.py 1991-2020
```

### Hosting & cost

Page **and** data are served from **GitHub Pages** (same-origin). Compute is
client-side; egress is **$0** (GitHub Pages has no egress charges, only soft
fair-use limits far beyond friend-scale). A round downloads ~3 fields × 2 months
≈ a few MB, cached by the browser. (Earlier exploration of a Cloudflare R2 mirror
to keep a *global* field is preserved in `migrate/` if you ever want it.)

### Physics

- **Track — Beta and Advection (BAM):** the storm advects with a
  lower-troposphere-weighted blend of the 850/200 hPa winds (a deep-layer-mean
  steering proxy) plus an analytic beta-drift term (poleward + westward in the
  NH). RK4, 1 h steps, integrated **until dissipation** (28-day cap). To follow
  a storm past the month boundary, two consecutive months of wind/shear are
  loaded and concatenated onto a contiguous time axis.
- **Intensity — LGEM** (Logistic Growth Equation Model; DeMaria 2009, *MWR*
  **137**, 68–82). Over water `dV/dt = κ·V − β·V·(V/V_mpi)^n` with the paper's
  fitted constants **β = 1/24 h⁻¹**, **n = 2.5**; over land the Kaplan–DeMaria
  inland-decay law `dV/dt = −α(V − V_b)` with the coastline reduction factor.
  The growth rate **κ** is a function of vertical shear (the paper's full form
  is κ(S, C, S·C); we drop the convective-instability term **C** — no gridded
  instability field — and use a shear-only line: κ = β at zero shear,
  zero-crossing ≈ 15 m/s, **negative in strong shear** so storms smoothly
  weaken. The favorable-C slice / slightly higher zero-crossing lets storms
  intensify through moderate shear, giving a realistic Cat 1–5 spread). MPI
  ceiling from DeMaria–Kaplan (1994), which is exactly what LGEM uses for the
  Atlantic.
- **ACE:** Σ V² over each 6 h with V ≥ 34 kt, in 10⁴ kt². **Atlantic basin only** —
  if a storm crosses Central America / the Isthmus of Tehuantepec into the East
  Pacific (west of the Americas' Pacific coast, traced by `pacCoastLon(lat)` for
  6–28°N), it has left the basin: the integration stops there and no further ACE
  counts (mirroring NHC reclassifying such storms).

### Map layers

Three independent overlays in the pick/result panel:

- **Steering flow** (`js/particles.js`, *on by default*) — an earth.nullschool-style
  particle layer (Leaflet 2D-canvas overlay adapted from TC-ATLAS Panel C's
  `_evoParticleTick`) advecting ~700 particles on the **same deep-layer-mean
  steering field that moves the storm** (`Model.ambientUV`, the 0.75·V850 +
  0.25·V200 blend, beta drift excluded). It reuses the wind grids already in
  memory — **zero extra network calls**. Sampled at a settable time, which the
  game advances with the track animation, so the flow **evolves day-to-day** as
  the seed marches forward.
- **Wind shear (kt)** — colored contour isolines (marching squares, `js/contours.js`)
  at deal time, with the TC-ATLAS shear palette + a color-key legend. Layered
  *over* the flow (like the TC-ATLAS Global Map).
- **Ocean potential** — the empirical MPI field as a faint filled raster,
  drawn *below* the flow as background warm-pool shading.

The layers are independent (any combination); flow is the always-on base.

## Known approximations / upgrade paths

- MPI is **empirical from a monthly SST climatology** (×1.06 uplift, since
  monthly-mean SST runs cooler than the daily warm pools / OHC that fuel the
  strongest storms), not true gridded `tcpyPI` MPI on the actual date (a
  documented upgrade). Cat 5 is attainable (~5% of seeds in peak months) but rare.
- LGEM's growth rate uses **shear only** (the convective-instability term C is
  dropped — we have no gridded C field). The shear-only κ is amplitude-tuned so
  week-long spin-up from a seed reaches realistic intensities; LGEM was built to
  forecast change from an *observed* intensity, not genesis from a seed.
- Steering uses only 850 & 200 hPa (no 500/700) — a 2-level DLM proxy.
- Environment overlay uses an equirectangular image on a Mercator map, so it's
  visually approximate at high latitude.

## Roadmap (deferred from the slice)

All basins · multi-round draft + cumulative scoring/streaks · slot-machine
animation · per-seed track ensembles (the stochastic "luck" element) · true
gridded MPI.
