/**
 * @type {import('lint-staged').Configuration}
 */
export default {
  '(actions/**/*.ts|dist/**/*.js)': [
    'bash -c "npm run build"',
    'git diff --exit-code dist',
    "echo 'Pre-commit check: TypeScript built and dist is up-to-date.'",
    "echo 'If you have uncommitted changes in dist/, please git add them manually.'",
  ],
};
