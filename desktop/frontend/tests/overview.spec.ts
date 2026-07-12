import { test, expect } from '@playwright/test'
import { installMockApp } from './mockApp'

test('Overview shows Runtime/Source Control summaries, anomalies, projects, and recent activity', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()) })

  await installMockApp(page)
  await page.goto('/')
  await page.waitForSelector('.overview-summary-card')

  const summaries = await page.locator('.overview-summary-card p').allTextContents()
  expect(summaries[0]).toContain('containers')
  expect(summaries[1]).toContain('ahead')

  await expect(page.locator('.anomaly-row')).toContainText('shop-worker restarted')
  await expect(page.locator('.overview-card')).toContainText('shop')

  const recentRows = await page.locator('.overview-recent-row').allTextContents()
  expect(recentRows.join('\n')).toContain('Fix payment retry bug')

  expect(errors).toEqual([])
})
