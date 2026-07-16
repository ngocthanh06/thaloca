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

test('Update now confirms and invokes the native self-update binding', async ({ page }) => {
  await installMockApp(page)
  await page.goto('/')
  await page.evaluate(() => {
    const app = (window as any).go.main.App
    app.GetNotificationSettings = async () => ({ enabled: true })
    app.GetAppVersion = async () => '0.1.5'
    app.GetClipboardHistoryEnabled = async () => true
    app.CheckForUpdate = async () => ({
      current_version: '0.1.5', latest_version: '0.1.6', available: true,
      release_url: 'https://github.com/ngocthanh06/thaloca/releases/tag/v0.1.6',
    })
    app.Confirm = async (title: string, message: string) => {
      ;(window as any).__calls.push({ name: 'Confirm', args: [title, message] })
      return true
    }
    app.PerformSelfUpdate = async (version: string) => {
      ;(window as any).__calls.push({ name: 'PerformSelfUpdate', args: [version] })
    }
  })

  await page.click('#settings-btn')
  await page.click('[data-settings-check-update]')
  await expect(page.locator('[data-settings-self-update]')).toHaveText('Update now')
  await page.click('[data-settings-self-update]')

  const calls = await page.evaluate(() => (window as any).__calls)
  expect(calls.some((call: any) => call.name === 'Confirm' && call.args[1].includes('0.1.6'))).toBe(true)
  expect(calls.some((call: any) => call.name === 'PerformSelfUpdate' && call.args[0] === '0.1.6')).toBe(true)
})
