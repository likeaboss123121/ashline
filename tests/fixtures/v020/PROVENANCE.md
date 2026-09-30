# v0.2.0 compatibility fixtures

Captured by `scripts/capture-v020-saves.cjs` from the **unmodified public release HTML**, not a rebuilt approximation or the current game.

- Release: [Ashline Alpha v0.2.0](https://github.com/likeaboss123121/ashline/releases/tag/v0.2.0)
- Asset: `https://github.com/likeaboss123121/ashline/releases/download/v0.2.0/ashlinegame.html`
- Asset SHA-256: `1ed1b8ec23446d3ecbd34330390d3f5a02a970a0fcea6c841539c3c83436a474`
- Seed: `migration-v020`
- Engine: SugarCube 2.36.1

Each JSON holds the browser-slot envelope (`save`), compressed file export (`exported`), browser session (`session`), passage name and post-render live variables (`live`). The capture follows ordinary controls from Start: the first yard, boarding, driving in the yard, out on the line, on foot beside the train and a square away from it, arrival at station 2, and leaving the train there. The tutorial's shunting puzzle is cleared first, as the release's own tests did.

Regenerate with:

```sh
gh release download v0.2.0 --repo likeaboss123121/ashline --pattern ashlinegame.html
ASHLINE_BROWSER=chromium node scripts/capture-v020-saves.cjs ashlinegame.html
```
