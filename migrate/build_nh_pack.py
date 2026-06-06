#!/usr/bin/env python3
"""Build a compact Northern-Hemisphere (0–60N) ERA5 pack for Seed the Storm.

Downloads the public GCS tiles, blends the deep-layer steering
(0.75*V850 + 0.25*V200 -> steeru/steerv), subsets to the NH band
(lat 0..60N, all longitudes), and re-encodes in the same f16-gz format the game
already reads. Output -> data/ (committed to the repo, served same-origin on
GitHub Pages -> zero egress, no CORS). The full-longitude band covers every NH
basin (Atlantic, E/Central Pacific, W Pacific, N Indian) for future work.

Usage:  python3 build_atlantic_pack.py [years]
        python3 build_atlantic_pack.py 2017            # one year (validation)
        python3 build_atlantic_pack.py 1991-2020       # full set
"""
import os, sys, gzip, json, urllib.request
import numpy as np

DAILY = 'https://storage.googleapis.com/tc-atlas-ir-cache/era5_daily_1deg'
GC_MAN = 'https://storage.googleapis.com/gc-atlas-era5/tiles/manifest.json'
SST = 'https://storage.googleapis.com/gc-atlas-era5/tiles/single_levels/sst'
OUT = os.path.join(os.path.dirname(__file__), '..', 'data')
NAN = 65535
W850, W200 = 0.75, 0.25
MONTHS = [6, 7, 8, 9, 10, 11, 12]          # Jun–Nov deals + Dec (Nov's span)

# Northern Hemisphere band: lat 60..0 (daily rows 0..60, sst rows 30..90),
# ALL longitudes (cols 0..359). Covers every NH basin for future multi-basin work.
LAT_D = slice(0, 61); LAT_S = slice(30, 91); LON = slice(0, 360)
NY, NX = 61, 360
GRID = {'ny': NY, 'nx': NX, 'lat0': 60, 'dlat': -1, 'lon0': -180, 'dlon': 1}


def years_arg():
    a = sys.argv[1] if len(sys.argv) > 1 else '1991-2020'
    if '-' in a:
        lo, hi = a.split('-'); return list(range(int(lo), int(hi) + 1))
    return [int(x) for x in a.split(',')]


def fetch(url):
    with urllib.request.urlopen(url) as r:
        return r.read()


def dequant(buf, vmin, vmax, shape):
    u16 = np.frombuffer(gzip.decompress(buf), dtype='<u2').astype(np.float32)
    rng = (vmax - vmin) / 65534.0
    return np.where(u16 == NAN, np.nan, vmin + u16 * rng).reshape(shape)


def encode(arr):
    vmin = float(np.nanmin(arr)) if np.isfinite(arr).any() else 0.0
    vmax = float(np.nanmax(arr)) if np.isfinite(arr).any() else 1.0
    if vmax <= vmin:
        vmax = vmin + 1.0
    rng = (vmax - vmin) / 65534.0
    u16 = np.where(np.isnan(arr), NAN, np.clip(np.round((arr - vmin) / rng), 0, 65534)).astype('<u2')
    return gzip.compress(u16.tobytes(), 6), vmin, vmax


def main():
    years = years_arg()
    dman = json.loads(fetch(DAILY + '/manifest.json'))['tiles']
    sman = json.loads(fetch(GC_MAN))['groups']['single_levels']['sst']['tiles']
    man = {'grid': GRID, 'nan': NAN, 'daily': {}, 'sst': {}}
    for f in ('steeru', 'steerv', 'shear', 'sst'):
        os.makedirs(os.path.join(OUT, f), exist_ok=True)

    # SST climatology (all 12 months, tiny).
    for m in range(1, 13):
        mm = '%02d' % m; t = sman[mm]
        reg = dequant(fetch('%s/%s.bin.gz' % (SST, mm)), t['vmin'], t['vmax'], (181, 360))[LAT_S, LON]
        buf, vmin, vmax = encode(reg)
        open(os.path.join(OUT, 'sst', mm + '.bin.gz'), 'wb').write(buf)
        man['sst'][mm] = {'vmin': vmin, 'vmax': vmax}
    print('sst done')

    for y in years:
        for m in MONTHS:
            mm = '%02d' % m
            nd = dman['shear/%d_%s' % (y, mm)]['n_days']
            shp = (nd, 121, 360)

            def load(fld):
                t = dman['%s/%d_%s' % (fld, y, mm)]
                return dequant(fetch('%s/%s/%d_%s.bin.gz' % (DAILY, fld, y, mm)), t['vmin'], t['vmax'], shp)

            out = {
                'shear': load('shear')[:, LAT_D, LON],
                'steeru': (W850 * load('u850') + W200 * load('u200'))[:, LAT_D, LON],
                'steerv': (W850 * load('v850') + W200 * load('v200'))[:, LAT_D, LON],
            }
            for fld, arr in out.items():
                buf, vmin, vmax = encode(np.ascontiguousarray(arr))
                open(os.path.join(OUT, fld, '%d_%s.bin.gz' % (y, mm)), 'wb').write(buf)
                man['daily']['%s/%d_%s' % (fld, y, mm)] = {'vmin': vmin, 'vmax': vmax, 'nDays': nd}
            print('  %d-%s' % (y, mm))

    json.dump(man, open(os.path.join(OUT, 'manifest.json'), 'w'))
    print('manifest: %d daily tiles, %d sst' % (len(man['daily']), len(man['sst'])))


if __name__ == '__main__':
    main()
