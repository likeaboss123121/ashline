Ashline is a Twine/SugarCube railway survival prototype. The playable build is [index.html](index.html).

Edit passages in [source/main.tw](source/main.tw) and game logic/macros in [source/scripts.js](source/scripts.js). Tweego automatically includes JavaScript files from `source` when compiling. Do not edit generated `index.html` directly.

**Build and play on Windows**

In VS Code, run the default build task with Ctrl+Shift+B (`Tweego: Build`), then open `index.html` in a browser. `Tweego: Watch` recompiles whenever a source file changes.

The equivalent PowerShell command, from this folder, is:

```powershell
& '.\tweego-2.1.1-windows-x64\tweego.exe' -f sugarcube-2 -o index.html source
```

The bundled compiler is Tweego 2.1.1 and the game uses the bundled SugarCube 2.36.1. Node.js is only needed for the development commands and tests; the game itself runs from the generated HTML without Node or npm packages.

**Development checks**

Install Node.js 22 or newer and Google Chrome, then run:

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run test:browser
```

`npm test` runs the game-logic regression suite, including 1,000 deterministic yard-generation cases. `npm run test:browser` first compiles the actual game with Tweego, then exercises that HTML in a fresh, headless Chrome context. These tests use isolated browser storage and do not touch your normal browser saves. Playwright is a development dependency, pinned in `package-lock.json`.

To use installed Microsoft Edge for the browser tests:

```powershell
$env:ASHLINE_BROWSER = 'msedge'
npm.cmd run test:browser
```

`npm run build` and `npm run watch` also invoke Tweego. Set `TWEEGO` to an alternate compiler executable if necessary. The VS Code tasks always use the bundled Windows executable.

**Project contents**

| Path | Purpose |
| --- | --- |
| `source/main.tw` | Story metadata, initialization, and playable passages |
| `source/scripts.js` | Time/fuel simulation, rolling stock, generation, shunting, dialogs, and custom macros |
| `scripts/build.cjs` | Build/watch command wrapper |
| `tests/` | Logic tests and compiled-game browser tests |
| `tweego-2.1.1-windows-x64/` | Bundled compiler, story formats, icons, and licenses |
| `tool docs/` | Reference material; some documents cover newer SugarCube APIs than the bundled engine |
| `REVIEW.md` | Findings, fixes, validation, and outstanding gameplay decisions |

Story Mode is intentionally disabled. Infinite Mode is a prototype: survival-stat updates and ordinary cargo transfer/refueling are still unimplemented. See [the review](REVIEW.md) before treating the current build as a complete survival game.
