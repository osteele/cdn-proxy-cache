export default {
  testRunner: 'command',
  commandRunner: {
    command: 'bun test tests/async-read-write-lock.test.ts',
  },
  coverageAnalysis: 'off',
  // Bun transpiles the tests directly; bypass Stryker's tsconfig rewriter,
  // which currently relies on a compiler API removed by TypeScript 7.
  tsconfigFile: '.cache/stryker-no-tsconfig.json',
  concurrency: 2,
  mutate: ['src/internal/async-read-write-lock.ts'],
  reporters: ['clear-text', 'json'],
  jsonReporter: {
    fileName: '.cache/mutation-lock-report.json',
  },
  thresholds: {
    high: 80,
    low: 60,
    break: null,
  },
  timeoutMS: 5000,
};
