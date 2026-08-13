const nodeGlobals = {
  __dirname: 'readonly',
  clearTimeout: 'readonly',
  clearInterval: 'readonly',
  console: 'readonly',
  fetch: 'readonly',
  module: 'readonly',
  process: 'readonly',
  require: 'readonly',
  setTimeout: 'readonly',
  setInterval: 'readonly',
};

module.exports = [
  {
    ignores: ['node_modules/**', 'coverage/**', '.project-tools/**', 'public/dashboard/**'],
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: nodeGlobals,
    },
    rules: {
      'no-dupe-keys': 'error',
      'no-undef': 'error',
      'no-unreachable': 'error',
    },
  },
  {
    files: ['dashboard/src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { console:'readonly', document:'readonly', fetch:'readonly', WebSocket:'readonly', window:'readonly' },
    },
    rules: { 'no-dupe-keys':'error','no-undef':'error','no-unreachable':'error' },
  },
];
