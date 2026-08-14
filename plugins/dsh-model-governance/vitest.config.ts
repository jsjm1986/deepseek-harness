import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

const repo = resolve(import.meta.dirname, '../..')

export default defineConfig({
  resolve: {
    alias: {
      '@deepseek-ai/cordis': resolve(repo, 'vendor/cordis/src/index.ts'),
      '@deepseek-ai/dsh-agent': resolve(repo, 'packages/core/agent/src/index.ts'),
      '@deepseek-ai/dsh-llm': resolve(repo, 'packages/llm/llm/src/index.ts'),
      '@deepseek-ai/dsh-model-access': resolve(repo, 'packages/llm/model-access/src/index.ts'),
    },
  },
  test: { include: ['tests/**/*.spec.ts'] },
})
