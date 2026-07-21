'use strict';

/**
 * dispatch.js — Per-type validation for the seven RFC 7946 geometry types.
 *
 * Feature and FeatureCollection are deliberately not handled: this library
 * validates geometry, which is what ArangoDB indexes and what the dictionary
 * stores. A caller holding Features should pass each `.geometry`.
 */

const { issue }  = require('./issues');
const { checkPosition, checkPositionArray, describe } = require('./position');
const { checkRingStructure, checkRingGeometry } = require('./ring');
const { checkPolygon } = require('./polygon');

const GEOMETRY_TYPES = [
	'Point', 'MultiPoint',
	'LineString', 'MultiLineString',
	'Polygon', 'MultiPolygon',
	'GeometryCollection',
];

/**
 * Validate a GeoJSON geometry object.
 *
 * @param {*}        geom  - Candidate geometry.
 * @param {string[]} path  - Location prefix for reported issues.
 * @param {number}   depth - Recursion guard for GeometryCollection nesting.
 * @returns {Object[]} issues
 */
function checkGeometry(geom, path, depth) {
	if (!geom || typeof geom !== 'object' || Array.isArray(geom)) {
		return [issue('NOT_AN_OBJECT', path,
			`expected a GeoJSON geometry object, got ${describe(geom)}`)];
	}

	const type = geom.type;
	if (typeof type !== 'string' || GEOMETRY_TYPES.indexOf(type) === -1) {
		return [issue('UNKNOWN_TYPE', [...path, 'type'],
			`"${type}" is not a GeoJSON geometry type; expected one of ${GEOMETRY_TYPES.join(', ')}`)];
	}

	if (type === 'GeometryCollection') return checkCollection(geom, path, depth);

	const coords = geom.coordinates;
	if (coords === undefined || coords === null) {
		return [issue('MISSING_COORDINATES', path, `${type} has no "coordinates"`)];
	}

	const cpath = [...path, 'coordinates'];

	switch (type) {
	case 'Point':
		return checkPosition(coords, cpath);

	case 'MultiPoint':
		return checkPositionArray(coords, cpath);

	case 'LineString':
		return checkLineString(coords, cpath);

	case 'MultiLineString':
		return eachOf(coords, cpath, 'line strings', checkLineString);

	case 'Polygon':
		return checkPolygon(coords, cpath);

	case 'MultiPolygon':
		return eachOf(coords, cpath, 'polygons', checkPolygon);
	}

	/* istanbul ignore next — GEOMETRY_TYPES is exhaustive above */
	return [];
}

/** LineString: an array of at least two positions. */
function checkLineString(coords, path) {
	const issues = checkPositionArray(coords, path);
	if (issues.length > 0) return issues;
	if (coords.length < 2) {
		issues.push(issue('LINESTRING_TOO_SHORT', path,
			`line string has ${coords.length} position(s); at least 2 are required`));
	}
	return issues;
}

/** Apply a per-element checker across an outer array. */
function eachOf(list, path, label, check) {
	if (!Array.isArray(list)) {
		return [issue('BAD_NESTING', path, `expected an array of ${label}, got ${describe(list)}`)];
	}
	if (list.length === 0) {
		return [issue('EMPTY_COORDINATES', path, `no ${label} present`)];
	}
	const issues = [];
	for (let i = 0; i < list.length; i++) {
		issues.push(...check(list[i], [...path, `[${i}]`]));
	}
	return issues;
}

/** GeometryCollection: a `geometries` array, each element a geometry. */
function checkCollection(geom, path, depth) {
	if (!Array.isArray(geom.geometries)) {
		return [issue('MISSING_GEOMETRIES', path,
			`GeometryCollection has no "geometries" array (got ${describe(geom.geometries)})`)];
	}
	// RFC 7946 §3.1.8 advises against nesting collections; cap the depth so a
	// cyclic or pathological document cannot spin here.
	if (depth > 4) {
		return [issue('BAD_NESTING', path,
			'GeometryCollection nesting is deeper than 4 levels')];
	}
	const issues = [];
	for (let i = 0; i < geom.geometries.length; i++) {
		issues.push(...checkGeometry(geom.geometries[i], [...path, 'geometries', `[${i}]`], depth + 1));
	}
	return issues;
}

module.exports = { checkGeometry, GEOMETRY_TYPES };
