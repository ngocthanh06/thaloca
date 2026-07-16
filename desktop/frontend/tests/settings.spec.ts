import { test, expect } from '@playwright/test'
import { installMockApp } from './mockApp'

test('update results render remote version and errors as text, never HTML', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))

  await installMockApp(page)
  await page.goto('/')
  await page.evaluate(() => {
    const app = (window as any).go.main.App
    app.GetNotificationSettings = async () => ({ enabled: true })
    app.GetAppVersion = async () => '0.1.5'
    app.GetClipboardHistoryEnabled = async () => true
    app.CheckForUpdate = async () => ({
      current_version: '0.1.5',
      latest_version: '<img src=x onerror="window.__updateInjected=true">',
      available: true,
      release_url: 'https://github.com/ngocthanh06/thaloca/releases/latest',
    })
  })

  await page.click('#settings-btn')
  await page.click('[data-settings-check-update]')
  await expect(page.locator('.settings-section').filter({ hasText: 'Updates' })).toContainText('<img src=x')
  expect(await page.evaluate(() => (window as any).__updateInjected === true)).toBe(false)
  await expect(page.locator('.settings-section img')).toHaveCount(0)

  await page.evaluate(() => {
    ;(window as any).go.main.App.CheckForUpdate = async () => ({
      current_version: '0.1.5',
      available: false,
      error: '<img src=x onerror="window.__updateErrorInjected=true">',
    })
  })
  await page.click('[data-settings-check-update]')
  await expect(page.locator('.tool-action-failed')).toContainText('<img src=x')
  expect(await page.evaluate(() => (window as any).__updateErrorInjected === true)).toBe(false)
  await expect(page.locator('.settings-section img')).toHaveCount(0)
  expect(errors).toEqual([])
})
