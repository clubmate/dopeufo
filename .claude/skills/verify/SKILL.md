---
name: verify
description: Build, launch, and drive UFO Tactical PvP in headless Chromium to verify rendering/UI/gameplay changes end-to-end.
---

# Verifying UFO Tactical PvP

## Launch

```bash
npx vite --port 5199 --strictPort   # run in background, from repo root
```

## Drive (headless Chromium via Playwright)

The `playwright` npm package is NOT installed. Browsers are cached at
`~/.cache/ms-playwright`. Install `playwright-core` into a scratch dir and
point it at the cached binary:

```js
import { chromium } from 'playwright-core';
const browser = await chromium.launch({
  executablePath: process.env.HOME + '/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
});
```

Flow: `goto http://localhost:5199` → `click('.bigbtn')` (Start Battle) →
in-game. Keyboard: `q`/`e` rotate, wheel zoom, `1` snap-shot mode, `Enter`
end turn (→ handoff screen with another `.bigbtn`).

## Gotchas

- Software GL renders at ~4–6 fps headless: sleep 2.5–4 s after any action
  before screenshotting (camera/zoom smoothing needs to settle).
- Dev hook `window.__game = { state, controller, updateVision }` exists in
  main.ts. After teleporting units by editing `state` directly, call
  `updateVision(state)` then `controller.resync()`, or shots fail validation
  as "target not visible".
- Enemies start outside vision; teleport one next to a friendly unit to test
  enemy UI (labels, red HP pips, shot tooltips).
- A favicon 404 in the console is normal.
