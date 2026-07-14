// Timeline view: merges the in-memory runtime/health/action events (from
// App.RecentEvents(), see desktop/timeline.go) with the git commits/hook
// events already loaded for the Activity dashboard, filterable by category.
// Rendering is data-in — no closure over main.ts state, same reasoning as
// views/overview.ts and views/runtime.ts. Row clicks dispatch a CustomEvent
// instead of calling into main.ts directly (the same pattern
// components/serviceInspector.ts already uses for its own refresh
// requests) — main.ts still owns navigation (switchView/loadRepoTab/
// Service Inspector), since those are Runtime/Source Control concerns.
import type { TimelineEvent, ActivitySummary } from '../api'
import { escapeHTML, formatDate, getSourceBadgeClass } from '../dom'
import { t } from '../i18n'

export interface TimelineRow {
  at: string
  category: 'runtime' | 'git' | 'health' | 'action'
  text: string
  targetType?: string
  targetId?: string
}

export type TimelineFilter = 'all' | 'runtime' | 'git' | 'health' | 'action'

export const TIMELINE_NAVIGATE_EVENT = 'thaloca:timeline-navigate'

export function renderTimelineView(events: TimelineEvent[], activity: ActivitySummary | null, filter: TimelineFilter): void {
  const container = document.getElementById('timeline-list')
  if (!container) return

  const rows: TimelineRow[] = [
    ...events.map(e => ({ at: e.at, category: e.category as TimelineRow['category'], text: e.message, targetType: e.target_type, targetId: e.target_id })),
    ...(activity?.commits || []).map(c => ({ at: c.occurred_at, category: 'git' as const, text: `Commit ${c.hash.slice(0, 7)} in ${c.repo_name}: ${c.subject}`, targetType: 'repo', targetId: c.repo_path })),
    ...(activity?.events || []).map(e => ({ at: e.occurred_at, category: 'git' as const, text: `${e.event} in ${e.repo_name}${e.subject ? ': ' + e.subject : ''}`, targetType: 'repo', targetId: e.repo_path })),
  ]
    .filter(r => filter === 'all' || r.category === filter)
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, 50)

  if (rows.length === 0) {
    container.innerHTML = `<div class="empty compact">${t('No activity recorded yet this session.')}</div>`
    return
  }

  container.innerHTML = rows.map((r, i) => `
    <div class="overview-recent-row timeline-row" data-timeline-row="${i}">
      <span class="overview-recent-time">${escapeHTML(formatDate(r.at))}</span>
      <span class="${getSourceBadgeClass(r.category)}">${escapeHTML(r.category.toUpperCase())}</span>
      <span>${escapeHTML(r.text)}</span>
    </div>`).join('')

  container.querySelectorAll<HTMLElement>('[data-timeline-row]').forEach(el => {
    el.addEventListener('click', () => {
      const row = rows[Number(el.dataset.timelineRow)]
      if (row) document.dispatchEvent(new CustomEvent<TimelineRow>(TIMELINE_NAVIGATE_EVENT, { detail: row }))
    })
  })
}
