import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '**/*.config.ts', '**/*.config.mjs'],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
    },
  },
  // src/eval is a one-way leaf: the action bundle (entry src/index.ts) must
  // never reach eval code, or it ships in dist/index.js. Only the eval scripts
  // (scripts/golden/*) and src/eval itself may import from src/eval.
  {
    files: ['src/**/*.ts'],
    ignores: ['src/eval/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/eval/**', '../eval/*', './eval/*'],
              message:
                'src/ (outside src/eval) may not import src/eval/* — eval is leaf-only and must not ship in dist/index.js.',
            },
          ],
        },
      ],
    },
  },
];
