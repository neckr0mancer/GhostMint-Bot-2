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
    // .claude/worktrees/**: scratch worktrees other agent sessions create under this checkout.
    // They contain full copies of the dashboard (ESM) and get linted as repo files otherwise,
    // which fails `npm run lint` for code that is not part of this tree at all.
    ignores: ['node_modules/**', 'coverage/**', '.project-tools/**', 'public/dashboard/**', '.claude/**', '.ai-tools/**'],
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
