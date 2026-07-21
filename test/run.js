'use strict';

/**
 * test/run.js — Runs the shared corpus. No framework, no dependencies.
 *
 * The corpus in fixtures/corpus.json is deliberately language-neutral so the
 * shapely-based Python module in metadata-external-databases can be held to the
 * same expectations. Two implementations are unavoidable across the two runtimes;
 * a shared corpus is what stops them meaning different things.
 *
 *   node packages/geojson-s2/test/run.js [--verbose]
 */

const fs   = require('fs');
const path = require('path');
const { validateGeometry, repairGeometry } = require('../index');

const verbose = process.argv.includes('--verbose');
const corpus  = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'corpus.json'), 'utf8'));

let passed = 0;
const failures = [];

for (const c of corpus) {
	const result = validateGeometry(c.geometry);
	const codes  = result.issues.map(i => i.code).sort();
	const want   = (c.expect.codes || []).slice().sort();

	const problems = [];
	if (result.ok !== c.expect.ok) {
		problems.push(`ok: expected ${c.expect.ok}, got ${result.ok}`);
	}
	// Compare as sets: a check firing twice for the same reason is not a failure.
	const got = [...new Set(codes)].sort();
	if (JSON.stringify(got) !== JSON.stringify([...new Set(want)].sort())) {
		problems.push(`codes: expected [${want}], got [${got}]`);
	}

	if (problems.length === 0) {
		passed++;
		if (verbose) console.log('  PASS ', c.label);
	} else {
		failures.push({ label: c.label, problems });
	}
}

// Repair must be idempotent, and must actually fix what it claims to fix.
let repairPassed = 0;
const repairFailures = [];
for (const c of corpus) {
	const first = repairGeometry(c.geometry);
	if (first.changed.length === 0) { repairPassed++; continue; }

	const second = repairGeometry(first.geometry);
	if (second.changed.length !== 0) {
		repairFailures.push(`${c.label}: repair is not idempotent, second pass changed ${second.changed}`);
		continue;
	}
	// Everything it claims to have repaired must no longer be reported.
	const after = validateGeometry(first.geometry).issues.map(i => i.code);
	const stillThere = first.changed.filter(code => after.includes(code));
	if (stillThere.length > 0) {
		repairFailures.push(`${c.label}: repaired ${stillThere} but they are still reported`);
		continue;
	}
	repairPassed++;
}

console.log('─'.repeat(60));
console.log(`corpus:  ${passed}/${corpus.length} passed`);
console.log(`repair:  ${repairPassed}/${corpus.length} passed`);

if (failures.length > 0) {
	console.log('\nFailed:');
	for (const f of failures) {
		console.log(`  ${f.label}`);
		for (const p of f.problems) console.log(`     ${p}`);
	}
}
if (repairFailures.length > 0) {
	console.log('\nRepair failures:');
	for (const f of repairFailures) console.log(`  ${f}`);
}

process.exit(failures.length + repairFailures.length === 0 ? 0 : 1);
