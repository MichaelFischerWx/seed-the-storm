#!/usr/bin/env python3
"""Add gridded per-year-month potential intensity (MPI) to the pack.

GC-ATLAS publishes real (tcpyPI-style) gridded MPI per year-month at
gs://gc-atlas-era5/tiles_per_year/single_levels/mpi/YYYY_MM.bin.gz (m/s, 181x360,
90N..90S). This grabs 1991-2020 x months 6-12, subsets the NH band (0-60N),
converts to kt, and re-encodes in our f16-gz format -> data/mpi/YYYY_MM.bin.gz
plus a 'mpi' entry in data/manifest.json. Replaces the empirical DeMaria-Kaplan
MPI with the real field, so the intensity ceiling now carries each year's warm/
cool anomaly. Re-run after build_nh_pack.py (which rewrites the manifest).
"""
import os, json, gzip, urllib.request
import numpy as np

SRC = 'https://storage.googleapis.com/gc-atlas-era5/tiles_per_year'
OUT = os.path.join(os.path.dirname(__file__), '..', 'data')
NAN = 65535
LAT_S = slice(30, 91)     # 181-row 90N..90S -> NH band 60N..0N (rows 30..90)
LON = slice(0, 360)
MONTHS = [6, 7, 8, 9, 10, 11, 12]
YEARS = list(range(1991, 2021))
KT = 1.94384


def main():
    src = json.loads(urllib.request.urlopen(SRC + '/manifest.json').read())
    mpi = src['groups']['single_levels']['mpi']
    ny, nx = mpi['shape']; nanS = mpi['nan_sentinel']; ql = mpi['quantization_levels']; tiles = mpi['tiles']
    os.makedirs(os.path.join(OUT, 'mpi'), exist_ok=True)
    man = json.load(open(os.path.join(OUT, 'manifest.json')))
    man['mpi'] = {}
    for y in YEARS:
        for m in MONTHS:
            key = '%d_%02d' % (y, m)
            t = tiles.get(key)
            if not t:
                continue
            u16 = np.frombuffer(gzip.decompress(urllib.request.urlopen(
                '%s/single_levels/mpi/%s.bin.gz' % (SRC, key)).read()), dtype='<u2').astype(np.float64)
            v = np.where(u16 == nanS, np.nan, t['vmin'] + u16 * (t['vmax'] - t['vmin']) / ql).reshape(ny, nx)
            reg = (v[LAT_S, LON] * KT).astype(np.float32)   # NH band, kt
            fin = np.isfinite(reg)
            vmin = float(np.nanmin(reg)) if fin.any() else 0.0
            vmax = float(np.nanmax(reg)) if fin.any() else 1.0
            if vmax <= vmin:
                vmax = vmin + 1.0
            q = np.where(np.isnan(reg), NAN, np.clip(np.round((reg - vmin) / ((vmax - vmin) / 65534.0)), 0, 65534)).astype('<u2')
            open(os.path.join(OUT, 'mpi', key + '.bin.gz'), 'wb').write(gzip.compress(q.tobytes(), 6))
            man['mpi'][key] = {'vmin': vmin, 'vmax': vmax}
        print('  %d' % y)
    json.dump(man, open(os.path.join(OUT, 'manifest.json'), 'w'))
    print('wrote %d mpi tiles' % len(man['mpi']))


if __name__ == '__main__':
    main()
