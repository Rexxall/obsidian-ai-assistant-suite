# Contributing

```bash
npm ci
npm run build          # src/main.js -> main.js (the file attached to each release)
npm test               # builds, then runs the tests
npm run lint           # Obsidian's lint rules and the directory's CSS checks
npm run release:check  # lint, tests, release zip and a byte check against main.js
```

The tests load the built `main.js` in a sandbox with stub classes. Versions are in [CHANGELOG.md](CHANGELOG.md).
