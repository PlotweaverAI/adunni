module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    '^@adunni/shared-types$': '<rootDir>/../shared-types/dist',
    '^@adunni/asr-service$': '<rootDir>/../asr-service/dist',
    '^@adunni/tts-service$': '<rootDir>/../tts-service/dist',
    '^@adunni/orchestrator$': '<rootDir>/../orchestrator/dist',
    '^@adunni/security$': '<rootDir>/../security/dist',
  },
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
};
