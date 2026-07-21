'use strict';

/**
 * test/mutate.js — Mutation testing: break known-good geometry on purpose.
 *
 * A validator that never fires is indistinguishable from one that is broken.
 * The corpus proves the checks accept what they should; this proves they REJECT
 * what they should, using real geometry rather than hand-drawn squares.
 *
 * Source geometry is read live from the dictionary — the two polygons on
 * `EXAMPLE_GEO-JSON_TEST._prop['EXAMPLE_GEO-JSON']`, a 14-vertex survey shape in
 * Scotland and its bounding rectangle. Both are genuinely clean: counter-
 * clockwise, closed, no repeated vertices. Every mutation below takes one of
 * them and introduces exactly one fault, then asserts the validator names it.
 *
 *
 *   node packages/geojson-s2/test/mutate.js [--verbose]
 */

const fs   = require('fs');
const path = require('path');
const { validateGeometry, repairGeometry } = require('../index');

const verbose  = process.argv.includes('--verbose');
const TERMS    = path.resolve(__dirname, '../../../data/examples/terms.examples.json');

// ── Source geometry ──────────────────────────────────────────────────────────

function loadExampleGeometries() {
	const terms = JSON.parse(fs.readFileSync(TERMS, 'utf8'));
	const term  = terms.find(t => t._code._gid === 'EXAMPLE_GEO-JSON_TEST');
	if (!term) throw new Error('EXAMPLE_GEO-JSON_TEST not found in ' + TERMS);
	const polys = (term._prop || {})['EXAMPLE_GEO-JSON'];
	if (!Array.isArray(polys)) throw new Error('EXAMPLE_GEO-JSON_TEST has no polygons');
	return polys.map((g, i) => ({ label: `EXAMPLE_GEO-JSON_TEST[${i}] (${g.coordinates[0].length} positions)`, geometry: g }));
}

const clone = g => JSON.parse(JSON.stringify(g));

// ── Mutations ────────────────────────────────────────────────────────────────
// Each returns a mutated geometry, or null when it does not apply to this shape.

const MUTATIONS = [
	{
		name:   'reverse exterior ring (clockwise)',
		expect: 'EXTERIOR_NOT_CCW',
		apply(g) {
			const m = clone(g);
			m.coordinates[0].reverse();
			return m;
		},
	},
	{
		name:   'drop the closing position',
		expect: 'RING_NOT_CLOSED',
		apply(g) {
			const m = clone(g);
			m.coordinates[0].pop();
			return m;
		},
	},
	{
		name:   'repeat a vertex',
		expect: 'RING_DUPLICATE_POSITION',
		fatal:  false,   // ArangoDB de-duplicates; RFC-invalid but harmless
		apply(g) {
			const m = clone(g);
			const r = m.coordinates[0];
			r.splice(2, 0, clone(r[1]));
			return m;
		},
	},
	{
		// Swapping two ADJACENT vertices reliably crosses the two edges that meet
		// at them. Swapping opposite vertices does not: in a quadrilateral it
		// simply reverses the ring, which is a winding fault rather than a
		// crossing — the first version of this mutation did that and was caught
		// out by the 5-position rectangle below.
		name:   'swap two adjacent vertices (crossing)',
		expect: 'RING_SELF_INTERSECTS',
		apply(g) {
			const m = clone(g);
			const r = m.coordinates[0];
			const n = r.length - 1;              // distinct positions
			if (n < 4) return null;
			const t = r[1]; r[1] = r[2]; r[2] = t;
			return m;
		},
	},
	{
		name:   'truncate ring to three positions',
		expect: 'RING_TOO_SHORT',
		apply(g) {
			const m = clone(g);
			const r = m.coordinates[0];
			m.coordinates[0] = [r[0], r[1], r[0]];
			return m;
		},
	},
	{
		name:   'push a longitude out of range',
		expect: 'LON_OUT_OF_RANGE',
		apply(g) {
			const m = clone(g);
			m.coordinates[0][1][0] = 251.7;
			return m;
		},
	},
	{
		name:   'swap lon/lat on one vertex',
		expect: 'LAT_OUT_OF_RANGE',
		apply(g) {
			const m = clone(g);
			const p = m.coordinates[0][1];
			m.coordinates[0][1] = [p[1], p[0] - 180];  // force latitude out of range
			return m;
		},
	},
	{
		name:   'replace a position with a string',
		expect: 'BAD_POSITION',
		apply(g) {
			const m = clone(g);
			m.coordinates[0][1] = 'banana';
			return m;
		},
	},
	{
		name:   'collapse the ring onto a line',
		expect: 'RING_DEGENERATE',
		apply(g) {
			const m = clone(g);
			const [x, y] = m.coordinates[0][0];
			m.coordinates[0] = [[x, y], [x + 1, y + 1], [x + 2, y + 2], [x, y]];
			return m;
		},
	},
	{
		name:   'add a hole that sits outside the shell',
		expect: 'HOLE_NOT_INSIDE_EXTERIOR',
		apply(g) {
			const m = clone(g);
			const [x, y] = m.coordinates[0][0];
			// A small clockwise square 10° away — unambiguously outside.
			m.coordinates.push([[x + 10, y + 10], [x + 10, y + 11], [x + 11, y + 11], [x + 11, y + 10], [x + 10, y + 10]]);
			return m;
		},
	},
];

// ── Run ──────────────────────────────────────────────────────────────────────

const sources = loadExampleGeometries();

// Sanity gate: the sources must be clean, or every result below is meaningless.
let baselineOk = true;
console.log('Baseline — the geometry being mutated must be valid:');
for (const s of sources) {
	const r = validateGeometry(s.geometry);
	console.log(`  ${r.ok ? 'clean  ' : 'DIRTY  '} ${s.label}${r.ok ? '' : ' — ' + r.issues.map(i => i.code).join(',')}`);
	if (!r.ok) baselineOk = false;
}
if (!baselineOk) {
	console.error('\nSource geometry is not clean; mutation results would be meaningless.');
	process.exit(1);
}

console.log('\nMutants — each must be caught, naming the expected fault:');
let caught = 0, total = 0;
const failures = [];

for (const s of sources) {
	for (const mut of MUTATIONS) {
		const mutant = mut.apply(s.geometry);
		if (mutant === null) continue;
		total++;

		const r     = validateGeometry(mutant);
		const codes = r.issues.map(i => i.code);
		const hit   = codes.includes(mut.expect);
		// "Caught" means the expected fault was named. Whether it is fatal is a
		// separate question, decided by severity: ArangoDB tolerates some faults
		// (a duplicate vertex) while silently mis-indexing others, so a mutation
		// declares which it expects.
		const fatalOk = mut.fatal === false ? r.ok : !r.ok;

		if (hit && fatalOk) {
			caught++;
			if (verbose) console.log(`  caught  ${mut.name.padEnd(40)} ${s.label}`);
		} else {
			failures.push({
				source: s.label,
				name:   mut.name,
				expect: mut.expect,
				got:    codes.length ? codes.join(',') : '(nothing — ACCEPTED)',
				ok:     r.ok,
			});
		}
	}
}

if (!verbose) {
	// Summarise by mutation so the output stays readable.
	for (const mut of MUTATIONS) {
		const failed = failures.filter(f => f.name === mut.name).length;
		const ran    = sources.filter(s => mut.apply(s.geometry) !== null).length;
		if (ran === 0) continue;
		console.log(`  ${failed === 0 ? 'caught ' : 'MISSED '} ${mut.name.padEnd(42)} ${ran - failed}/${ran}  → ${mut.expect}`);
	}
}

console.log('\n' + '─'.repeat(60));
console.log(`mutants caught: ${caught}/${total}`);

if (failures.length > 0) {
	console.log('\nEscaped:');
	for (const f of failures) {
		console.log(`  ${f.source} — ${f.name}`);
		console.log(`     expected ${f.expect}, got ${f.got} (ok=${f.ok})`);
	}
}

process.exit(failures.length === 0 ? 0 : 1);
