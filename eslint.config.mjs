import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  { ignores: ["main.js", "dist/**", "node_modules/**", "scripts/**", "docs/**", "*.test.cjs", "*.mjs"] },
  ...obsidianmd.configs.recommended,
  // The community review runs this rule even though "recommended" leaves it off.
  { rules: { "obsidianmd/no-view-references-in-plugin": "error" } },
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname }
    },
    // The community scorecard counts these as warnings; keep them at zero so the code stays typed.
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-return": "error"
    }
  }
]);
