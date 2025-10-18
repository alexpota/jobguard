module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test/e2e'],
  testMatch: ['**/*.e2e.test.ts'],
  globalSetup: '<rootDir>/test/e2e/global-setup.ts',
  globalTeardown: '<rootDir>/test/e2e/global-teardown.ts',
  setupFilesAfterEnv: ['<rootDir>/test/e2e/jest-setup.ts'],
  testTimeout: 60000,
  maxWorkers: 1,
  bail: true,
  verbose: true,
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/types/**',
  ],
  globals: {
    'ts-jest': {
      tsconfig: 'tsconfig.e2e.json',
    },
  },
};
