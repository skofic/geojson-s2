'use strict';

/**
 * issues.js — Issue codes, severities, and the issue constructor.
 *
 * ── What severity means here ─────────────────────────────────────────────────
 * Severity is not "how much we dislike the fault". It answers one question:
 *
 *     after this geometry reaches ArangoDB, is its meaning still what the
 *     author wrote?
 *
 * That is deliberately NOT the same as "does ArangoDB reject it", because the
 * most dangerous faults are the ones it accepts. Each severity below was checked
 * against ArangoDB 3.12 (`legacyPolygons: false`) by feeding the fault to
 * GEO_POLYGON() and GEO_CONTAINS() — see README.md for the full table.
 *
 *   error   — two distinct cases, both of which leave something wrong:
 *
 *             (a) ArangoDB rejects the geometry outright: self-intersection,
 *                 unclosed ring, hole outside the shell, crossing holes, a
 *                 reversal spike.
 *
 *             (b) ArangoDB ACCEPTS it, but the stored meaning is not the
 *                 author's. A clockwise exterior ring indexes the complement of
 *                 the intended region — a point plainly inside the polygon
 *                 tests false, with no error anywhere. A degenerate ring indexes
 *                 an empty region that can never match any query.
 *
 *             Case (b) is the reason this library exists; nothing else in the
 *             stack reports it.
 *
 *   warning — ArangoDB accepts it AND the meaning survives intact. A duplicate
 *             consecutive vertex is de-duplicated when the S2 loop is built
 *             (GEO_EQUALS reports the polygon equal to its clean form). A
 *             counter-clockwise hole is inverted to the correct winding. Holes
 *             that touch without crossing are fine. RFC 7946 calls these
 *             malformed; nothing downstream misbehaves.
 *
 * ── Choosing a strictness ────────────────────────────────────────────────────
 * Consumers pick via `validateGeometry(geom, { warningsAsErrors })`.
 *
 * The dictionary that hosts this package sets it. Its job is to define what
 * correct data IS, not what one database version happens to survive — and the
 * warning cases are not cosmetic: a de-duplicated vertex means the document on
 * disk carries geometry the index does not have. An ingestion pipeline handling
 * third-party data it does not own should leave it off and repair instead.
 *
 * Rule of thumb: strict where you AUTHOR, lenient where you RECEIVE.
 */

const SEVERITY = { ERROR: 'error', WARNING: 'warning' };

/**
 * Every issue this library can report, with the severity it carries by default.
 * The key IS the code — kept as an object rather than bare strings so a typo in
 * a consumer is a TypeError rather than a silently never-matching comparison.
 */
const ISSUE = {
	// Envelope
	NOT_AN_OBJECT:            SEVERITY.ERROR,
	UNKNOWN_TYPE:             SEVERITY.ERROR,
	MISSING_COORDINATES:      SEVERITY.ERROR,
	MISSING_GEOMETRIES:       SEVERITY.ERROR,
	BAD_NESTING:              SEVERITY.ERROR,
	EMPTY_COORDINATES:        SEVERITY.ERROR,

	// Positions
	BAD_POSITION:             SEVERITY.ERROR,
	LON_OUT_OF_RANGE:         SEVERITY.ERROR,
	LAT_OUT_OF_RANGE:         SEVERITY.ERROR,

	// Lines and rings
	LINESTRING_TOO_SHORT:     SEVERITY.ERROR,
	RING_TOO_SHORT:           SEVERITY.ERROR,
	RING_NOT_CLOSED:          SEVERITY.ERROR,
	RING_DUPLICATE_POSITION:  SEVERITY.WARNING,  // ArangoDB de-duplicates; RFC-invalid but harmless
	RING_SPIKE:               SEVERITY.ERROR,
	RING_DEGENERATE:          SEVERITY.ERROR,
	RING_SELF_INTERSECTS:     SEVERITY.ERROR,

	// Polygon ring roles
	//
	// EXTERIOR_NOT_CCW is the one that matters most and the reason this library
	// exists. ArangoDB auto-inverts every ring EXCEPT the first, so a clockwise
	// exterior ring is not an error to S2 at all — since 3.10 a ring may enclose
	// the whole Earth, so it is accepted and indexed as the complement of the
	// intended area. Nothing anywhere reports it.
	EXTERIOR_NOT_CCW:         SEVERITY.ERROR,
	HOLE_NOT_CW:              SEVERITY.WARNING,   // ArangoDB inverts it for us
	HOLE_NOT_INSIDE_EXTERIOR: SEVERITY.ERROR,
	HOLE_CROSSES_EXTERIOR:    SEVERITY.ERROR,
	HOLES_OVERLAP:            SEVERITY.ERROR,
	HOLES_TOUCH:              SEVERITY.WARNING,   // contact without crossing; ArangoDB accepts it

	// Spherical caveats
	ANTIMERIDIAN_SPAN:        SEVERITY.WARNING,
};

/**
 * Build an issue record.
 *
 * @param {string}   code    - One of the ISSUE keys.
 * @param {string[]} path    - Location within the geometry, e.g. ['coordinates', '[0]', '[3]'].
 * @param {string}   message - Human-readable explanation.
 * @returns {{ code, severity, path, message }}
 */
function issue(code, path, message) {
	const severity = ISSUE[code];
	if (severity === undefined) throw new TypeError('Unknown issue code: ' + code);
	return {
		code,
		severity,
		path: Array.isArray(path) ? path.join('.') : (path || ''),
		message,
	};
}

module.exports = { SEVERITY, ISSUE, issue };
