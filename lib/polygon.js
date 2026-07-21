'use strict';

/**
 * polygon.js — Polygon-level checks: ring roles, winding, hole containment.
 *
 * The first ring is the exterior; the rest are holes. Under the right-hand rule
 * the interior is the area to the LEFT of the ring's path, so the exterior must
 * wind counter-clockwise and holes clockwise.
 *
 * ArangoDB auto-inverts every ring except the first. That asymmetry is the whole
 * reason this file distinguishes the two cases: a clockwise hole is harmless
 * noise, while a clockwise exterior ring is accepted in silence and indexed as
 * the complement of the intended area.
 */

const { issue } = require('./issues');
const { checkRingStructure, checkRingGeometry } = require('./ring');
const g2        = require('./geometry2d');
const { describe } = require('./position');

/**
 * Validate one polygon's ring array.
 *
 * @param {*}        rings - Candidate array of linear rings.
 * @param {string[]} path  - Location for reported issues.
 * @returns {Object[]} issues
 */
function checkPolygon(rings, path) {
	if (!Array.isArray(rings)) {
		return [issue('BAD_NESTING', path,
			`polygon coordinates must be an array of linear rings, got ${describe(rings)}`)];
	}
	if (rings.length === 0) {
		return [issue('EMPTY_COORDINATES', path, 'polygon has no rings')];
	}

	const issues = [];

	// Structure first, then geometry. Winding and containment are only measured on
	// rings that passed BOTH: the winding of a self-intersecting or zero-area ring
	// is not a fact about the author's intent, and reporting it would bury the real
	// fault under a spurious second one.
	const sound = [];
	for (let i = 0; i < rings.length; i++) {
		const ringPath   = [...path, `[${i}]`];
		const structural = checkRingStructure(rings[i], ringPath);
		issues.push(...structural);
		if (structural.length > 0) continue;

		const geometric = checkRingGeometry(rings[i], ringPath);
		issues.push(...geometric);
		if (geometric.length === 0) sound.push({ index: i, ring: rings[i], path: ringPath });
	}

	// Winding. Reported per ring so the message can say which role it plays.
	for (const { index, ring, path: ringPath } of sound) {
		const ccw = g2.isCounterClockwise(ring);
		if (index === 0 && !ccw) {
			issues.push(issue('EXTERIOR_NOT_CCW', ringPath,
				'exterior ring winds clockwise; S2 reads the area to the left of the path as the interior, ' +
				'so this is indexed as the whole Earth EXCEPT the intended region. ArangoDB does not correct ' +
				'the first ring and reports nothing.'));
		} else if (index > 0 && ccw) {
			issues.push(issue('HOLE_NOT_CW', ringPath,
				'hole ring winds counter-clockwise; RFC 7946 requires holes to wind clockwise. ' +
				'ArangoDB inverts subsequent rings automatically, so this does not break anything.'));
		}
	}

	// Containment, on structurally sound rings only.
	const exterior = sound.find(r => r.index === 0);
	const holes    = sound.filter(r => r.index > 0);

	// Crossing and touching are different faults, calibrated against what
	// ArangoDB actually does: it rejects rings that properly cross ("Invalid
	// Polygon: Loop 1 edge 1 crosses loop 2 edge 0") but accepts rings that share
	// a vertex. Real survey polygons contain the latter — of 6,383 production
	// shapes, one has two holes meeting at two shared vertices, and ArangoDB
	// builds it without complaint.
	if (exterior) {
		for (const hole of holes) {
			if (g2.ringsCross(exterior.ring, hole.ring)) {
				issues.push(issue('HOLE_CROSSES_EXTERIOR', hole.path,
					'hole ring crosses the exterior ring; S2 rejects it with ' +
					'"Subsequent loop is not a hole in a polygon"'));
			} else if (!g2.ringStrictlyOverlaps(hole.ring, exterior.ring)) {
				issues.push(issue('HOLE_NOT_INSIDE_EXTERIOR', hole.path,
					'hole ring lies outside the exterior ring; S2 rejects it with ' +
					'"Subsequent loop is not a hole in a polygon"'));
			}
		}
	}

	for (let i = 0; i < holes.length; i++) {
		for (let j = i + 1; j < holes.length; j++) {
			const a = holes[i], b = holes[j];
			if (g2.ringsCross(a.ring, b.ring) ||
			    g2.ringStrictlyOverlaps(a.ring, b.ring) ||
			    g2.ringStrictlyOverlaps(b.ring, a.ring)) {
				issues.push(issue('HOLES_OVERLAP', b.path,
					`hole rings [${a.index}] and [${b.index}] overlap; holes must be disjoint`));
			} else if (g2.ringsIntersect(a.ring, b.ring)) {
				issues.push(issue('HOLES_TOUCH', b.path,
					`hole rings [${a.index}] and [${b.index}] touch without crossing; RFC 7946 discourages this, ` +
					'but ArangoDB accepts it'));
			}
		}
	}

	// Antimeridian. A polygon spanning more than half the globe in longitude is
	// almost always one that crosses ±180 and was not split as RFC 7946 §3.1.9
	// requires. It also invalidates the planar winding test above, so it is
	// reported even though nothing downstream rejects it outright.
	if (exterior) {
		const { minX, maxX } = g2.bbox(exterior.ring);
		if (maxX - minX > 180) {
			issues.push(issue('ANTIMERIDIAN_SPAN', exterior.path,
				`exterior ring spans ${(maxX - minX).toFixed(1)}° of longitude, which usually means it crosses ` +
				'the antimeridian without being split. Winding is computed on a plane and is unreliable here.'));
		}
	}

	return issues;
}

module.exports = { checkPolygon };
