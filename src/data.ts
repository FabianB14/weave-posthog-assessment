import type { DataManifest, MonthShard, PullRequestRecord } from './types'

const loadedMonths = new Map<string, MonthShard>()
const base = import.meta.env.BASE_URL

export async function loadManifest(): Promise<DataManifest> {
  const response = await fetch(`${base}data/manifest.json`, { cache: 'no-store' })
  if (!response.ok) throw new Error(`Unable to load data manifest (${response.status})`)
  return response.json()
}

export function monthsInRange(from: string, to: string): string[] {
  const start = new Date(`${from}T00:00:00Z`)
  const end = new Date(`${to}T00:00:00Z`)
  const cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1))
  const result: string[] = []
  while (cursor <= end) {
    result.push(`${cursor.getUTCFullYear()}-${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`)
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }
  return result
}

export async function loadRange(from: string, to: string, available: string[]): Promise<{ prs: PullRequestRecord[]; fetched: string[] }> {
  const needed = monthsInRange(from, to).filter((month) => available.includes(month))
  const missing = needed.filter((month) => !loadedMonths.has(month))

  await Promise.all(
    missing.map(async (month) => {
      const response = await fetch(`${base}data/months/${month}.json`)
      if (!response.ok) throw new Error(`Unable to load ${month} (${response.status})`)
      loadedMonths.set(month, await response.json())
    }),
  )

  const fromTime = new Date(`${from}T00:00:00Z`).getTime()
  const toTime = new Date(`${to}T23:59:59Z`).getTime()
  const prs = needed
    .flatMap((month) => loadedMonths.get(month)?.prs ?? [])
    .filter((pr) => {
      const merged = new Date(pr.mergedAt).getTime()
      return merged >= fromTime && merged <= toTime
    })

  return { prs, fetched: missing }
}
