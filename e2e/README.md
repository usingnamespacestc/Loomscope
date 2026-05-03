# e2e — Playwright tests against the live dev server

These specs are smoke tests for the v0.7 compact handling milestone.
Loomscope intentionally does **not** install Playwright as an npm
dependency (keeps the production tree clean). The e2e setup borrows
Playwright from a sibling project that already has it.

## Run

1. Start the dev server in another shell:
   ```sh
   npm run dev   # vite on 5175 + hono on 5174
   ```
2. Symlink Playwright from the sibling Agentloom project (one-shot
   per fresh checkout — the symlink lives in `node_modules/` and
   does not appear in `package.json`):
   ```sh
   mkdir -p node_modules/@playwright
   ln -s ~/Agentloom/frontend/node_modules/@playwright/test \
         node_modules/@playwright/test
   ```
3. Run the suite:
   ```sh
   ~/Agentloom/frontend/node_modules/.bin/playwright test \
     --config=e2e/playwright.config.ts
   ```

Headless chromium by default. Add `--headed` to watch in a window.

## What the specs cover

`compact.spec.ts` runs 4 tests against the author's main 256MB session
(`2362ff7c-9cfc-4f35-817c-0366bb2056ff`):

1. compact ChatNode renders with dashed border + tri-color chrome
2. compact chip shows the trigger label
3. clicking "⤢ 展开 pre-compact" pushes a compact-original drill frame
   and the breadcrumb appears with "pre-compact"
4. ChatFlow canvas registers the `<marker id="arrow-logical">` SVG def
   (proves M4 wiring; off-viewport edges are React-Flow-culled so we
   verify the marker mount instead)

The compact_file_reference panel rendering is unit-tested in
`src/components/drill/details.test.tsx`; finding one in the wild via
Playwright requires drilling into a specific WorkNode and is brittle.

## Backlog

- Set up a project-local Playwright install (`v0.10` polish range)
  once Loomscope's CI story exists. Until then borrowing Agentloom's
  binary keeps the dependency tree clean.
- More spec coverage (sub-agent drill / DrillPanel selection / etc.)
  if specific regressions surface that unit tests can't catch.
