#!/usr/bin/env node
/**
 * Idempotent deployer, designed to be driven by a coding agent as much as a human.
 * --json gives structured output, every failure has a stable code, re-running is safe.
 *
 * 0.4.0: installs only this plugin. No experimental Agent Teams bundle, so no
 * version-risk exemptions are ever needed.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(fileURLToPath(import.meta.url))
const PKG = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))

const args = process.argv.slice(2)
const flag = (name) => args.includes('--' + name)
const value = (name, fallback) => {
  const index = args.indexOf('--' + name)
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : fallback
}

const options = {
  json: flag('json'),
  dryRun: flag('dry-run'),
  restart: flag('restart'),
  profile: value('profile', undefined),
  home: process.env.CREW_HOME || join(homedir(), '.dsh', 'crew'),
}

const result = { ok: false, code: 'E_UNKNOWN', message: '', app: null, cli: null, version: PKG.version, profiles: [], config: null, deploy: null }
const out = (message) => { if (!options.json) console.log('[crew-install] ' + message) }
const EXIT = { E_NO_DSH: 2, E_NO_PROFILES: 3, E_INSTALL_FAILED: 4, E_VERIFY_FAILED: 5 }
const fail = (code, message) => {
  result.ok = false
  result.code = code
  result.message = message
  if (options.json) console.log(JSON.stringify(result, null, 2))
  else console.error('[crew-install] ' + code + ': ' + message)
  process.exit(EXIT[code] ?? 1)
}

function findApp() {
  return [
    '/Applications/DeepSeek Harness.app',
    '/Applications/DSH Desktop.app',
    join(homedir(), 'Applications/DeepSeek Harness.app'),
    join(homedir(), 'Applications/DSH Desktop.app'),
  ].find((candidate) => existsSync(candidate))
}

function findCli(app) {
  return [
    join(app, 'Contents/Resources/runtime/cli/bin/dsh'),
    join(app, 'Contents/App/node_modules/@deepseek-ai/dsh/lib/bin.js'),
  ].find((candidate) => existsSync(candidate))
}

function runCli(cli, cliArgs, timeout = 600000) {
  const isScript = cli.endsWith('.js')
  const command = isScript ? 'node' : cli
  const finalArgs = isScript ? [cli, ...cliArgs] : cliArgs
  const spawn = spawnSync(command, finalArgs, { encoding: 'utf8', timeout, env: { ...process.env, DSH_NO_UPDATE_CHECK: '1' } })
  return { status: spawn.status, stdout: spawn.stdout ?? '', stderr: spawn.stderr ?? '' }
}

function profileDirs() {
  const base = join(homedir(), '.dsh', 'profiles')
  if (!existsSync(base)) return []
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(base, entry.name, 'package.json')))
    .map((entry) => entry.name)
}

const profileFile = (name) => join(homedir(), '.dsh', 'profiles', name, 'package.json')
const readProfile = (name) => {
  try { return JSON.parse(readFileSync(profileFile(name), 'utf8')) } catch { return undefined }
}
const bundlesOf = (pkg) => (pkg?.dsh?.profile?.bundles) ?? []

/** The dsh CLI normalises dsh.profile.bundles and can drop an entry we just added. */
function repairBundles(name) {
  const pkg = readProfile(name)
  if (!pkg || bundlesOf(pkg).includes(PKG.name)) return true
  copyFileSync(profileFile(name), profileFile(name) + '.bak-crew-' + Date.now())
  pkg.dsh.profile.bundles.push(PKG.name)
  writeFileSync(profileFile(name), JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  return bundlesOf(readProfile(name)).includes(PKG.name)
}

const app = findApp()
if (!app) fail('E_NO_DSH', '没找到 DSH：先安装 DeepSeek Harness 桌面版')
result.app = app
const cli = findCli(app)
if (!cli) fail('E_NO_DSH', '找到了 App 但找不到 dsh CLI：' + app)
result.cli = cli

const all = profileDirs()
if (all.length === 0) fail('E_NO_PROFILES', '没有 profile（~/.dsh/profiles/*），先启动一次 DSH')
const targets = options.profile ? [options.profile] : all
out('profiles: ' + targets.join(', ') + (options.dryRun ? '（dry-run）' : ''))

for (const name of targets) {
  const entry = { name, installed: false, bundleRegistered: false, error: null }
  if (!existsSync(profileFile(name))) {
    entry.error = 'profile 不存在'
    result.profiles.push(entry)
    continue
  }
  const already = bundlesOf(readProfile(name)).includes(PKG.name)
  if (!already) {
    out(name + ': 安装 ' + PKG.name + '@' + PKG.version)
    if (!options.dryRun) {
      const added = runCli(cli, ['plugin', '--profile', name, 'add', REPO])
      if (added.status !== 0) {
        entry.error = '安装失败：' + (added.stderr || added.stdout).slice(-400)
        result.profiles.push(entry)
        fail('E_INSTALL_FAILED', entry.error)
      }
    }
  }
  entry.installed = true
  entry.bundleRegistered = options.dryRun ? true : repairBundles(name)
  if (!entry.bundleRegistered) {
    entry.error = 'profile 里缺少 bundle 记录，且补齐失败'
    result.profiles.push(entry)
    fail('E_VERIFY_FAILED', entry.error)
  }
  result.profiles.push(entry)
}

const configFile = join(options.home, 'config.json')
const existing = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : {}
const config = { enabled: true, ...existing }

const deploy = {
  version: PKG.version,
  deployedAt: new Date().toISOString(),
  repo: REPO,
  app,
  profiles: result.profiles.filter((entry) => entry.installed).map((entry) => entry.name),
  checks: Object.fromEntries(result.profiles.map((entry) => [entry.name, { installed: entry.installed, bundleRegistered: entry.bundleRegistered }])),
}

if (!options.dryRun) {
  mkdirSync(options.home, { recursive: true })
  writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n', 'utf8')
  writeFileSync(join(options.home, 'deploy.json'), JSON.stringify(deploy, null, 2) + '\n', 'utf8')
}
result.config = config
result.deploy = deploy

if (options.restart && !options.dryRun) {
  out('重启 DSH')
  const name = app.includes('DSH Desktop') ? 'DSH Desktop' : 'DeepSeek Harness'
  spawnSync('osascript', ['-e', 'tell application "' + name + '" to quit'], { encoding: 'utf8' })
  spawnSync('sleep', ['2'])
  spawnSync('open', ['-a', name])
}

result.ok = true
result.code = options.dryRun ? 'OK_DRY_RUN' : 'OK'
result.message = options.dryRun ? 'dry-run：只做探测，没有改动' : '已安装，重启 DSH 后生效'
if (options.json) console.log(JSON.stringify(result, null, 2))
else {
  out(result.message)
  if (!options.restart) out('重启后进 DSH 说「crew_status」验证（或加 --restart 让它自己重启）')
}
