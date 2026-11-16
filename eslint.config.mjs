import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  { ignores: ["main.js", "dist/**", "node_modules/**", "scripts/**", "docs/**", "*.test.cjs", "*.mjs"] },
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.js"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }
    }
  },
  {
    // The shared AI layer (rex-ai-kit), vendored as TypeScript; esbuild bundles it into main.js.
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }
    }
  }
]);
