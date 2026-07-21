'use strict';

/**
 * geometry2d.js — Planar predicates on [lon, lat] pairs.
 *
 * ── Why planar, on a sphere ───────────────────────────────────────────────────
 * Orientation is computed with the planar shoelace formula on lon/lat, which is
 * exactly what shapely's `is_ccw` does. That is a deliberate choice: the
 * Python module in metadata-external-databases uses shapely, and matching its
 * arithmetic is what lets the two implementations agree on a shared corpus. An
 * independently "more correct" spherical formula here would produce a library
 * that disagrees with the one already in production use.
 *
 * The approximation is wrong for polygons that span more than half the globe,
 * contain a pole, or cross the antimeridian. Real data does none of these — and
 * the antimeridian case is reported separately as its own warning, so the one
 * realistic failure mode is visible rather than silent.
 */

/**
 * Twice the signed area of a ring (the shoelace sum).
 *
 * Positive → counter-clockwise, negative → clockwise, ~zero → degenerate.
 * Left undoubled-and-unhalved on purpose: only the sign and the relative
 * magnitude are ever used.
 *
 * ── Why the coordinates are translated first ─────────────────────────────────
 * Real polygons here are small features at large coordinates: a survey plot near
 * (-5.31, 57.59) spans ~1e-4 degrees. Summing raw `x1*y2 - x2*y1` multiplies
 * numbers of magnitude ~3e2 and cancels them down to ~1e-8 — measured at 10.4
 * decimal digits of cancellation against the ~15.9 a double carries, leaving
 * about five significant digits. One order of magnitude smaller and the SIGN
 * itself becomes unreliable, which would mean reporting EXTERIOR_NOT_CCW on
 * perfectly good geometry.
 *
 * Shifting every vertex by the first one is exactly area-preserving in real
 * arithmetic and removes the cancellation in floating point: the same collinear
 * ring that summed to -5.7e-14 raw sums to exactly 0 translated.
 *
 * @param {number[][]} ring - Closed ring of [lon, lat] positions.
 * @returns {number}
 */
function shoelace(ring) {
	const ox = ring[0][0];
	const oy = ring[0][1];
	let sum = 0;
	for (let i = 0; i < ring.length - 1; i++) {
		const x1 = ring[i][0]     - ox, y1 = ring[i][1]     - oy;
		const x2 = ring[i + 1][0] - ox, y2 = ring[i + 1][1] - oy;
		sum += x1 * y2 - x2 * y1;
	}
	return sum;
}

/**
 * True when the ring encloses no meaningful area — all vertices collinear or
 * coincident.
 *
 * Tested relative to the ring's own bounding box rather than against zero.
 * Real polygons are legitimately tiny (a plot encloses ~1e-8 square degrees), so
 * an absolute threshold would either miss degenerate rings or condemn valid
 * ones. The ratio separates them by orders of magnitude: a degenerate ring sits
 * at the arithmetic noise floor (~1e-24 after translation) while the thinnest
 * plausible sliver is nearer 1e-6 of its bounding box.
 */
function isDegenerate(ring) {
	const b     = bbox(ring);
	const scale = (b.maxX - b.minX) * (b.maxY - b.minY);
	if (scale === 0) return true; // collinear on an axis, or every vertex identical
	return Math.abs(shoelace(ring)) <= 1e-9 * scale;
}

/** True when the ring winds counter-clockwise. Meaningless if isDegenerate(). */
function isCounterClockwise(ring) {
	return shoelace(ring) > 0;
}

/**
 * Orientation of the triplet a → b → c.
 * @returns {number} +1 counter-clockwise, -1 clockwise, 0 collinear.
 */
function orientation(a, b, c) {
	const v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
	return v > 0 ? 1 : (v < 0 ? -1 : 0);
}

/** True when p, known to be collinear with segment ab, lies within its bounding box. */
function withinSegment(a, b, p) {
	return p[0] >= Math.min(a[0], b[0]) && p[0] <= Math.max(a[0], b[0]) &&
	       p[1] >= Math.min(a[1], b[1]) && p[1] <= Math.max(a[1], b[1]);
}

/** True when p and q are the same position (2D). */
function samePoint(p, q) {
	return p[0] === q[0] && p[1] === q[1];
}

/**
 * True when segments p1p2 and p3p4 intersect, touching included.
 *
 * Handles the collinear-overlap cases explicitly; a shared endpoint counts as an
 * intersection, so callers that expect to share one (adjacent ring edges) must
 * exclude those pairs themselves.
 */
function segmentsIntersect(p1, p2, p3, p4) {
	const d1 = orientation(p3, p4, p1);
	const d2 = orientation(p3, p4, p2);
	const d3 = orientation(p1, p2, p3);
	const d4 = orientation(p1, p2, p4);

	// Proper crossing: each segment straddles the other's line.
	if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
	    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;

	// Touching or collinear overlap.
	if (d1 === 0 && withinSegment(p3, p4, p1)) return true;
	if (d2 === 0 && withinSegment(p3, p4, p2)) return true;
	if (d3 === 0 && withinSegment(p1, p2, p3)) return true;
	if (d4 === 0 && withinSegment(p1, p2, p4)) return true;

	return false;
}

/**
 * True when position p lies inside the ring, by ray casting.
 *
 * Points exactly on the boundary are not reliably classified — that is inherent
 * to ray casting and acceptable here, because every caller pairs this with an
 * edge-intersection test that catches boundary contact on its own.
 */
function pointInRing(p, ring) {
	let inside = false;
	const [px, py] = p;
	for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
		const [xi, yi] = ring[i];
		const [xj, yj] = ring[j];
		if ((yi > py) !== (yj > py) &&
		    px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
			inside = !inside;
		}
	}
	return inside;
}

/**
 * True when segments p1p2 and p3p4 cross PROPERLY — each strictly straddles the
 * other's line. A shared endpoint or a collinear overlap is contact, not a
 * crossing, and returns false.
 *
 * The distinction is not pedantic: ArangoDB rejects rings that cross
 * ("Invalid Polygon: Loop 1 edge 1 crosses loop 2 edge 0") but accepts rings
 * that merely touch at a vertex, and real survey data contains the latter.
 */
function segmentsProperlyCross(p1, p2, p3, p4) {
	const d1 = orientation(p3, p4, p1);
	const d2 = orientation(p3, p4, p2);
	const d3 = orientation(p1, p2, p3);
	const d4 = orientation(p1, p2, p4);
	return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
	       ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

/** True when p lies exactly on one of the ring's edges. */
function pointOnRing(p, ring) {
	for (let i = 0; i < ring.length - 1; i++) {
		if (orientation(ring[i], ring[i + 1], p) === 0 &&
		    withinSegment(ring[i], ring[i + 1], p)) return true;
	}
	return false;
}

/**
 * True when some vertex of A lies strictly inside B — inside and not on B's
 * boundary. Vertices sitting on the boundary are skipped because ray casting
 * cannot classify them reliably, and because two rings that merely touch share
 * exactly such vertices.
 */
function ringStrictlyOverlaps(a, b) {
	for (let i = 0; i < a.length - 1; i++) {
		if (pointOnRing(a[i], b)) continue;
		return pointInRing(a[i], b);
	}
	return false; // every vertex lies on B's boundary — coincident rings
}

/** True when rings A and B properly cross (as opposed to merely touching). */
function ringsCross(a, b) {
	const ba = bbox(a);
	const bb = bbox(b);
	if (ba.maxX < bb.minX || bb.maxX < ba.minX ||
	    ba.maxY < bb.minY || bb.maxY < ba.minY) return false;

	for (let i = 0; i < a.length - 1; i++) {
		for (let j = 0; j < b.length - 1; j++) {
			if (segmentsProperlyCross(a[i], a[i + 1], b[j], b[j + 1])) return true;
		}
	}
	return false;
}

/**
 * True when any edge of ring A meets any edge of ring B, touching included.
 *
 * O(n·m). Real polygons here top out around a few hundred vertices, so this
 * stays comfortably fast; the bounding-box reject below removes the common case
 * of rings that are nowhere near each other.
 */
function ringsIntersect(a, b) {
	const ba = bbox(a);
	const bb = bbox(b);
	if (ba.maxX < bb.minX || bb.maxX < ba.minX ||
	    ba.maxY < bb.minY || bb.maxY < ba.minY) return false;

	for (let i = 0; i < a.length - 1; i++) {
		for (let j = 0; j < b.length - 1; j++) {
			if (segmentsIntersect(a[i], a[i + 1], b[j], b[j + 1])) return true;
		}
	}
	return false;
}

/** Bounding box of a ring. */
function bbox(ring) {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const [x, y] of ring) {
		if (x < minX) minX = x;
		if (x > maxX) maxX = x;
		if (y < minY) minY = y;
		if (y > maxY) maxY = y;
	}
	return { minX, minY, maxX, maxY };
}

module.exports = {
	shoelace,
	isCounterClockwise,
	isDegenerate,
	orientation,
	segmentsIntersect,
	pointInRing,
	ringsIntersect,
	ringsCross,
	ringStrictlyOverlaps,
	pointOnRing,
	segmentsProperlyCross,
	samePoint,
	bbox,
};
