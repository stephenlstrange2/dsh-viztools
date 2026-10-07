import { defineConfig } from 'tsdown'

export default defineConfig([
  {
    entry: ['src/index.ts', 'src/gate.ts', 'src/report.ts', 'src/profile-check.ts'],
    outDir: 'lib',
    format: 'esm',
    dts: true,
    sourcemap: true,
    clean: true,
    external: [/^@deepseek-ai\//],
  },
  {
    entry: ['src/client.ts'],
    outDir: 'lib',
    format: 'esm',
    dts: true,
    sourcemap: true,
    platform: 'browser',
    external: [/^@deepseek-ai\//],
  },
])
