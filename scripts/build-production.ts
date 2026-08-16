/** Build and verify every repository-owned production payload. */

import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { resolve } from 'node:path'

interface BuildStep {
  label: string
  cwd: string
  args: string[]
}

const root = resolve(import.meta.dirname, '..')
const packageRunner = process.env.npm_execpath

function run(step: BuildStep): void {
  if (packageRunner === undefined) {
    throw new Error('build-production: invoke this script through `pnpm run build:production`')
  }
  console.log(`build-production: ${step.label}`)
  const result = spawnSync(process.execPath, [packageRunner, ...step.args], {
    cwd: step.cwd,
    env: process.env,
    stdio: 'inherit',
  })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`build-production: ${step.label} failed with exit code ${String(result.status)}`)
  }
}

function requireFile(path: string, failures: string[]): void {
  if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) failures.push(path)
}

function requireAsset(directory: string, suffix: string, failures: string[]): void {
  if (!existsSync(directory) || !readdirSync(directory).some(file => file.endsWith(suffix))) {
    failures.push(`${directory}/*${suffix}`)
  }
}

function verifyArtifacts(): void {
  const failures: string[] = []
  for (const path of [
    'apps/cli/lib/bin.js',
    'apps/web/dist/index.html',
    'gateway/src/index.ts',
    'gateway/public/admin/index.html',
    'gateway/deploy/postgres/migrations/003_project_collaboration.sql',
    'gateway/deploy/postgres/migrations/004_conversation_event_json.sql',
    'gateway/deploy/postgres/migrations/005_user_owned_projects.sql',
    'plugins/dsh-directory-guard/lib/index.js',
    'plugins/dsh-directory-guard/cordis.patch.yml',
    'plugins/dsh-directory-guard/cordis.admin.patch.yml',
    'plugins/dsh-model-governance/lib/index.js',
    'plugins/dsh-model-governance/cordis.patch.yml',
  ]) requireFile(resolve(root, path), failures)
  requireAsset(resolve(root, 'apps/web/dist/assets'), '.js', failures)
  requireAsset(resolve(root, 'apps/web/dist/assets'), '.css', failures)
  requireAsset(resolve(root, 'gateway/public/admin/assets'), '.js', failures)
  requireAsset(resolve(root, 'gateway/public/admin/assets'), '.css', failures)
  if (failures.length > 0) {
    throw new Error(`build-production: missing or empty production payloads:\n${failures.join('\n')}`)
  }
  console.log('build-production: verified Harness, Web, Gateway, Admin UI, and plugin payloads')
}

if (!process.argv.includes('--verify-only')) {
  const steps: BuildStep[] = [
    { label: 'Harness libraries and Web', cwd: root, args: ['run', 'build'] },
    {
      label: 'directory guard plugin',
      cwd: resolve(root, 'plugins/dsh-directory-guard'),
      args: ['run', 'build'],
    },
    {
      label: 'model governance plugin',
      cwd: resolve(root, 'plugins/dsh-model-governance'),
      args: ['run', 'build'],
    },
    { label: 'Gateway typecheck', cwd: resolve(root, 'gateway'), args: ['run', 'typecheck'] },
    { label: 'Admin UI', cwd: resolve(root, 'gateway/admin-ui'), args: ['run', 'build'] },
  ]
  for (const step of steps) run(step)
}

verifyArtifacts()
