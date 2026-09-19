// ESLint flat config for the DFinance single-file app.
//
// Pinned to ESLint 9.x: as of writing, eslint-plugin-html@8.2.0 crashes
// under ESLint 10.x (a private-class-field error inside ESLint's own
// Linter — verified by actually running it, not assumed). Re-check that
// compatibility before bumping the eslint devDependency past ^9.
//
// index.html has no build step, so eslint-plugin-html extracts and lints
// the inline <script> blocks in place. no-unsanitized flags any
// innerHTML/outerHTML/insertAdjacentHTML assignment that isn't provably
// escaped, as a guardrail against a future unescaped interpolation shipping
// (see LINTING.md — this file was written after a manual security audit
// found the existing code was correctly escaping user input everywhere,
// but with no automated check to keep it that way).
//
// IMPORTANT CAVEAT — read LINTING.md before treating this as a clean gate:
// no-unsanitized only recognizes a *tagged template* as a proof of escaping
// (e.g. escapeHTML`<b>${x}</b>`). This codebase's esc() helper wraps each
// interpolated *value* instead (e.g. `<b>${esc(x)}</b>`), which the rule
// cannot statically verify. Running this fresh will flag every existing
// innerHTML assignment, including the ones already reviewed and correctly
// escaped — that's a false-positive rate the rule's author is upfront
// about, not a bug in this config. See LINTING.md for how to run it usefully
// today (as a manual audit checklist) versus what it would take to make it
// a real CI gate (adopting esc() as a tagged template, a larger change than
// this config on its own).
import js from '@eslint/js';
import html from 'eslint-plugin-html';
import noUnsanitized from 'eslint-plugin-no-unsanitized';

export default [
  js.configs.recommended,
  {
    files: ['**/*.html'],
    plugins: { html, 'no-unsanitized': noUnsanitized },
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'script',
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        localStorage: 'readonly',
        console: 'readonly',
        requestAnimationFrame: 'readonly',
        performance: 'readonly',
        fetch: 'readonly',
        CSS: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        URL: 'readonly',
        Blob: 'readonly',
        location: 'readonly',
        history: 'readonly',
      },
    },
    rules: {
      'no-unsanitized/method': 'error',
      'no-unsanitized/property': 'error',
      'no-unused-vars': 'warn',
      'no-undef': 'warn',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
];
