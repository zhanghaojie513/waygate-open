import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // '*.mjs' / '*.js' 只匹配根目录层级，scripts/ 下的脚本要单独写 glob，
    // 否则其中的 Node 全局（console/process/fetch/setTimeout）会被判为未定义。
    ignores: [
      'dist/**',
      'node_modules/**',
      'data/**',
      // 注意：裸 '*.mjs' / '*.js' 只匹配根目录层级，子目录里的脚本必须写 '**/*.mjs'。
      // 这两类是一次性运维脚本（迁移 / 应急设口令），不在产品代码质量门禁范围内。
      '*.mjs',
      '*.js',
      '**/*.mjs',
      '**/*.js',
      'scripts/**',
      'tools/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'off',
    },
  },
);
