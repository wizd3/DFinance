# Linting DFinance

`index.html` has no build step — this lint setup is a dev-only addition on
top of that, not a requirement to run the app.

## Setup

```
npm install
npm run lint    # eslint index.html
npm test        # node tests/dfinance.test.js
```

## What the lint rule actually catches today

`eslint-plugin-no-unsanitized` flags `innerHTML`/`outerHTML`/
`insertAdjacentHTML` assignments that it can't statically prove are safe.
This was added after a manual security audit of `index.html` found ~65
`innerHTML` call sites, all correctly escaping user-entered text through a
local `esc()` helper — but with nothing automated stopping a *future*
change from adding an unescaped one.

**Known limitation, not a bug:** the plugin's only built-in way to recognize
"this is safe" is a *tagged template* — code shaped like
`` foo.innerHTML = escapeHTML`<b>${x}</b>` ``. This codebase's `esc()`
instead wraps each interpolated *value*: `` `<b>${esc(x)}</b>` ``. The
plugin cannot see inside a plain template literal to tell whether every
substitution was escaped, so as configured it flags **every** `innerHTML`
assignment in the file, including the ones already reviewed and correctly
escaped. Running `npm run lint` today will show on the order of 60 of
these — that is expected, not a regression.

## How to actually use this until that's resolved

Pick one:

1. **Manual audit checklist (no code changes needed).** Run
   `npm run lint`, and for each `no-unsanitized/property` hit, manually
   confirm every `${...}` in that assignment is either a static string, a
   number, or wrapped in `esc()` (or a value that's already been through
   `esc()` upstream, e.g. `fm()`/`fp()`-formatted numbers, which are
   numeric and can't carry markup). This is exactly the audit that produced
   the "already escaping everywhere" finding — this config just gives you
   the list of call sites to re-check instead of finding them by hand.
2. **Make it a real CI gate (bigger change, not done here).** Convert
   `esc()` into a tagged-template helper and change call sites from
   `` `<b>${esc(x)}</b>` `` to `` escapeHTML`<b>${x}</b>` ``, then configure
   `no-unsanitized`'s `escape.taggedTemplates` option to recognize it. That
   touches every one of the ~65 sites and is a deliberate refactor, not a
   lint-config tweak — out of scope for this pass.

Either way, the rule is still worth keeping **on**: a *new* unescaped
`innerHTML = someVariable` (no `esc()`, no static string) will still stand
out from the reviewed pattern above, which is the actual goal.

## Version pin

ESLint is pinned to `^9`, not `^10` — `eslint-plugin-html@8.2.0` crashes
under ESLint 10.x as of this writing (verified by running it, not assumed).
Re-check that compatibility before bumping.
