import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/", "node_modules/", "webpack.config.js", "vitest.config.ts", "src/__tests__/", "src/__mocks__/"],
  }
);