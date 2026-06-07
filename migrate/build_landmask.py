#!/usr/bin/env python3
"""Build a high-resolution land-fraction mask for Seed the Storm.

The 1deg SST climatology under-resolves small islands (Hispaniola, Cuba, the
Philippines, Taiwan...), so the game's SST-NaN land mask lets storms sail over
them without decaying. This builds an independent 0.1deg (~11 km) land-FRACTION
field for the NH band (0-60N, all lon) from Natural Earth 10 m land polygons,
so the intensity model can apply graded Kaplan-DeMaria decay near coasts/islands
while still taking MPI from the 1deg SST over open ocean.

Output -> data/landmask.bin.gz (f16-gz, value 0..1) + a 'landmask' entry patched
into data/manifest.json. Re-run after build_nh_pack.py (which rewrites the
manifest from scratch). Needs cartopy + shapely + scipy.
"""
import os, json, gzip
import numpy as np
from scipy.ndimage import gaussian_filter1d
from PIL import Image, ImageDraw
import cartopy.io.shapereader as shpreader

OUT = os.path.join(os.path.dirname(__file__), '..', 'data')
NY, NX = 601, 3600                     # 0.1deg, NH band
LAT0, DLAT = 60.0, -0.1                # rows 60N -> 0N (matches era5 grid orientation)
LON0, DLON = -180.0, 0.1               # cols -180 -> 179.9


def _draw(dr, ring, fill):
    xy = [((x - LON0) / DLON, (y - LAT0) / DLAT) for (x, y) in ring]
    if len(xy) >= 3:
        dr.polygon(xy, fill=fill)


def main():
    # Rasterize NE 10m land polygons straight onto the 0.1deg grid with PIL —
    # vastly faster than per-point point-in-polygon. Exteriors = land, holes
    # (lakes) punched back to ocean.
    fn = shpreader.natural_earth(resolution='10m', category='physical', name='land')
    geoms = list(shpreader.Reader(fn).geometries())
    print('loaded %d NE-10m land polygons' % len(geoms))
    img = Image.new('L', (NX, NY), 0)
    dr = ImageDraw.Draw(img)
    for g in geoms:
        polys = list(g.geoms) if g.geom_type == 'MultiPolygon' else [g]
        for p in polys:
            _draw(dr, list(p.exterior.coords), 255)
            for hole in p.interiors:
                _draw(dr, list(hole.coords), 0)
    binary = np.asarray(img, dtype=np.float32) / 255.0
    print('land cells: %.1f%%' % (100.0 * binary.mean()))

    # Soften to a fraction so coastlines/small islands give graded decay
    # (lon wraps globally; lat edge-clamped).
    frac = gaussian_filter1d(binary, 1.0, axis=1, mode='wrap')
    frac = np.clip(gaussian_filter1d(frac, 1.0, axis=0, mode='nearest'), 0.0, 1.0)

    rng = 1.0 / 65534.0
    u16 = np.clip(np.round(frac / rng), 0, 65534).astype('<u2')
    buf = gzip.compress(u16.tobytes(), 6)
    open(os.path.join(OUT, 'landmask.bin.gz'), 'wb').write(buf)

    man_path = os.path.join(OUT, 'manifest.json')
    man = json.load(open(man_path))
    man['landmask'] = {'vmin': 0.0, 'vmax': 1.0,
                       'grid': {'ny': NY, 'nx': NX, 'lat0': LAT0, 'dlat': DLAT, 'lon0': LON0, 'dlon': DLON}}
    json.dump(man, open(man_path, 'w'))
    print('wrote data/landmask.bin.gz (%d KB) + patched manifest' % (len(buf) // 1024))


if __name__ == '__main__':
    main()
