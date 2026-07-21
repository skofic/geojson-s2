'use strict';

/**
 * position.js — RFC 7946 position checks.
 *
 * A position is an array of 2 or 3 numbers: [longitude, latitude] with an
 * optional altitude. Longitude comes FIRST — the most common mistake in
 * hand-written GeoJSON is [lat, lon], which this catches only when the values
 * happen to fall outside the valid ranges. Nothing can catch a swapped pair
 * where both values are small; that is why the range check matters.
 */

const { ISSUE, issue } = require('./issues');

/**
 * Validate one position.
 *
 * @param {*}        pos  - Candidate position.
 * @param {string[]} path - Location for the reported issue.
 * @returns {Object[]} issues
 */
function checkPosition(pos, path) {
	if (!Array.isArray(pos) || pos.length < 2 || pos.length > 3) {
		return [issue('BAD_POSITION', path, Array.isArray(pos)
			? `position has ${pos.length} element(s); expected 2 or 3 ([lon, lat] with optional altitude)`
			: `position must be an array of numbers, got ${describe(pos)}`)];
	}

	for (let i = 0; i < pos.length; i++) {
		if (typeof pos[i] !== 'number' || !Number.isFinite(pos[i])) {
			return [issue('BAD_POSITION', path,
				`position element ${i} is ${describe(pos[i])}; expected a finite number`)];
		}
	}

	const issues = [];
	const [lon, lat] = pos;
	if (lon < -180 || lon > 180) {
		issues.push(issue('LON_OUT_OF_RANGE', path,
			`longitude ${lon} is outside [-180, 180] — note that GeoJSON is [lon, lat], not [lat, lon]`));
	}
	if (lat < -90 || lat > 90) {
		issues.push(issue('LAT_OUT_OF_RANGE', path,
			`latitude ${lat} is outside [-90, 90] — note that GeoJSON is [lon, lat], not [lat, lon]`));
	}
	return issues;
}

/**
 * Validate an array of positions.
 *
 * @param {*}        list - Candidate array of positions.
 * @param {string[]} path - Location for reported issues.
 * @returns {Object[]} issues
 */
function checkPositionArray(list, path) {
	if (!Array.isArray(list)) {
		return [issue('BAD_NESTING', path,
			`expected an array of positions, got ${describe(list)}`)];
	}
	if (list.length === 0) {
		return [issue('EMPTY_COORDINATES', path, 'coordinate array is empty')];
	}
	const issues = [];
	for (let i = 0; i < list.length; i++) {
		issues.push(...checkPosition(list[i], [...path, `[${i}]`]));
	}
	return issues;
}

/** Short human description of an arbitrary value, for error messages. */
function describe(v) {
	if (v === null) return 'null';
	if (Array.isArray(v)) return 'an array';
	if (typeof v === 'string') return `a string ("${v}")`;
	if (typeof v === 'number') return `the number ${v}`;
	return `a ${typeof v}`;
}

module.exports = { checkPosition, checkPositionArray, describe };
