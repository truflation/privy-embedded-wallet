import { defineConfig } from 'tsup';

// Dependencies and peerDependencies from package.json are external by default,
// so @privy-io/node, viem, @wagmi/core, and vue are never bundled.
export default defineConfig({
  entry: {
    server: 'src/server/index.ts',
    client: 'src/client/index.ts',
    wagmi: 'src/wagmi/index.ts',
    vue: 'src/vue/index.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
});
