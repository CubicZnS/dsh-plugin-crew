/**
 * Deployment config. The installer writes ~/.dsh/crew/config.json; the plugin
 * reads it at load. Everything is optional so a bare install still degrades safely.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULTS } from './plan.js'

export const CONFIG_FILE = 'config.json'
export const DEPLOY_FILE = 'deploy.json'

export const DEFAULT_OFF_PEAK = { enabled: true, start: '00:30', end: '08:30', tz: 'Asia/Shanghai' }

export function dataDirFor(home = homedir()) {
  return process.env.CREW_HOME || join(home, '.dsh', 'crew')
}

export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

export function loadConfig({ home = homedir(), file } = {}) {
  const dir = dataDirFor(home)
  return readJson(file ?? join(dir, CONFIG_FILE)) ?? {}
}

export function loadDeployment({ home = homedir(), file } = {}) {
  const dir = dataDirFor(home)
  return readJson(file ?? join(dir, DEPLOY_FILE))
}

/** Explicit plugin config wins over the file; both win over defaults. */
export function resolveConfig(explicit = {}, file = {}) {
  return {
    ...DEFAULTS,
    offPeak: { ...DEFAULT_OFF_PEAK, ...(file.offPeak ?? {}) },
    ...file,
    ...explicit,
    offPeak: { ...DEFAULT_OFF_PEAK, ...(file.offPeak ?? {}), ...(explicit.offPeak ?? {}) },
  }
}

export function deploymentSummary(deployment) {
  if (!deployment) return { deployed: false }
  return {
    deployed: true,
    version: deployment.version,
    deployedAt: deployment.deployedAt,
    profiles: deployment.profiles ?? [],
    checks: deployment.checks ?? {},
  }
}
