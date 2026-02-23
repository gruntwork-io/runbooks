// ============================================================================
// Recent Runbooks Persistence
// Stores recent runbooks to ~/.runbooks-desktop/recent.json
// ============================================================================

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import type { RecentRunbook } from '../shared/types'

const CONFIG_DIR = path.join(os.homedir(), '.runbooks-desktop')
const RECENT_FILE = path.join(CONFIG_DIR, 'recent.json')
const MAX_RECENT = 20

function ensureConfigDir(): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true })
  }
}

export function getRecentRunbooks(): RecentRunbook[] {
  try {
    if (!fs.existsSync(RECENT_FILE)) return []
    const data = fs.readFileSync(RECENT_FILE, 'utf-8')
    return JSON.parse(data) as RecentRunbook[]
  } catch {
    return []
  }
}

export function addRecentRunbook(runbook: RecentRunbook): RecentRunbook[] {
  ensureConfigDir()

  let recent = getRecentRunbooks()

  // Remove if already exists (will re-add at top)
  recent = recent.filter((r) => r.path !== runbook.path)

  // Add to top
  recent.unshift({
    ...runbook,
    lastUsed: new Date().toISOString(),
  })

  // Trim to max
  recent = recent.slice(0, MAX_RECENT)

  fs.writeFileSync(RECENT_FILE, JSON.stringify(recent, null, 2))
  return recent
}
