# geojson-s2 — maintainer notes

**Cross-repository facts** (which server runs what, behind what): [`../shared/deployments.md`](../shared/deployments.md). Read it before assuming anything about a server; do not copy its content here.

Validate and repair GeoJSON geometry for Google S2, the engine behind ArangoDB's geo index. Zero dependencies, CommonJS, no Node built-ins — runs in Node, in ArangoDB Foxx, and in the browser. `README.md` is the user-facing document (why it exists, severity model, usage); this file is about maintaining and releasing it.

## Provenance

Authored inside `metadata-store` (`packages/geojson-s2/`, 2026-07-21) and extracted into this repository on 2026-08-21 with `git subtree split`, so the two original commits are the first two commits here. Upstream is **this repository**; `metadata-store` no longer carries a copy.

## Layout

```
index.js            public API: validateGeometry(geom, {warningsAsErrors}), repairGeometry(geom), SEVERITY
lib/
  dispatch.js       per-geometry-type dispatch (the seven RFC 7946 types)
  position.js       position / coordinate-range checks
  ring.js           ring checks: closure, length, duplicates, spikes, degeneracy, winding, self-intersection
  polygon.js        polygon-level checks: hole containment, hole/exterior and hole/hole crossing vs touching
  geometry2d.js     planar predicates (segmentsProperlyCross, ringsCross, ringStrictlyOverlaps, shoelace area)
  repair.js         the forced repairs only: rewind, close, de-duplicate — idempotent, never mutates input
  issues.js         issue codes + severities (the single table; README's Severity section mirrors it)
fixtures/
  corpus.json       language-neutral verdict corpus: [{ label, geometry, expect: { ok, codes } }]  — SHIPS with the package
  mutate-base.json  two known-good polygons (snapshot of the metadata-store EXAMPLE_GEO-JSON_TEST descriptor)
test/
  run.js            corpus + repair-idempotency suite
  mutate.js         mutation testing: breaks the base polygons one fault at a time, asserts the code is named
```

## Severity is measured, not asserted

Every code's severity records what ArangoDB 3.12 actually *does* with that fault (README table): **error** = rejected or silently mis-indexed, **warning** = RFC-invalid but tolerated. When ArangoDB's behaviour changes, re-measure by feeding the fault to `GEO_POLYGON()` / `GEO_CONTAINS()` and update `lib/issues.js` + the README table together. The clockwise-exterior case is the reason the library exists: ArangoDB accepts it and indexes the complement, reporting nothing.

Two numerical details worth knowing before touching `ring.js`:

- **Translate before the shoelace sum.** Rings are shifted to their first vertex before summing; without that, small plots at large coordinates lose ~10 significant digits to cancellation and the *sign* of the area (the winding verdict) becomes unreliable.
- **Degenerate rings have no winding.** A zero-area ring is reported `RING_DEGENERATE` and is not rewound — otherwise repair flips it forever and idempotency breaks.

## Tests

```sh
node test/run.js                                  # 43 corpus + 43 repair-idempotency
node test/mutate.js                               # 20 mutants must be caught
node test/mutate.js --terms ../metadata-store/data/examples/terms.examples.json   # re-check against the live dictionary example
npm test                                          # both
```

Add a corpus entry for every new check (a passing and a failing geometry), and a mutation for every check that could silently stop firing.

## Consumers and release procedure

Distributed as a **GitHub-tagged npm dependency** — there is no registry publish. Consumers pin a tag:

| Consumer | Pin location |
|---|---|
| `metadata-store-validator` | `package.json` → `"geojson-s2": "github:skofic/geojson-s2#vX.Y.Z"` |
| `metadata-external-databases` | same |
| `geojson-s2-service` (Foxx) | same; installed with `npm install --omit=optional` and bundled in `node_modules/` |

Release:

1. Bump `version` in `package.json`; run `npm test`.
2. Commit, `git tag vX.Y.Z`, `git push && git push --tags`.
3. Bump the pin in each consumer and run its own tests (the dictionary validator's full-repository sweep is the heaviest and the most telling).

Semver intent: a new issue *code* or a severity change is **minor** (consumers that branch on codes must look); a change to the public API shape is **major**; fixes to existing checks are **patch**.

## What this library deliberately does not do

- `make_valid` for self-intersections / bow-ties — no single correct interpretation; real computational geometry stays in shapely (`metadata-external-databases/lib/geo_s2.py`).
- Spherical geometry — the planar shoelace is correct for the small survey polygons this was built for and wrong for hemispheres, poles, and antimeridian crossings (the last is reported as `ANTIMERIDIAN_SPAN`).
- Being S2. The authoritative test is asking ArangoDB to build the geometry (`s2_check` in the same Python module).
