import eslintConfigPrettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

const serverOnlyMessage =
  'Client and Vue code must not import from src/server. Share logic through a neutral module instead.';
const privyMessage =
  'Only the server entry point may use @privy-io/node. Client and Vue code call host HTTP endpoints instead.';

const wagmiMessage =
  'Only the wagmi entry point may use @wagmi/core. Client and Vue code must load without wagmi installed.';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'examples/**/node_modules/**',
      'examples/**/dist/**',
    ],
  },
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    files: ['src/client/**/*.ts', 'src/vue/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: '@privy-io/node', message: privyMessage },
            { name: '@wagmi/core', message: wagmiMessage },
          ],
          patterns: [
            {
              group: ['@privy-io/node/*'],
              message: privyMessage,
            },
            {
              group: ['@wagmi/*', '**/wagmi', '**/wagmi/**'],
              message: wagmiMessage,
            },
            {
              group: ['**/server', '**/server/**', '**/src/server/**'],
              message: serverOnlyMessage,
            },
          ],
        },
      ],
    },
  },
);
