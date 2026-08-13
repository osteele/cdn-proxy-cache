export default {
  testRunner: 'command',
  commandRunner: {
    command:
      "bun test tests/proxyCache.resources.test.ts --test-name-pattern 'rejects|clear|prune|evicts|counts duplicate'",
  },
  coverageAnalysis: 'off',
  // Bun transpiles the tests directly; bypass Stryker's tsconfig rewriter,
  // which currently relies on a compiler API removed by TypeScript 7.
  tsconfigFile: '.cache/stryker-no-tsconfig.json',
  concurrency: 2,
  mutate: [
    'src/proxyCache.ts:286-309',
    'src/proxyCache.ts:639-664',
    'src/proxyCache.ts:1163-1236',
  ],
  reporters: ['clear-text', 'json'],
  jsonReporter: {
    fileName: '.cache/mutation-resources-report.json',
  },
  thresholds: {
    high: 80,
    low: 60,
    break: null,
  },
  timeoutMS: 5000,
};
