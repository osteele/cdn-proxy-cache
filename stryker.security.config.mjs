export default {
  testRunner: 'command',
  commandRunner: {
    command: 'bun test tests/proxyCache.security.test.ts',
  },
  coverageAnalysis: 'off',
  // Bun transpiles the tests directly; bypass Stryker's tsconfig rewriter,
  // which currently relies on a compiler API removed by TypeScript 7.
  tsconfigFile: '.cache/stryker-no-tsconfig.json',
  concurrency: 2,
  mutate: [
    'src/proxyCache.ts:115-147',
    'src/proxyCache.ts:255-265',
    'src/proxyCache.ts:291-291',
    'src/proxyCache.ts:388-393',
    'src/proxyCache.ts:422-423',
    'src/proxyCache.ts:425-426',
    'src/proxyCache.ts:457-464',
    'src/proxyCache.ts:502-521',
    'src/proxyCache.ts:806-844',
    'src/proxyCache.ts:1081-1108',
  ],
  reporters: ['clear-text', 'json'],
  jsonReporter: {
    fileName: '.cache/mutation-security-report.json',
  },
  thresholds: {
    high: 80,
    low: 60,
    break: null,
  },
  timeoutMS: 5000,
};
