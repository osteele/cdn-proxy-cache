export default {
  testRunner: 'command',
  commandRunner: {
    command: 'bun test tests/proxyCache.stream.test.ts tests/proxyCache.test.ts',
  },
  coverageAnalysis: 'off',
  // Bun transpiles the tests directly; bypass Stryker's tsconfig rewriter,
  // which currently relies on a compiler API removed by TypeScript 7.
  tsconfigFile: '.cache/stryker-no-tsconfig.json',
  concurrency: 2,
  mutate: [
    'src/helpers/stream-helpers.ts:31-69',
    'src/internal/content.ts:30-76',
    'src/proxyCache.ts:427-443',
  ],
  reporters: ['clear-text', 'json'],
  jsonReporter: {
    fileName: '.cache/mutation-stream-report.json',
  },
  thresholds: {
    high: 80,
    low: 60,
    break: null,
  },
  timeoutMS: 5000,
};
