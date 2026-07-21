'use strict';

/**
 * geojson-s2 — Validate and repair GeoJSON geometry for Google S2 / ArangoDB.
 *
 * ArangoDB's geo engine is Google S2, and ArangoDB does NOT validate geometry on
 * insert. A malformed polygon stores happily and fails later, if at all:
 *
 *   • a self-intersecting ring produces "Invalid loop in polygon" as a WARNING at
 *     query time, returning null. There is no built-in validity function
 *     (arangodb/arangodb#9328 is still open).
 *
 *   • a clockwise EXTERIOR ring is not an error at all. From 3.10 onward the
 *     right-hand rule applies — the interior is the area to the LEFT of the ring
 *     path — and a ring may enclose the whole Earth. ArangoDB auto-inverts every
 *     ring EXCEPT the first, so a clockwise exterior ring is accepted, indexed as
 *     the complement of the intended region, and reported nowhere.
 *
 * So validation upstream is not a convenience; it is the only gate that exists.
 *
 * Zero dependencies, CommonJS, no Node built-ins: runs in Node, in ArangoDB Foxx,
 * and in the browser. Node ESM consumers can import the named exports directly.
 *
 * ── Scope ────────────────────────────────────────────────────────────────────
 * Geometry objects only (the seven RFC 7946 types). A caller holding Features
 * should pass each `.geometry`.
 *
 * Winding is computed with the planar shoelace formula on lon/lat, matching
 * shapely's `is_ccw` so that this library and the shapely-based Python module in
 * metadata-external-databases agree on the shared fixture corpus. See
 * lib/geometry2d.js for why, and what it costs.
 *
 * This library is an approximation of S2. The authoritative test is asking
 * ArangoDB itself to build the geometry — see `s2_check` in
 * metadata-external-databases/lib/geo_s2.py.
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *   const { validateGeometry, repairGeometry } = require('geojson-s2');
 *
 *   const { ok, issues } = validateGeometry(geom);
 *   if (!ok) for (const i of issues) console.error(i.severity, i.code, i.path, i.message);
 *
 *   const { geometry, changed } = repairGeometry(geom);
 */

const { SEVERITY, ISSUE } = require('./lib/issues');
const { checkGeometry, GEOMETRY_TYPES } = require('./lib/dispatch');
const { repairGeometry } = require('./lib/repair');

/**
 * Validate a GeoJSON geometry.
 *
 * @param {*}      geom - The geometry to validate.
 * @param {Object} [opts]
 * @param {boolean} [opts.warningsAsErrors=false] - Treat warnings as errors when
 *        deciding `ok`. Issues are reported either way; this only moves the bar
 *        for the boolean. The dictionary sets it (RFC conformance is the point);
 *        an ingestion pipeline that only cares what ArangoDB will accept can
 *        leave it off.
 * @returns {{ ok: boolean, issues: Array<{code, severity, path, message}> }}
 */
function validateGeometry(geom, opts) {
	const options = opts || {};
	const issues  = checkGeometry(geom, [], 0);
	const fatal   = options.warningsAsErrors
		? issues.length > 0
		: issues.some(i => i.severity === SEVERITY.ERROR);
	return { ok: !fatal, issues };
}

module.exports = {
	validateGeometry,
	repairGeometry,
	SEVERITY,
	ISSUE,
	GEOMETRY_TYPES,
};
