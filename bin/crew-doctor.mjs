#!/usr/bin/env node
/**
 * Static preflight. Run before or after install; inside DSH also call crew_status,
 * which is the only place runtime state (live Team, home session) can be checked.
 */
import { existsSync, readFileSync, readdirSync, accessSync, constants, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = dirname(fileURLToPath(import.meta.url))
const TEAM_BUNDLE = '@deepseek-ai/dsh-experimental-agent-team-profile'
const PKG = JSON.parse(readFileSync(join(REPO, '..', 'package.json'), 'utf8'))
const HOME = process.env.CREW_HOME || join(homedir(), '.dsh', 'crew')
const json = process.argv.includes('--json')

const checks = []
const add = (name, ok, detail, fix) => checks.push({ name, ok: Boolean(ok), detail, fix: ok ? undefined : fix })

const app = ['/Applications/DeepSeek Harness.app', '/Applications/DSH Desktop.app']
  .find((candidate) => existsSync(candidate))
add('DSH app', app, app ?? '未找到', '先安装 DSH 桌面版')

const cli = app && join(app, 'Contents/Resources/runtime/cli/bin/dsh')
add('dsh CLI', cli && existsSync(cli), cli ?? '未找到', 'App 可能损坏，重装 DSH')

const nodeMajor = Number(process.versions.node.split('.')[0])
add('node >= 20', nodeMajor >= 20, process.versions.node, '用 DSH 自带 node 运行本脚本')

const profilesDir = join(homedir(), '.dsh', 'profiles')
const profiles = existsSync(profilesDir)
  ? readdirSync(profilesDir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && existsSync(join(profilesDir, entry.name, 'package.json'))).map((entry) => entry.name)
  : []
add('profile 存在', profiles.length > 0, profiles.join(', ') || '无', '先启动一次 DSH，让 profile 初始化')

for (const profile of profiles) {
  let pkg
  try { pkg = JSON.parse(readFileSync(join(profilesDir, profile, 'package.json'), 'utf8')) } catch { pkg = undefined }
  const bundles = (pkg?.dsh?.profile?.bundles) ?? []
  add(profile + ': Agent Teams bundle', bundles.includes(TEAM_BUNDLE), bundles.includes(TEAM_BUNDLE) ? '已挂' : '未挂', '跑 ./install.sh')
  add(profile + ': ' + PKG.name, bundles.includes(PKG.name), bundles.includes(PKG.name) ? '已挂' : '未挂', '跑 ./install.sh')
}

const configFile = join(HOME, 'config.json')
const deployFile = join(HOME, 'deploy.json')
add('config.json', existsSync(configFile), configFile, '跑 ./install.sh')
add('deploy.json', existsSync(deployFile), deployFile, '跑 ./install.sh')

let writable = true
try { mkdirSync(HOME, { recursive: true }); accessSync(HOME, constants.W_OK) } catch { writable = false }
add('账本目录可写', writable, HOME, '检查磁盘权限')

const ok = checks.every((check) => check.ok)
if (json) {
  console.log(JSON.stringify({ ok, version: PKG.version, checks, runtimeHint: '重启 DSH 后在对话里调用 crew_status' }, null, 2))
} else {
  for (const check of checks) {
    console.log((check.ok ? '✅' : '❌') + ' ' + check.name + '　' + check.detail + (check.fix ? '　→ ' + check.fix : ''))
  }
  console.log('')
  console.log(ok ? '静态检查全绿。重启 DSH 后在对话里调用 crew_status 看运行层。' : '有检查项失败，按箭头修。')
}
process.exit(ok ? 0 : 1)
