#!/usr/bin/env node
/**
 * DFinance regression test harness — plain Node scripts, no test framework.
 *
 * These exercise the REAL index.html (not copy-pasted formulas), by loading
 * it into a jsdom window and driving it the way a person would: clicking
 * buttons, typing into inputs, reading back localStorage. That means there
 * is nothing here to keep "in sync" with the app — if index.html changes,
 * these tests are already testing the new code.
 *
 * Covers the specific regressions this project has actually hit:
 *   - the v1.1 bug where any keystroke in a reorderable table lost focus
 *   - PMT/FV edge cases (rate = 0, years = 0) not leaking NaN/Infinity
 *   - the v1.2 schema validator rejecting/sanitizing malformed & malicious
 *     JSON backups (prototype-pollution attempt, unknown fields, wrong types)
 *   - a full Excel (.xlsx) import round-trip using the real SheetJS package
 *     (not a mock), so a change to the SheetJS API surface would be caught
 *
 * Requires: npm install (installs jsdom + xlsx, see package.json next to
 * this file). Run with: npm test  (or: node tests/dfinance.test.js)
 *
 * The Excel test installs the real `xlsx` npm package as window.XLSX before
 * triggering an import, so loadXLSX()'s existing "already loaded" check
 * (`if (window.XLSX) return Promise.resolve(window.XLSX)`) short-circuits
 * the jsDelivr fetch — these tests run fully offline and deterministically,
 * they are not a test of the CDN/SRI wiring itself (that's a manual/CI-with-
 * network concern, not something worth making every test run depend on).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM } = require('jsdom');

const INDEX_HTML = path.join(__dirname, '..', 'index.html');

let pass = 0, fail = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    fail++;
    failures.push({ name, err });
    console.log(`  \u2717 ${name}`);
    console.log(`      ${err.message}`);
  }
}

function loadApp() {
  const html = fs.readFileSync(INDEX_HTML, 'utf8');
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://example.com/' });
  const errors = [];
  dom.window.onerror = (msg, src, line, col, err) => errors.push(err || new Error(String(msg)));
  return { dom, win: dom.window, errors };
}

const wait = ms => new Promise(r => setTimeout(r, ms));

// Waits for the app's own debounced save (600ms) to have definitely fired,
// so a localStorage read afterwards reflects the latest state.
const waitForSave = () => wait(700);

async function ready(win) {
  await wait(500);
  return win.document;
}

function fireInput(win, el, value) {
  el.value = value;
  el.dispatchEvent(new win.Event('input', { bubbles: true }));
}

function fakeJsonFile(name, obj) {
  return { name, type: 'application/json', text: async () => JSON.stringify(obj) };
}

// ---------------------------------------------------------------------
// 1. Focus retention across every reorderable table (the v1.1 regression)
// ---------------------------------------------------------------------
async function testFocusRetention() {
  const { dom, win, errors } = loadApp();
  const doc = await ready(win);
  const tabs = ['income', 'expenses', 'loans', 'savings', 'investments', 'goals'];
  for (const tab of tabs) {
    doc.querySelector(`#tab-${tab}`).click();
    const panel = doc.querySelector(`#panel-${tab}`);
    const input = [...panel.querySelectorAll('table.ed')[0].querySelectorAll('input')]
      .find(i => i.dataset.path && i.dataset.path.endsWith('.name'));
    assert.ok(input, `${tab}: expected a .name input in the first table`);
    input.focus();
    for (const ch of 'xyz') fireInput(win, input, input.value + ch);
    assert.strictEqual(doc.activeElement, input, `${tab}: lost focus while typing (this is the v1.1 bug)`);
  }
  assert.deepStrictEqual(errors, [], `unexpected runtime errors: ${errors.map(e => e.message).join('; ')}`);
  dom.window.close();
}

// ---------------------------------------------------------------------
// 2. PMT/FV edge cases: rate = 0 (linear payoff) and years = 0 (no NaN/Infinity)
// ---------------------------------------------------------------------
async function testLoanMathEdgeCases() {
  const { dom, win } = loadApp();
  const doc = await ready(win);
  doc.querySelector('#resetBlank').click();
  await wait(50);
  doc.querySelector('#tab-loans').click();
  let panel = doc.querySelector('#panel-loans');
  const addBtn = [...panel.querySelectorAll('.btn')].find(b => b.textContent.includes('Add loan'));
  addBtn.click();
  panel = doc.querySelector('#panel-loans');
  const row = () => panel.querySelectorAll('table.ed')[0].querySelectorAll('tbody tr')[0];
  const setField = (suffix, value) => {
    const input = [...row().querySelectorAll('input, select')].find(i => i.dataset.path && i.dataset.path.endsWith(suffix));
    assert.ok(input, `missing field ending in "${suffix}"`);
    fireInput(win, input, value);
  };

  // Zero-interest loan: $1200 over 1 year, no extra payments, should amortize
  // to exactly $100/month with no NaN from the r===0 branch of PMT/FV.
  setField('.name', 'Test loan');
  setField('.amount', '1200');
  setField('.rate', '0');
  setField('.years', '1');
  const today = new Date().toISOString().slice(0, 10);
  setField('.first', today);
  await wait(50);
  const pmtCell = panel.querySelectorAll('table.ed')[0].querySelector('td[data-label="Required monthly payment"]');
  const text = pmtCell.textContent.replace(/[^0-9.]/g, '');
  assert.ok(text.length > 0, 'zero-rate loan produced no payment figure at all');
  assert.ok(!pmtCell.textContent.includes('NaN') && !pmtCell.textContent.includes('Infinity'), `zero-rate loan leaked ${pmtCell.textContent}`);
  const pmt = Number(text);
  assert.ok(Math.abs(pmt - 100) < 1, `zero-rate $1200/12mo payment should be ~100, got ${pmt}`);

  // years = 0 must not divide by zero anywhere visible.
  setField('.years', '0');
  await wait(50);
  const pmtCell2 = panel.querySelectorAll('table.ed')[0].querySelector('td[data-label="Required monthly payment"]');
  assert.ok(!pmtCell2.textContent.includes('NaN') && !pmtCell2.textContent.includes('Infinity'),
    `years=0 leaked a raw NaN/Infinity into the UI: "${pmtCell2.textContent}"`);

  dom.window.close();
}

// ---------------------------------------------------------------------
// 3. JSON backup round-trip: sample data survives export -> import intact
// ---------------------------------------------------------------------
async function testJsonRoundTrip() {
  const { dom, win } = loadApp();
  const doc = await ready(win);
  doc.querySelector('#resetSample').click();
  await waitForSave();
  const before = JSON.parse(win.localStorage.getItem('money-planner-v1'));

  const input = doc.querySelector('#importJSON');
  Object.defineProperty(input, 'files', { value: [fakeJsonFile('backup.json', before)], configurable: true });
  input.dispatchEvent(new win.Event('change', { bubbles: true }));
  await waitForSave();
  const after = JSON.parse(win.localStorage.getItem('money-planner-v1'));

  assert.strictEqual(after.income.length, before.income.length, 'income row count changed on round-trip');
  assert.strictEqual(after.income[0].name, before.income[0].name, 'income[0].name changed on round-trip');
  assert.strictEqual(after.goals.length, before.goals.length, 'goals row count changed on round-trip');
  assert.strictEqual(after.settings.currency, before.settings.currency, 'settings.currency changed on round-trip');
  dom.window.close();
}

// ---------------------------------------------------------------------
// 4. Malformed / malicious JSON is sanitized, not merged in verbatim
// ---------------------------------------------------------------------
async function testMalformedJsonSanitized() {
  const { dom, win } = loadApp();
  const doc = await ready(win);
  const malicious = {
    settings: { currency: 'USD', __proto__: { polluted: true }, evilKey: 'x' },
    income: [{ name: 'Job', amount: 1000, hackerField: '<img src=x onerror=alert(1)>' }, 'not-an-object', null, 42],
    budget: 'not-an-array',
    networth: { cash: 50, notAField: 999 },
    randomTopLevelJunk: { a: 1 },
  };
  const input = doc.querySelector('#importJSON');
  Object.defineProperty(input, 'files', { value: [fakeJsonFile('evil.json', malicious)], configurable: true });
  input.dispatchEvent(new win.Event('change', { bubbles: true }));
  await waitForSave();
  const saved = JSON.parse(win.localStorage.getItem('money-planner-v1'));

  assert.strictEqual(saved.income.length, 1, `expected only the 1 valid income row, got ${saved.income.length}`);
  assert.ok(!('hackerField' in saved.income[0]), 'unrecognised field "hackerField" was not dropped');
  assert.ok(!('evilKey' in saved.settings), 'unrecognised setting "evilKey" was not dropped');
  assert.ok(!('polluted' in saved.settings), 'prototype-pollution attempt leaked into settings');
  assert.ok(!('notAField' in saved.networth), 'unrecognised net worth field was not dropped');
  assert.ok(!('randomTopLevelJunk' in saved), 'unrecognised top-level section was not dropped');
  assert.ok(Array.isArray(saved.budget) && saved.budget.length > 0, 'wrong-shaped "budget" should fall back to defaults, not crash the import');
  dom.window.close();
}

// ---------------------------------------------------------------------
// 5. Excel (.xlsx) import round-trip, using the real SheetJS package
// ---------------------------------------------------------------------
async function testXlsxRoundTrip() {
  const XLSX = require('xlsx');
  const { dom, win } = loadApp();
  const doc = await ready(win);

  // Pre-install the real library so loadXLSX() skips its network fetch
  // (see the file header comment for why this is the right call, not a
  // shortcut around testing something real).
  win.XLSX = XLSX;

  const wb = XLSX.utils.book_new();
  const incomeRows = [
    ['Where the money comes from', 'Kind of income', 'How often', 'Amount each time', 'Start date (or date received)', 'End date (blank if ongoing)', 'Notes'],
    ['Freelance design', 'Side income', 'Monthly', 2500, '2026-01-01', '', 'From Excel import test'],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(incomeRows), 'Income');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });

  const fakeFile = { name: 'plan.xlsx', arrayBuffer: async () => buf };
  const input = doc.querySelector('#importXLSX');
  Object.defineProperty(input, 'files', { value: [fakeFile], configurable: true });
  input.dispatchEvent(new win.Event('change', { bubbles: true }));
  await waitForSave();

  const saved = JSON.parse(win.localStorage.getItem('money-planner-v1'));
  const row = saved.income.find(r => r.name === 'Freelance design');
  assert.ok(row, `imported Income row not found; got: ${JSON.stringify(saved.income)}`);
  assert.strictEqual(row.amount, 2500, `imported amount should be 2500, got ${row.amount}`);
  assert.strictEqual(row.freq, 'Monthly', `imported frequency should be "Monthly", got ${row.freq}`);
  dom.window.close();
}

(async () => {
  console.log('DFinance regression tests\n');
  await test('focus is retained while typing in every reorderable table', testFocusRetention);
  await test('loan math handles rate=0 and years=0 without NaN/Infinity', testLoanMathEdgeCases);
  await test('JSON backup survives an export -> import round-trip', testJsonRoundTrip);
  await test('malformed / malicious JSON import is sanitized, not merged verbatim', testMalformedJsonSanitized);
  await test('Excel (.xlsx) import round-trips real data via the real SheetJS package', testXlsxRoundTrip);

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
})();
