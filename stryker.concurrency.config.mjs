export default {
  testRunner: 'command',
  commandRunner: {
    command:
      "bun test tests/proxyCache.stream.test.ts tests/proxyCache.test.ts --test-name-pattern 'coalesc|follower|pre-aborted|router entry|already disconnected|already destroyed|generation owner|timeout diagnostic|bad-gateway|stale refresh|stale data|cache-writer|cache write|forced refresh|origin query|active origin|non-Error cancellation'",
  },
  coverageAnalysis: 'off',
  // Bun transpiles the tests directly; bypass Stryker's tsconfig rewriter,
  // which currently relies on a compiler API removed by TypeScript 7.
  tsconfigFile: '.cache/stryker-no-tsconfig.json',
  concurrency: 2,
  mutate: [
    'src/proxyCache.ts:262-264',
    'src/proxyCache.ts:293-295',
    'src/proxyCache.ts:342-374',
    'src/proxyCache.ts:508-523',
    'src/proxyCache.ts:999-1062',
  ],
  reporters: ['clear-text', 'json'],
  jsonReporter: {
    fileName: '.cache/mutation-concurrency-report.json',
  },
  thresholds: {
    high: 80,
    low: 60,
    break: null,
  },
  timeoutMS: 5000,
};
