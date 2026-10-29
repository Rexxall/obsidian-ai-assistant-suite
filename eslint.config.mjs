import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  { ignores: ["main.js", "dist/**", "node_modules/**", "scripts/**", "docs/**", "*.test.cjs", "*.mjs"] },
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.js"],
    languageOptions: {
      parserOptions: { projectService: { allowDefaultProject: ["src/*.js"] } }
    }
  }
]);
