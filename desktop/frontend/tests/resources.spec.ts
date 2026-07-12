import { test, expect } from '@playwright/test'
import { installMockApp } from './mockApp'

test('Resources process table has a Stop action and sortable CPU/Mem/PID headers', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()) })

  await installMockApp(page)
  await page.goto('/')
  await page.click('.nav-btn[data-view="resources"]')
  await page.waitForSelector('.process-row')

  await expect(page.locator('[data-stop-pid="100"]')).toHaveCount(1)

  await page.click('[data-resource-sort="pid"]')
  await page.waitForSelector('.process-sort-header.active')
  await expect(page.locator('.process-sort-header.active')).toContainText('PID')

  await page.click('[data-stop-pid="100"]')
  const calls = await page.evaluate(() => (window as any).__calls)
  expect(calls.some((c: any) => c.name === 'StopProcess' && c.args[0] === 100)).toBe(true)

  expect(errors).toEqual([])
})

test('Resources Applications section lists installed apps with live usage, above Disks', async ({ page }) => {
  await installMockApp(page)
  await page.goto('/')
  await page.click('.nav-btn[data-view="resources"]')
  await page.waitForSelector('.process-row')

  const titles = await page.locator('h3.section-title').allTextContents()
  expect(titles.indexOf('Applications')).toBeGreaterThanOrEqual(0)
  expect(titles.indexOf('Applications')).toBeLessThan(titles.indexOf('Disks'))

  const section = page.locator('h3.section-title', { hasText: 'Applications' }).locator('xpath=following-sibling::div[1]')
  await expect(section).toContainText('Visual Studio Code')
  await expect(section).toContainText('CPU')
  await expect(section).toContainText('Slack')
  await expect(section).toContainText('Not running')
})

test('Resources Applications Open/Quit buttons call the right backend method', async ({ page }) => {
  await installMockApp(page)
  await page.goto('/')
  await page.click('.nav-btn[data-view="resources"]')
  await page.waitForSelector('.process-row')

  await page.click('[data-quit-app]')
  await page.click('[data-open-app]')

  const calls = await page.evaluate(() => (window as any).__calls)
  expect(calls.some((c: any) => c.name === 'QuitInstalledApp' && c.args[0] === 'com.microsoft.VSCode')).toBe(true)
  expect(calls.some((c: any) => c.name === 'OpenInstalledApp' && c.args[0] === '/Applications/Slack.app')).toBe(true)
})
