import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import prettier from 'eslint-config-prettier';

export default [
  {
    ignores: ['public/**', 'node_modules/**', 'tests/**', 'dist/**', 'bun.lock'],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    // Scripts intentionally use console.log for output; logger is server-side.
    files: ['scripts/**/*.ts', 'src/db/migrate.ts', 'src/utils/logger.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  prettier,
];
