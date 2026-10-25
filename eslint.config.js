import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'data/**',
      '.tools/**',
      '.tmp/**',
      'coverage/**',
    ],
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      globals: {
        document: 'readonly',
        location: 'readonly',
        history: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        fetch: 'readonly',
        setInterval: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        WebSocket: 'readonly',
        addEventListener: 'readonly',
      },
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
