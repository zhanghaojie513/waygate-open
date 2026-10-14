import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  /* `dist*` 而不是 `dist`：`vite build --outDir dist-mock`（队友做 mock 预览用的）会产出
     `dist-mock/`，而 `dist` **不匹配** `dist-mock`。漏了它 → `eslint .` 去 lint 压缩产物，
     一次冒出 1367 条 no-undef/no-unused-expressions 噪声，把真正的错误淹掉。
     构建产物本就不该被 lint，这里用通配一次性覆盖所有 dist 变体。 */
  { ignores: ['dist*', 'node_modules', 'src/styles/vendor/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': ['warn', { prefer: 'type-imports' }],
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  {
    // 构建期脚本（node 环境，非浏览器）：note 标记覆盖门禁等
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.node,
    },
    rules: {
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
);
// @zbiti-ai:f:37:58643264
