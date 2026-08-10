const nodeGlobals = {
  __dirname: 'readonly',
  clearTimeout: 'readonly',
  console: 'readonly',
  fetch: 'readonly',
  module: 'readonly',
  process: 'readonly',
  require: 'readonly',
  setTimeout: 'readonly',
};

module.exports = [
  {
    ignores: ['node_modules/**', 'coverage/**'],
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
];
