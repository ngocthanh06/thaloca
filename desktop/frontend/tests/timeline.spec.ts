import { test, expect } from '@playwright/test'
import { installMockApp } from './mockApp'

test('Timeline merges runtime/health/action events with git activity, filters by category, and navigates on click', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()) })

  await installMockApp(page)
  await page.goto('/')
  await page.click('.nav-btn[data-view="activity"]')
  await page.waitForSelector('#timeline-list .timeline-row')

  const rows = await page.locator('#timeline-list .timeline-row').allTextContents()
  expect(rows).toHaveLength(4)
  expect(rows.join('\n')).toContain('Container abc restarted')
  expect(rows.join('\n')).toContain('Fix payment retry bug')
  expect(rows.join('\n')).toContain('changed from down to healthy')

  // Old duplicate "Recent Git Events" section must not exist (Timeline supersedes it).
  await expect(page.locator('#events-list')).toHaveCount(0)

  // Clicking a Git row navigates to Source Control.
  await page.click('#timeline-filters .subtab[data-timeline-filter="git"]')
  await page.click('#timeline-list .timeline-row')
  await expect(page.locator('.nav-btn.active span')).toHaveText('Source Control')

  expect(errors).toEqual([])
})
