# geojson-s2

Validate and repair GeoJSON geometry for Google S2 — the engine behind ArangoDB's geo index. Zero dependencies, CommonJS, no Node built-ins: runs in Node, in ArangoDB Foxx, and in the browser.

## Why this exists

**ArangoDB does not validate geometry on insert.** A malformed polygon stores happily and fails later, if at all. There is no built-in validity function either — the request for `GEO_IS_VALID_LOOP()` ([arangodb#9328](https://github.com/arangodb/arangodb/issues/9328)) is still open. Upstream validation is the only gate that exists.

Measured against ArangoDB 3.12 (`legacyPolygons: false`), by feeding each fault to `GEO_POLYGON()` and `GEO_CONTAINS()`:

| Geometry | ArangoDB's response |
|---|---|
| counter-clockwise square, point inside | `true` — correct |
| **clockwise square, same point inside** | **`false` — no error, wrong answer** |
| duplicate consecutive vertex | `true` — tolerated |
| self-crossing ring | error: `Invalid Loop in Polygon: Edge 0 crosses edge 2` |
| unclosed ring | error: `Loop not closed` |
| hole outside the shell | error: `Subsequent loop is not a hole in a polygon.` |
| holes that cross | error: `Invalid Polygon: Loop 1 edge 1 crosses loop 2 edge 0` |
| holes that merely touch | tolerated |

The second row is the reason this library exists. From 3.10 onward the right-hand rule applies — the interior is the area to the **left** of the ring's path — and a ring may enclose the entire Earth. ArangoDB auto-inverts every ring *except the first*, so a clockwise exterior ring is not an error at all: it is accepted, indexed as the complement of the intended region, and reported nowhere. Queries simply return the wrong answer, forever, in silence.

## Usage

```js
const { validateGeometry, repairGeometry } = require('geojson-s2');

const { ok, issues } = validateGeometry(geometry);
for (const i of issues) console.error(i.severity, i.code, i.path, i.message);

const { geometry: fixed, changed } = repairGeometry(geometry);
```

`validateGeometry(geom, { warningsAsErrors })` — issues are always reported; the flag only moves the bar for the `ok` boolean.

Geometry objects only (the seven RFC 7946 types). Callers holding Features should pass each `.geometry`.

## Severity

Severity encodes what ArangoDB *does*, not how much we dislike the fault:

- **error** — rejected, silently mis-indexed, or fails at query time.
- **warning** — RFC 7946 says malformed, ArangoDB tolerates or repairs it.

| error | warning |
|---|---|
| `NOT_AN_OBJECT`, `UNKNOWN_TYPE`, `MISSING_COORDINATES`, `MISSING_GEOMETRIES`, `BAD_NESTING`, `EMPTY_COORDINATES` | `RING_DUPLICATE_POSITION` |
| `BAD_POSITION`, `LON_OUT_OF_RANGE`, `LAT_OUT_OF_RANGE` | `HOLE_NOT_CW` |
| `LINESTRING_TOO_SHORT`, `RING_TOO_SHORT`, `RING_NOT_CLOSED`, `RING_SPIKE`, `RING_DEGENERATE`, `RING_SELF_INTERSECTS` | `HOLES_TOUCH` |
| `EXTERIOR_NOT_CCW`, `HOLE_NOT_INSIDE_EXTERIOR`, `HOLE_CROSSES_EXTERIOR`, `HOLES_OVERLAP` | `ANTIMERIDIAN_SPAN` |

An ingestion pipeline can reasonably ignore warnings. The dictionary that hosts this package does not: it defines a metadata standard, so it passes `warningsAsErrors`.

## Repair

Only fixes that are *forced* — where exactly one reading is possible, so nothing can be lost:

- rewind a wrongly-wound ring
- close an open ring
- drop duplicate consecutive positions

Idempotent, and never mutates its input. Self-intersection and hole containment are **not** repaired: they have no single correct interpretation. That is `make_valid`'s job, which is real computational geometry and stays in shapely — see `lib/geo_s2.py` in `metadata-external-databases`.

## Using this from another project

The package is deliberately self-contained: no dependencies, no Node built-ins, its own `package.json` and tests. Nothing about it is specific to the dictionary that currently hosts it.

It lives inside `metadata-store` only because that is where it was proven. It is shaped so that moving it out is a mechanical operation, not a rewrite.

### While it still lives here

**Same repository** — require it by path, as `validator/shapes/geojson.js` does:

```js
const { validateGeometry } = require('../../packages/geojson-s2');
```

**Another local checkout** — a `file:` dependency keeps one copy on disk, so edits are picked up immediately with no publish step:

```json
{ "dependencies": { "geojson-s2": "file:../metadata-store/packages/geojson-s2" } }
```

Good for developing against it. Not good for deployment, since the path must exist on the target machine.

**From an ESM project** (`"type": "module"`, as `metadata-external-databases` is) — named imports work directly, because `module.exports = { … }` is statically analysable:

```js
import { validateGeometry, repairGeometry } from 'geojson-s2';
```

**In a Foxx service** — bundle it into the service's `node_modules`. This is why the package is CommonJS with no Node built-ins: Foxx has neither ESM nor `fs`.

### Extracting it to its own repository

`npm install` **cannot** install a subdirectory of a git repository. So the moment a second project needs it as a real dependency rather than a path, the package has to become a repository root. `git subtree split` does that while keeping every commit that touched it:

```bash
# from the metadata-store checkout
git subtree split --prefix=packages/geojson-s2 -b geojson-s2-export

# create the new repository from that branch
mkdir ../geojson-s2 && cd ../geojson-s2
git init && git pull ../metadata-store geojson-s2-export
git remote add origin https://github.com/skofic/geojson-s2.git
git push -u origin main
```

Consumers then depend on it normally, pinned to a tag:

```json
{ "dependencies": { "geojson-s2": "github:skofic/geojson-s2#v1.0.0" } }
```

Nothing in the source changes. `validator/shapes/geojson.js` swaps its relative `require` for the package name, and `packages/geojson-s2/` is deleted from this repository.

Two things to carry across at that point:

- **`fixtures/corpus.json` goes with it.** It is listed in `package.json`'s `files`, so it ships to consumers rather than being a private test asset — that is what lets the Python module be held to the same expectations (see below).
- **Deciding where it lives is a one-way door for `main`.** Splitting late is fine; splitting and then continuing to edit the copy here is not. Do the split when the second consumer arrives, not before.

### Keeping the Python implementation honest

`metadata-external-databases/lib/geo_s2.py` validates the same geometry using shapely. Two implementations across two runtimes is unavoidable — the dictionary validator cannot have shapely, and the ingestion pipeline should not lose `make_valid`.

What stops them drifting into meaning different things is `fixtures/corpus.json`: a language-neutral list of `{ label, geometry, expect: { ok, codes } }`. The JS side runs it via `test/run.js`. The Python side should read the same file and assert the same verdicts, so a divergence fails a test rather than surfacing as two tools disagreeing about a customer's polygon.

Until the package is extracted, the Python repo has no clean path to that file — which is the practical reason to extract once it is genuinely needed on both sides.

## Known limits

- **Planar, not spherical.** Winding uses the shoelace formula on lon/lat, matching shapely's `is_ccw`. This is deliberate: the Python module in `metadata-external-databases` uses shapely, and matching its arithmetic is what lets the two agree on the shared corpus. It is wrong for polygons spanning more than half the globe, containing a pole, or crossing the antimeridian — the last of which is reported as `ANTIMERIDIAN_SPAN`.
- Coordinates are translated to the ring's first vertex before summing. Without that, a survey plot near (-5.31, 57.59) loses 10.4 of a double's ~15.9 digits to cancellation, and one order of magnitude smaller the *sign* becomes unreliable — which would mean reporting `EXTERIOR_NOT_CCW` on perfectly good geometry.
- Self-intersection is O(n²) over edge pairs. Fine at the scale of real data: 6,383 production polygons, the largest with 24 rings, validate in 2.5 s.
- **This is an approximation of S2.** The authoritative test is asking ArangoDB itself to build the geometry — see `s2_check` in `metadata-external-databases/lib/geo_s2.py`.

## Tests

```
node test/run.js       # the shared corpus, plus repair idempotency
node test/mutate.js    # mutation testing against real dictionary geometry
```

`fixtures/corpus.json` is deliberately language-neutral — `{ label, geometry, expect: { ok, codes } }` — so the shapely-based Python module can be held to the same expectations. Two implementations across two runtimes are unavoidable; a shared corpus is what stops them meaning different things.

`test/mutate.js` takes the two known-good polygons on `EXAMPLE_GEO-JSON_TEST` in the dictionary, breaks each in one specific way, and asserts the validator names that fault. A validator that never fires is indistinguishable from a broken one.
