# Contributing

```bash
npm ci
npm run build          # src/main.js -> main.js (the file attached to each release)
npm test               # builds, then runs the tests
npm run lint           # Obsidian's lint rules and the directory's CSS checks
npm run release:check  # lint, tests, release zip and a byte check against main.js
npm run measure:startup -- --vault <test vault> --port <port>
```

Before a release, run `measure:startup` against a clean test vault that has only this plugin enabled and is open in Obsidian with `--remote-debugging-port`. It reloads Obsidian nine times with timing code around `onload`, restores the installed `main.js`, and fails if the median `onload` is over 50 ms or a child process starts before the layout is ready. Anything that can wait goes in `onLayoutReady`.

The tests load the built `main.js` in a sandbox with stub classes. Versions are in [CHANGELOG.md](CHANGELOG.md).

CI runs lint, tests and a build on every push to `main` and every pull request. Pushing a version tag such as `1.7.1` runs the release workflow: it checks the tag against `manifest.json`, `package.json`, `package-lock.json` and `versions.json`, runs `release:check`, attests `main.js`, `manifest.json` and `styles.css`, and creates the release with that version's CHANGELOG section as its notes.
