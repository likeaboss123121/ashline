# Ashline

Ashline is a text-based survival game about circumnavigating the globe by train during a zombie apocalypse. You play a lone train engineer in a world where dangerous zombies called Foamers keep expanding the railroad without end. Explore rail yards, take command of diesel and steam locomotives, and build a working consist from the rolling stock you find along the line.

Ashline is free and open source, and it runs entirely in your browser. It is built with [Twine](https://twinery.org/) and the [SugarCube 2](https://www.motoslave.net/sugarcube/2/) story format.

**[Visit the Ashline website](https://likea.moe/ashlinegame/about/)**

## Play

- **In your browser:** play the current build on the [Ashline website](https://likea.moe/ashlinegame).
- **Offline:** download a playable HTML file from the [Releases page](https://github.com/likeaboss123121/ashline/releases), then open it in any modern browser.

Saves are stored in your browser. To keep a backup, use **Save to Disk** in the Saves menu.

Found a bug? Please [open an issue](https://github.com/likeaboss123121/ashline/issues).
In debug mode, **Copy bug report** opens a selectable report with the build, seed, current yard,
consist and recent actions. Review it before sharing; it includes your current gameplay state.

## Building from source

The game compiles to a single HTML file with [Tweego](https://github.com/tmedwards/tweego), a command-line compiler for Twine stories. Tweego is not included in this repository.

### Requirements

1. **Tweego 2.1.1 or newer.** Download it from the [Tweego releases page](https://github.com/tmedwards/tweego/releases). See the [Tweego documentation](https://www.motoslave.net/tweego/docs/) for installation details.
2. **SugarCube 2.36.1.** Tweego 2.1.1 ships with an older SugarCube (2.30.0), but Ashline targets 2.36.1. Download `sugarcube-2.36.1-for-twine-2.1-local.zip` from the [SugarCube releases page](https://github.com/tmedwards/sugarcube-2/releases/tag/v2.36.1). Then replace the `sugarcube-2` folder inside Tweego's `storyformats` directory with the one from the archive.

Confirm that Tweego finds the correct story format:

```sh
tweego --list-formats
```

The list should include `sugarcube-2   SugarCube (2.36.1)`.

### Compile

From the repository root, run:

```sh
tweego -f sugarcube-2 -o index.html source
```

This compiles every passage and script in `source/` into `index.html`, which you can open directly in a browser. To recompile automatically whenever a source file changes, add `--watch`:

```sh
tweego --watch -f sugarcube-2 -o index.html source
```

### Tests and artwork

First-party build scripts, tests, and npm manifests are version-controlled. Install Node.js 22+
and run `npm ci`, then install the browser with `npx playwright install chromium`.
With Tweego and SugarCube configured as above:

```sh
npm run build
npm test
ASHLINE_BROWSER=chromium npm run test:browser
```

Browser fixtures use a fixed seed. Screenshots and diagnostic state for failed cases go into the
ignored `test-results/` directory. `npm run verify` runs all checks; only passing builds should be deployed.

The two Python 3 generators under `scripts/` produce the SVG assets and their placement data.
Edit the generators, not the generated files:

```sh
python3 scripts/draw-railyard-templates.py
python3 scripts/draw-driving-templates.py
```

## License

Ashline is licensed under the [GNU Affero General Public License v3.0](LICENSE).

Compiled builds embed [SugarCube](https://github.com/tmedwards/sugarcube-2), which is distributed under its own BSD 2-Clause license. [Tweego](https://github.com/tmedwards/tweego) is a separate tool with its own license and is not part of this project.
