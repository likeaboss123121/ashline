# Ashline

Ashline is a text-based survival game about circumnavigating the globe by train during a zombie apocalypse. You play a lone train engineer in a world where dangerous zombies called Foamers keep expanding the railroad without end. Explore rail yards, take command of diesel and steam locomotives, and build a working consist from the rolling stock you find along the line.

Ashline is free and open source, and it runs entirely in your browser. It is built with [Twine](https://twinery.org/) and the [SugarCube 2](https://www.motoslave.net/sugarcube/2/) story format.

**[Visit the Ashline website](https://likeaserver.myddns.me/ashlinegame/about/)**

## Play

- **In your browser:** play the current build on the [Ashline website](https://likeaserver.myddns.me/ashlinegame).
- **Offline:** download a playable HTML file from the [Releases page](https://github.com/likeaboss123121/ashline/releases), then open it in any modern browser.

Saves are stored in your browser. To keep a backup, use **Save to Disk** in the Saves menu.

Found a bug? Please [open an issue](https://github.com/likeaboss123121/ashline/issues).

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

## Development

Automated tests and the npm build scripts require [Node.js](https://nodejs.org/) 22 or newer. The browser tests also require Google Chrome or Microsoft Edge.

```sh
npm ci                    # install development dependencies
npm test                  # game-logic tests, including 1,000 generated yard layouts
npm run build             # compile index.html with Tweego
npm run watch             # recompile on changes
npm run test:browser      # compile, then test the game in headless Chrome
```

The npm scripts look for a `tweego` command on your `PATH`. To use a compiler somewhere else, set the `TWEEGO` environment variable to its full path. On Windows, `TWEEGO` is required unless Tweego is in a `tweego-2.1.1-windows-x64` folder at the repository root.

To run the browser tests with Microsoft Edge, set `ASHLINE_BROWSER=msedge`. The browser tests use isolated storage and never touch your normal browser saves.

## Project structure

| Path | Purpose |
| --- | --- |
| `source/main.tw` | Story metadata, initialization, and playable passages |
| `source/scripts.js` | Simulation, rolling stock, yard generation, shunting, dialogs, and custom macros |
| `scripts/build.cjs` | Build and watch wrapper around Tweego |
| `tests/` | Game-logic tests and compiled-game browser tests |

Do not edit a compiled `index.html` directly. Make changes in `source/` and recompile.

## License

Ashline is licensed under the [GNU Affero General Public License v3.0](LICENSE).

Compiled builds embed [SugarCube](https://github.com/tmedwards/sugarcube-2), which is distributed under its own BSD 2-Clause license. [Tweego](https://github.com/tmedwards/tweego) is a separate tool with its own license and is not part of this project.
