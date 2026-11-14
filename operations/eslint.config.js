export default [
  { ignores: ['dist/', 'node_modules/', 'coverage/', 'packages/*/dist/'] },
  {
    rules: {
      'no-unused-vars': 'warn',
      'no-console': 'off',
    },
  },
];
