'use strict';

/**
 * repair.js — The repairs that are provably safe.
 *
 * Safe means the fix is forced: there is exactly one thing the author could have
 * meant, so applying it cannot lose information.
 *
 *   • rewind a wrongly-wound ring      — the area is unambiguous, only the sign is wrong
 *   • close an open ring               — a linear ring is closed by definition
 *   • drop duplicate consecutive positions — a zero-length edge carries nothing
 *
 * Everything else is left alone and reported. A self-intersecting ring has no
 * single correct interpretation; resolving it is `make_valid`'s job, which is
 * genuine computational geometry and stays in shapely (see
 * metadata-external-databases/lib/geo_s2.py). Guessing here would silently
 * produce a different polygon from the one the author drew.
 *
 * Repair is idempotent: repairing an already-clean geometry returns it unchanged.
 */

const g2 = require('./geometry2d');
const { selfIntersects } = require('./ring');

/**
 * Repair a geometry where it is safe to do so.
 *
 * @param {*} geom - GeoJSON geometry.
 * @returns {{ geometry: *, changed: string[] }} the repaired geometry (a fresh
 *          object; the input is never mutated) and the list of repairs applied.
 */
function repairGeometry(geom) {
	const changed = [];
	if (!geom || typeof geom !== 'object' || Array.isArray(geom)) {
		return { geometry: geom, changed };
	}

	const out = Object.assign({}, geom);

	switch (geom.type) {
	case 'Polygon':
		out.coordinates = repairPolygon(geom.coordinates, changed);
		break;

	case 'MultiPolygon':
		if (Array.isArray(geom.coordinates)) {
			out.coordinates = geom.coordinates.map(p => repairPolygon(p, changed));
		}
		break;

	case 'GeometryCollection':
		if (Array.isArray(geom.geometries)) {
			out.geometries = geom.geometries.map(function(g) {
				const r = repairGeometry(g);
				changed.push(...r.changed);
				return r.geometry;
			});
		}
		break;

	default:
		// Points and line strings have no winding or closure to repair.
		break;
	}

	return { geometry: out, changed: dedupe(changed) };
}

/** Repair every ring of one polygon, applying the role-dependent winding rule. */
function repairPolygon(rings, changed) {
	if (!Array.isArray(rings)) return rings;

	return rings.map(function(ring, index) {
		// Repair must be total: callers hand it arbitrary, untrusted input, so
		// anything that is not a well-formed ring of positions is returned
		// untouched for the validator to report. Guessing at a malformed ring
		// would invent geometry the author never wrote.
		if (!isRingOfPositions(ring)) return ring;

		let out = dropRepeatedPositions(ring, changed);
		out = closeRing(out, changed);

		// Too short to have a meaningful winding — leave it for the validator to
		// report rather than inventing positions.
		if (out.length < 4) return out;

		// Winding is only a fact about rings that enclose an unambiguous area. A
		// ring with zero signed area (collinear, or a symmetric bowtie whose lobes
		// cancel) has no winding to correct: reversing it yields zero area again,
		// so a naive rewind flips it on every pass and never settles. A
		// self-intersecting ring has no single interior either. Both are left for
		// the validator to report and, if wanted, for shapely's make_valid.
		if (g2.isDegenerate(out) || selfIntersects(out)) return out;

		const ccw  = g2.isCounterClockwise(out);
		const want = index === 0; // exterior counter-clockwise, holes clockwise
		if (ccw !== want) {
			out = out.slice().reverse();
			changed.push(index === 0 ? 'EXTERIOR_NOT_CCW' : 'HOLE_NOT_CW');
		}
		return out;
	});
}

/** True when every element is a position: an array of at least 2 finite numbers. */
function isRingOfPositions(ring) {
	if (!Array.isArray(ring) || ring.length === 0) return false;
	return ring.every(function(p) {
		return Array.isArray(p) && p.length >= 2 &&
		       typeof p[0] === 'number' && Number.isFinite(p[0]) &&
		       typeof p[1] === 'number' && Number.isFinite(p[1]);
	});
}

/** Remove positions equal to their predecessor. */
function dropRepeatedPositions(ring, changed) {
	const out = [ring[0]];
	for (let i = 1; i < ring.length; i++) {
		const prev = out[out.length - 1];
		if (Array.isArray(ring[i]) && Array.isArray(prev) && g2.samePoint(ring[i], prev)) {
			changed.push('RING_DUPLICATE_POSITION');
			continue;
		}
		out.push(ring[i]);
	}
	return out;
}

/** Append the first position when the ring does not already end on it. */
function closeRing(ring, changed) {
	if (ring.length < 3) return ring;
	const first = ring[0];
	const last  = ring[ring.length - 1];
	if (Array.isArray(first) && Array.isArray(last) && !g2.samePoint(first, last)) {
		changed.push('RING_NOT_CLOSED');
		return ring.concat([first.slice()]);
	}
	return ring;
}

function dedupe(list) {
	return list.filter((v, i) => list.indexOf(v) === i);
}

module.exports = { repairGeometry };
