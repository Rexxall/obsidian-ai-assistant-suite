import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import { DEFAULT_BRANDS } from "eslint-plugin-obsidianmd/dist/lib/rules/ui/brands.js";

export default defineConfig([
  { ignores: ["main.js", "dist/**", "node_modules/**", "scripts/**", "docs/**", "*.test.cjs", "*.mjs"] },
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.js"],
    languageOptions: {
      parserOptions: { projectService: { allowDefaultProject: ["src/*.js"] } }
    },
    rules: {
      // The rule's brand list lacks the AI providers this plugin talks to; their names keep their own spelling.
      // URLs and model IDs (例如 gemini-2.5-pro) are typed exactly as the service expects.
      "obsidianmd/ui/sentence-case": ["warn", {
        brands: [...DEFAULT_BRANDS, "DeepSeek", "DeepSeek Flash", "DeepSeek V4 Pro", "Ollama", "LM Studio"],
        ignoreRegex: ["https?://", "^例如 [\\w.-]+$"]
      }]
    }
  }
]);
