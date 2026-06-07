#!/usr/bin/env python3
"""Build a small per-storm climatology lookup for Seed the Storm.

For each Northern-Hemisphere basin (atl/epac/wpac/nio) and genesis month, we
take every real storm from IBTrACS (1991-2020, to match the game's year range)
and compute:

  * ACE  — Accumulated Cyclone Energy, summed EXACTLY as the game does it:
           synoptic 6-hourly points (00/06/12/18 UTC) with v >= 34 kt,
           sum(v^2) / 1e4.  Using the same definition makes the player's storm
           and the climatology an apples-to-apples comparison.
  * LMI  — lifetime-maximum intensity (kt), the peak-intensity-mode anchor.

We store an inverse-CDF: the value at each 5th percentile (0..100). At runtime
the frontend finds where the player's value falls between two anchors and
interpolates the percentile — so "27 ACE" -> "~83rd percentile for Sep Atlantic".

Winds: usa_wind (JTWC, 1-min sustained, kt) — the most globally complete,
consistent-averaging record across all four basins for the modern era.

Output: data/climo.json  (a few KB, committed; zero-egress like the rest).

Run:  python3 migrate/build_climo_percentiles.py
"""
import json, os, collections
import numpy as np
import xarray as xr

# IBTrACS source (the TC-ATLAS cache); override with IBTRACS_NC if needed.
IBTRACS = os.environ.get(
    'IBTRACS_NC',
    os.path.expanduser('~/github/TC-ATLAS/data/_ibtracs_cache/IBTrACS.ALL.v04r01.nc'))
OUT = os.path.join(os.path.dirname(__file__), '..', 'data', 'climo.json')

YEAR_MIN, YEAR_MAX = 1991, 2020
BMAP = {'NA': 'atl', 'EP': 'epac', 'WP': 'wpac', 'NI': 'nio'}
PCTS = list(range(0, 101, 5))          # 0,5,...,100  (21 inverse-CDF anchors)
MIN_N = 20                              # below this, pool neighbouring months
SYNOPTIC = np.array([0, 6, 12, 18])


def decode(x):
    return x.decode().strip() if isinstance(x, (bytes, bytearray)) else str(x).strip()


def main():
    ds = xr.open_dataset(IBTRACS)
    season = ds['season'].values                      # (storm,) float year
    basin = ds['basin'].values                        # (storm, dt) |S2
    wind = ds['usa_wind'].values.astype('float64')    # (storm, dt) kt
    time = ds['time'].values                          # (storm, dt) datetime64[ns]
    nstorm = wind.shape[0]

    ace_g = collections.defaultdict(list)   # (basin, month) -> [ace, ...]
    lmi_g = collections.defaultdict(list)
    kept = 0

    for i in range(nstorm):
        yr = season[i]
        if not (YEAR_MIN <= yr <= YEAR_MAX):
            continue
        w, t = wind[i], time[i]
        valid = ~np.isnan(w) & ~np.isnat(t)
        if not valid.any():
            continue
        wv, tv = w[valid], t[valid]

        # Genesis basin = first non-empty basin code along the track.
        gb = None
        for code in (decode(c) for c in basin[i]):
            if code:
                gb = code
                break
        if gb not in BMAP:
            continue
        b = BMAP[gb]

        # Genesis month from the first valid fix.
        month = int(tv[0].astype('datetime64[M]').astype(int) % 12) + 1

        hours = (tv.astype('datetime64[h]').astype('int64')) % 24
        syn = np.isin(hours, SYNOPTIC) & (wv >= 34)
        ace = float(np.sum(wv[syn] ** 2) / 1e4)
        lmi = float(np.nanmax(wv))

        ace_g[(b, month)].append(ace)
        lmi_g[(b, month)].append(lmi)
        kept += 1

    def anchors(vals):
        arr = np.sort(np.asarray(vals, dtype='float64'))
        return [round(float(np.percentile(arr, p)), 2) for p in PCTS]

    # Pool to >= MIN_N samples: own month -> +/-1 month -> whole season.
    def pooled(group, b, m):
        own = group.get((b, m), [])
        if len(own) >= MIN_N:
            return own, len(own), 'month'
        wide = own + group.get((b, (m - 2) % 12 + 1), []) + group.get((b, m % 12 + 1), [])
        if len(wide) >= MIN_N:
            return wide, len(wide), 'window'   # +/- 1 month
        allm = [v for (bb, mm), lst in group.items() if bb == b for v in lst]
        return allm, len(allm), 'season'

    climo = {}
    for b in BMAP.values():
        climo[b] = {}
        for m in range(1, 13):
            if (b, m) not in ace_g:
                continue
            av, an, asrc = pooled(ace_g, b, m)
            lv, ln, lsrc = pooled(lmi_g, b, m)
            if not av:
                continue
            climo[b][str(m)] = {
                'n': len(ace_g[(b, m)]), 'n_eff': an, 'src': asrc,
                'ace': anchors(av), 'lmi': anchors(lv),
            }

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w') as f:
        json.dump({'pcts': PCTS, 'years': [YEAR_MIN, YEAR_MAX],
                   'wind': 'usa_wind', 'basins': climo}, f, separators=(',', ':'))
    size = os.path.getsize(OUT)
    print(f'wrote {OUT}  ({size/1024:.1f} KB) — {kept} storms {YEAR_MIN}-{YEAR_MAX}')

    # ---- sanity print: known-ish anchors ----
    def show(b, m):
        d = climo.get(b, {}).get(str(m))
        if not d:
            print(f'  {b} {m}: (none)')
            return
        a, l = d['ace'], d['lmi']
        p = {pp: i for i, pp in enumerate(PCTS)}
        print(f'  {b} m{m:>2} n={d["n"]:>3}/{d["n_eff"]:>3} {d["src"]:>6} | '
              f'ACE p50={a[p[50]]:>5} p90={a[p[90]]:>5} max={a[p[100]]:>6} | '
              f'LMI p50={l[p[50]]:>5} p90={l[p[90]]:>5} kt')
    print('sanity (median / p90 / max):')
    for b in BMAP.values():
        for m in (8, 9, 10):
            show(b, m)


if __name__ == '__main__':
    main()
