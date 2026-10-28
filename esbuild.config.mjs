import esbuild from "esbuild";

// The release main.js is this build's output, byte for byte: no minifying, no source map.
await esbuild.build({
  entryPoints: ["src/main.js"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*", "@lezer/*"],
  format: "cjs",
  target: "es2020",
  platform: "node",
  outfile: "main.js",
  legalComments: "none",
  // Obsidian and the tests both take the plugin class straight from module.exports.
  footer: { js: "module.exports = module.exports.default;" },
  logLevel: "warning"
});
