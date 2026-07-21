'use strict';

/**
 * ring.js — Linear-ring checks.
 *
 * A GeoJSON linear ring is a closed LineString with at least 4 positions, the
 * first equal to the last. S2 additionally needs the loop to be simple: no
 * repeated vertices, no zero-length or reversing edges, no self-intersection.
 * A ring that breaks the last of those produces `Invalid loop in polygon` at
 * query time — a warning, with null results, long after insertion.
 */

const { issue }        = require('./issues');
const { checkPositionArray } = require('./position');
const g2               = require('./geometry2d');

/**
 * Structural checks that must pass before any geometric predicate is meaningful.
 * Returns issues; when any are returned the ring is not safe to measure.
 *
 * @param {*}        ring - Candidate ring.
 * @param {string[]} path - Location for reported issues.
 * @returns {Object[]} issues
 */
function checkRingStructure(ring, path) {
	const issues = checkPositionArray(ring, path);
	if (issues.length > 0) return issues;

	if (ring.length < 4) {
		issues.push(issue('RING_TOO_SHORT', path,
			`ring has ${ring.length} position(s); a linear ring needs at least 4 (3 distinct plus the repeated closing position)`));
		return issues;
	}

	if (!g2.samePoint(ring[0], ring[ring.length - 1])) {
		issues.push(issue('RING_NOT_CLOSED', path,
			`ring is not closed: first position [${ring[0]}] differs from last [${ring[ring.length - 1]}]`));
	}

	for (let i = 0; i < ring.length - 1; i++) {
		if (g2.samePoint(ring[i], ring[i + 1])) {
			issues.push(issue('RING_DUPLICATE_POSITION', [...path, `[${i + 1}]`],
				`position [${ring[i + 1]}] repeats the previous one, producing a zero-length edge that S2 rejects`));
		}
	}

	return issues;
}

/**
 * Geometric checks. Assumes checkRingStructure() returned no issues.
 *
 * @param {number[][]} ring - Closed, well-formed ring.
 * @param {string[]}   path - Location for reported issues.
 * @returns {Object[]} issues
 */
function checkRingGeometry(ring, path) {
	const issues = [];

	issues.push(...checkSpikes(ring, path));

	// Self-intersection is tested BEFORE the zero-area check, and short-circuits
	// it. A symmetric bowtie encloses two lobes of opposite sign that cancel to
	// exactly zero, so testing area first would report a degenerate ring and hide
	// the real fault. Winding is meaningless on a self-intersecting ring too,
	// which is why the caller stops measuring once this fires.
	if (selfIntersects(ring)) {
		issues.push(issue('RING_SELF_INTERSECTS', path,
			'ring crosses itself; S2 rejects it as an invalid loop, and queries against it return null with an "Invalid loop in polygon" warning'));
		return issues;
	}

	if (g2.isDegenerate(ring)) {
		issues.push(issue('RING_DEGENERATE', path,
			'ring encloses zero area — all positions are collinear or coincident'));
	}

	return issues;
}

/**
 * Detect reversal spikes: a vertex where the path doubles straight back along
 * the edge it arrived on. Adjacent edges legitimately share a vertex, so the
 * pairwise scan below deliberately skips them — which means a spike would
 * otherwise slip through even though S2 rejects it.
 */
function checkSpikes(ring, path) {
	const issues = [];
	const n = ring.length - 1; // distinct positions; ring[n] === ring[0]
	for (let i = 0; i < n; i++) {
		const a = ring[(i - 1 + n) % n];
		const b = ring[i];
		const c = ring[(i + 1) % n];
		if (g2.orientation(a, b, c) !== 0) continue;
		// Collinear. A spike is a reversal: the outgoing edge points back along
		// the incoming one.
		const dx1 = b[0] - a[0], dy1 = b[1] - a[1];
		const dx2 = c[0] - b[0], dy2 = c[1] - b[1];
		if (dx1 * dx2 + dy1 * dy2 < 0) {
			issues.push(issue('RING_SPIKE', [...path, `[${i}]`],
				`position [${b}] doubles back along the previous edge, producing a degenerate spike`));
		}
	}
	return issues;
}

/**
 * True when any two non-adjacent edges of the ring meet.
 *
 * O(n²) over edge pairs. The rings in real use here run to a few hundred
 * vertices at most, so this is not worth the complexity of a sweep-line.
 */
function selfIntersects(ring) {
	const edges = ring.length - 1;
	for (let i = 0; i < edges; i++) {
		for (let j = i + 1; j < edges; j++) {
			// Adjacent edges share a vertex by construction; the first and last
			// edges are adjacent too, through the closing position.
			const adjacent = (j === i + 1) || (i === 0 && j === edges - 1);
			if (adjacent) continue;
			if (g2.segmentsIntersect(ring[i], ring[i + 1], ring[j], ring[j + 1])) return true;
		}
	}
	return false;
}

module.exports = { checkRingStructure, checkRingGeometry, selfIntersects };
