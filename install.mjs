#!/usr/bin/env node
/**
 * Idempotent deployer. Designed to be run by a coding agent as much as by a human:
 * --json gives structured output, every failure has a stable code, and re-running
 * is always safe.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(fileURLToPath(import.meta.url))
const TEAM_BUNDLE = '@deepseek-ai/dsh-experimental-agent-team-profile'
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
  force: flag('force'),
  acceptRisk: flag('accept-risk'),
  workspace: resolve(value('workspace', join(homedir(), 'crew-work'))),
  profile: value('profile', undefined),
  home: process.env.CREW_HOME || join(homedir(), '.dsh', 'crew'),
}

const log = (message) => { if (!options.json) console.log('[crew-install] ' + message) }
const result = { ok: false, code: 'E_UNKNOWN', message: '', app: null, cli: null, profiles: [], workspace: options.workspace, config: null, deploy: null }
const fail = (code, message) => {
  result.ok = false
  result.code = code
  result.message = message
  if (options.json) console.log(JSON.stringify(result, null, 2))
  else console.error('[crew-install] ' + code + ': ' + message)
  const exitCodes = { E_NO_DSH: 2, E_NO_PROFILES: 3, E_INSTALL_FAILED: 4, E_VERIFY_FAILED: 5, E_RISK_REQUIRED: 6 }
  process.exit(exitCodes[code] ?? 1)
}

function findApp() {
  const candidates = [
    '/Applications/DeepSeek Harness.app',
    '/Applications/DSH Desktop.app',
    join(homedir(), 'Applications/DeepSeek Harness.app'),
    join(homedir(), 'Applications/DSH Desktop.app'),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

function findCli(app) {
  const candidates = [
    join(app, 'Contents/Resources/runtime/cli/bin/dsh'),
    join(app, 'Contents/Resources/app/node_modules/@deepseek-ai/dsh/lib/bin.js'),
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

function runCli(cli, cliArgs, timeout = 600000) {
  const node = existsSync(join(dirname(cli), '..', '..', 'bin', 'node')) ? join(dirname(cli), '..', '..', 'bin', 'node') : 'node'
  const command = cli.endsWith('.js') ? node : cli
  const finalArgs = cli.endsWith('.js') ? [cli, ...cliArgs] : cliArgs
  const out = spawnSync(command, finalArgs, { encoding: 'utf8', timeout, env: { ...process.env, DSH_NO_UPDATE_CHECK: '1' } })
  return { status: out.status, stdout: out.stdout ?? '', stderr: out.stderr ?? '', error: out.error }
}

/** The CLI refuses plugins that pin exact dsh internals; it prints the exemption command. */
function riskCommands(text) {
  const out = []
  for (const line of String(text).split('\n')) {
    const match = /dsh: to accept the risk, run:\s*(.+)$/u.exec(line.trim())
    if (match) out.push(match[1].trim().replace(/^dsh\s+/u, ''))
  }
  return [...new Set(out)]
}

/** Match the bundle's major.minor to the running dsh instead of taking the latest dist-tag. */
function teamSpec(cli) {
  if (process.env.CREW_TEAM_SPEC) return process.env.CREW_TEAM_SPEC
  const version = (runCli(cli, ['--version'], 30000).stdout || '').trim()
  const match = /^(\d+)\.(\d+)\./u.exec(version)
  if (!match) return TEAM_BUNDLE
  const view = spawnSync('npm', ['view', TEAM_BUNDLE, 'versions', '--json'], { encoding: 'utf8', timeout: 90000 })
  try {
    const versions = JSON.parse(view.stdout)
    const matching = versions.filter((item) => item.startsWith(match[1] + '.' + match[2] + '.'))
    if (matching.length > 0) return TEAM_BUNDLE + '@' + matching[matching.length - 1]
  } catch { /* offline: fall back to latest */ }
  return TEAM_BUNDLE
}

function profileDirs() {
  const base = join(homedir(), '.dsh', 'profiles')
  if (!existsSync(base)) return []
  return readdirSync(base, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(base, entry.name, 'package.json')))
    .map((entry) => entry.name)
}

function readProfile(name) {
  const file = join(homedir(), '.dsh', 'profiles', name, 'package.json')
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

function bundlesOf(pkg) {
  return (pkg && pkg.dsh && pkg.dsh.profile && pkg.dsh.profile.bundles) || []
}

/** Insert a bundle entry the CLI dropped, keeping dsh-base/dsh-web-app order intact. */
function patchBundleList(name) {
  const file = join(homedir(), '.dsh', 'profiles', name, 'package.json')
  const pkg = JSON.parse(readFileSync(file, 'utf8'))
  const bundles = pkg.dsh.profile.bundles
  if (bundles.includes(TEAM_BUNDLE)) return
  copyFileSync(file, file + '.bak-crew-bundles-' + Date.now())
  const anchor = bundles.indexOf('@deepseek-ai/dsh-web-app')
  bundles.splice(anchor >= 0 ? anchor + 1 : bundles.length, 0, TEAM_BUNDLE)
  writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
}

// ---- 1. locate the host -------------------------------------------------------
const app = findApp()
if (!app) fail('E_NO_DSH', '没找到 DSH：请先安装 https://github.com/deepseek-ai/deepseek-harness 的桌面版')
result.app = app
const cli = findCli(app)
if (!cli) fail('E_NO_DSH', '找到了 App 但找不到 dsh CLI：' + app)
result.cli = cli

// ---- 2. pick profiles ---------------------------------------------------------
const all = profileDirs()
if (all.length === 0) fail('E_NO_PROFILES', '没有任何 profile 目录（~/.dsh/profiles/*），先启动一次 DSH')
const targets = options.profile ? [options.profile] : all
log('profiles: ' + targets.join(', '))

// ---- 3. ensure bundles + install self ----------------------------------------
for (const name of targets) {
  const entry = { name, teamBundle: false, installed: false, verified: false, error: null }
  const pkgFile = join(homedir(), '.dsh', 'profiles', name, 'package.json')
  if (!existsSync(pkgFile)) {
    entry.error = 'profile 不存在'
    result.profiles.push(entry)
    continue
  }
  const pkg = readProfile(name)
  entry.teamBundle = bundlesOf(pkg).includes(TEAM_BUNDLE)

  if (!entry.teamBundle) {
    const spec = teamSpec(cli)
    log(name + ': 补装 Agent Teams bundle（' + spec + '）')
    if (!options.dryRun) {
      let out = runCli(cli, ['plugin', '--profile', name, 'add', spec])
      if (out.status !== 0) {
        const commands = riskCommands((out.stderr || '') + (out.stdout || ''))
        if (commands.length === 0) {
          entry.error = 'Agent Teams bundle 安装失败：' + (out.stderr || out.stdout).slice(-400)
          result.profiles.push(entry)
          fail('E_INSTALL_FAILED', entry.error)
        }
        if (!options.acceptRisk) {
          entry.error = 'Agent Teams bundle 与当前 dsh 的内部版本不完全匹配，需要你明确接受风险'
          result.commands = commands
          result.profiles.push(entry)
          fail('E_RISK_REQUIRED', entry.error + '（加 --accept-risk 重跑即可）')
        }
        for (const command of commands) {
          log('accept risk: ' + command)
          runCli(cli, command.split(/\s+/u))
        }
        out = runCli(cli, ['plugin', '--profile', name, 'add', spec])
        if (out.status !== 0) {
          entry.error = '接受风险后仍然安装失败：' + (out.stderr || out.stdout).slice(-400)
          result.profiles.push(entry)
          fail('E_INSTALL_FAILED', entry.error)
        }
      }
      entry.teamBundle = bundlesOf(readProfile(name)).includes(TEAM_BUNDLE)
    }
  }

  log(name + ': 安装 ' + PKG.name + '@' + PKG.version)
  if (!options.dryRun) {
    copyFileSync(pkgFile, pkgFile + '.bak-crew-' + Date.now())
    const out = runCli(cli, ['plugin', '--profile', name, 'add', REPO])
    if (out.status !== 0) {
      entry.error = '插件安装失败：' + (out.stderr || out.stdout).slice(-400)
      result.profiles.push(entry)
      fail('E_INSTALL_FAILED', entry.error)
    }
    entry.installed = bundlesOf(readProfile(name)).includes(PKG.name)
    // The CLI normalizes dsh.profile.bundles on every invocation and can drop a
    // bundle it has not fully materialised. Verify by reading the file, never by
    // running --dump-config (that would rewrite what we just checked).
    const bundles = bundlesOf(readProfile(name))
    entry.verified = bundles.includes(PKG.name) && bundles.includes(TEAM_BUNDLE)
    if (!entry.verified && !bundles.includes(TEAM_BUNDLE)) {
      log(name + ': 补齐 bundles 记录（CLI 归一化会丢）')
      patchBundleList(name)
      entry.verified = bundlesOf(readProfile(name)).includes(TEAM_BUNDLE)
    }
    if (!entry.verified) {
      entry.error = 'profile 里缺少 bundle 记录，且补齐失败'
      result.profiles.push(entry)
      fail('E_VERIFY_FAILED', entry.error)
    }
  }
  result.profiles.push(entry)
}

// ---- 4. config + deploy record ------------------------------------------------
const configFile = join(options.home, 'config.json')
const existing = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : {}
const config = {
  enabled: true,
  homeWorkspace: options.workspace,
  ...existing,
  ...(options.force ? {} : {}),
  enabledFlagWrittenAt: new Date().toISOString(),
}
delete config.enabledFlagWrittenAt
if (options.workspace && !existing.homeWorkspace) config.homeWorkspace = options.workspace

const deploy = {
  version: PKG.version,
  deployedAt: new Date().toISOString(),
  repo: REPO,
  app,
  profiles: result.profiles.filter((entry) => entry.installed).map((entry) => entry.name),
  workspace: config.homeWorkspace,
  checks: Object.fromEntries(result.profiles.map((entry) => [entry.name, { teamBundle: entry.teamBundle, installed: entry.installed, verified: entry.verified }])),
}

if (!options.dryRun) {
  mkdirSync(options.home, { recursive: true })
  writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n', 'utf8')
  writeFileSync(join(options.home, 'deploy.json'), JSON.stringify(deploy, null, 2) + '\n', 'utf8')
  mkdirSync(config.homeWorkspace, { recursive: true })
}
result.config = config
result.deploy = deploy

// ---- 5. restart (opt-in) ------------------------------------------------------
if (options.restart && !options.dryRun) {
  log('重启 DSH')
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
  log(result.message)
  log('工作区：' + config.homeWorkspace)
  log('重启后进 DSH 说一句「crew_status」验证')
  if (!options.restart) log('（想让它自己重启就加 --restart）')
}
