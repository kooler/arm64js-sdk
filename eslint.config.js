// ESLint checks code, Prettier formats it. eslint-config-prettier turns off
// every ESLint rule that would disagree with Prettier's output.

import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import perfectionist from 'eslint-plugin-perfectionist';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/', 'src/version.ts'] },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { perfectionist },
    rules: {
      // Packages first, then this repo's files, with no blank line between.
      'perfectionist/sort-imports': [
        'error',
        {
          groups: [
            ['builtin', 'external'],
            ['parent', 'sibling', 'index'],
          ],
          newlinesBetween: 0,
        },
      ],
      // Inside the braces: values first, then `type` names.
      'perfectionist/sort-named-imports': ['error', { groups: ['value-import', 'type-import'] }],
      'perfectionist/sort-named-exports': ['error', { groups: ['value-export', 'type-export'] }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      // `import { type A }` still loads the module; `import type { A }` does not.
      '@typescript-eslint/no-import-type-side-effects': 'error',
      // Passing on a caught value as is, whatever it was, is fine.
      '@typescript-eslint/prefer-promise-reject-errors': ['error', { allowThrowingUnknown: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Fakes implement async interfaces without awaiting anything.
    files: ['tests/**'],
    rules: { '@typescript-eslint/require-await': 'off' },
  },
  {
    files: ['**/*.{js,mjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { ...globals.node } },
  },
  prettier,
);
