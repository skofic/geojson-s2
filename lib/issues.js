'use strict';

/**
 * issues.js — Issue codes, severities, and the issue constructor.
 *
 * Severity encodes what ArangoDB actually does with the fault, not how much we
 * dislike it:
 *
 *   error   — the geometry is rejected, silently mis-indexed, or fails at query
 *             time. Something is or will be wrong.
 *   warning — RFC 7946 says it is malformed, but ArangoDB tolerates or repairs
 *             it, so nothing breaks.
 *
 * Consumers choose their own strictness from this. The dictionary treats both as
 * errors (it is a metadata standard; conformance is the point), while an
 * ingestion pipeline can reasonably ignore warnings.
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
