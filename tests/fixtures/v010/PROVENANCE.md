# v0.1.0 compatibility fixtures

Captured by `scripts/capture-v010-saves.cjs` from the **unmodified public release HTML**, not a rebuilt approximation or the current game.

- Release: [Ashline Alpha v0.1.0 / MajorUpdate](https://github.com/likeaboss123121/ashline/releases/tag/MajorUpdate)
- Source commit: `a7b0d2133584ce7d2f862a538768218a7e61261f`
- Asset: `https://github.com/likeaboss123121/ashline/releases/download/MajorUpdate/ashlinegame.html`
- Asset SHA-256: `970bdf371a9c8e6477bbcf23412ffdeb929458c0bdad01578ddd3217083a406c`
- Seed: `migration-v010`
- Engine: SugarCube 2.36.1

Each JSON contains the browser-slot envelope (`save`), compressed file export (`exported`), browser session (`session`), passage name, and post-render live variables (`live`). Slot/export/session snapshots can differ from live variables because v0.1.0 saved passage-entry history rather than completed in-passage changes. In particular, an arriving yard may not exist yet and leaving a train may still require placement.

The capture follows ordinary controls from Start through the introduction, the first yard, boarding, driving, arrival at station 2, and leaving the train. Tests compare migrated stock/cargo/positions with what the original release actually displayed, then save and load the result again. The locomotive dimensions deliberately change to the approved v0.2.0 shunter specifications.

Regenerate with:

```sh
ASHLINE_BROWSER=chromium node scripts/capture-v010-saves.cjs /path/to/ashlinegame.html
```

Only generated save data is checked in; the third-party engine and original compiled HTML are not vendored. Timestamps in regenerated save envelopes and compressed exports naturally differ.
