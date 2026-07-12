import { test, expect } from '@playwright/test'
import { installMockApp } from './mockApp'

test('Source Control repo detail tabs (Changes/History/Branches/Files) load real content', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()) })

  await installMockApp(page)
  await page.goto('/')
  await page.click('.nav-btn[data-view="source"]')
  await page.waitForSelector('.source-repo')

  await page.click('.source-repo')
  await page.waitForSelector('.repo-detail-tabs')
  await expect(page.locator('#source-detail')).toContainText('App.tsx')

  await page.click('[data-repo-tab="history"]')
  await expect(page.locator('#source-detail')).toContainText('Fix payment retry bug')

  await page.click('[data-repo-tab="branches"]')
  await expect(page.locator('#source-detail')).toContainText('feature/x')

  await page.click('[data-repo-tab="files"]')
  await expect(page.locator('#source-detail')).toContainText('src')

  expect(errors).toEqual([])
})
