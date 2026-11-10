const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { createNoveltyChecker } = require('./checker.cjs');
const { createCodexProvider } = require('../generation/provider.cjs');

// This is an explicit live model evaluation, separate from deterministic unit tests.
async function main() {
  const root = path.resolve(__dirname, '../..');
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'samples/novelty/cases.json'), 'utf8'));
  const directory = path.join(root, 'runs', '_novelty', 'validation-' + randomUUID().slice(0, 12));
  const check = createNoveltyChecker({ provider: createCodexProvider(), log: console.log });
  const report = await check({ ...fixture, directory });
  const summary = { description: fixture.description, expected: fixture.expected,
    actual: { duplicatePlanIds: report.duplicatePlanIds, reviewPlanIds: report.reviewPlanIds },
    results: fixture.entries.map(entry => ({ planId: entry.plan.id,
      verdict: report.reviewPlanIds.includes(entry.plan.id) ? 'uncertain' : report.duplicatePlanIds.includes(entry.plan.id) ? 'duplicate' : 'distinct' })),
    reportPath: report.reportPath };
  fs.writeFileSync(path.join(directory, 'validation.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
  assert.deepEqual(summary.actual, fixture.expected, 'Live model classifications did not match the evaluation cases.');
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
