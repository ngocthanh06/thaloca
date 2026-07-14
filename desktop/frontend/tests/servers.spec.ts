import { test, expect } from '@playwright/test'
import { installMockApp } from './mockApp'

test('Servers shows environment tag, key warning, and parsed health summary', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()) })

  await installMockApp(page)
  await page.goto('/')
  await page.click('.nav-btn[data-view="servers"]')
  await page.waitForSelector('.server-row')

  await expect(page.locator('.env-badge')).toHaveText('production')

  // The key permission warning is fetched alongside Check (not on load).
  await page.click('[data-server-check]')
  await page.waitForSelector('.server-status-online')
  await expect(page.locator('.server-key-warning')).toContainText('readable by group/other')
  const row = page.locator('.server-row')
  await expect(row).toContainText('5 days')
  await expect(row).toContainText('48%')
  await expect(row.locator('.server-action-badge')).toHaveText('1')

  expect(errors).toEqual([])
})

test('Servers Fix permissions button clears the key warning', async ({ page }) => {
  await installMockApp(page)
  await page.goto('/')
  await page.click('.nav-btn[data-view="servers"]')
  await page.waitForSelector('.server-row')
  await page.click('[data-server-check]')
  await page.waitForSelector('.server-key-warning')

  await page.click('[data-server-fix-key]')
  await page.waitForSelector('.server-key-warning', { state: 'detached' })

  const calls = await page.evaluate(() => (window as any).__calls)
  expect(calls.some((c: any) => c.name === 'FixServerKeyPermissions' && c.args[0] === 'srv-1')).toBe(true)
})

test('Servers Containers panel lists remote containers with Start/Stop/Restart/Logs', async ({ page }) => {
  await installMockApp(page)
  await page.goto('/')
  await page.click('.nav-btn[data-view="servers"]')
  await page.waitForSelector('.server-row')

  await page.click('[data-server-containers-toggle]')
  await page.waitForSelector('.server-container-row')

  const rows = page.locator('.server-container-row')
  await expect(rows).toHaveCount(2)
  await expect(rows.first()).toContainText('api')
  await expect(rows.first()).toContainText('Up 2 days')

  await page.click('[data-server-container-stop]')
  const calls = await page.evaluate(() => (window as any).__calls)
  expect(calls.some((c: any) => c.name === 'StopServerContainer' && c.args[0] === 'srv-1' && c.args[1] === 'c1')).toBe(true)

  await page.click('[data-server-container-logs]')
  await expect(page.locator('.server-containers pre.tool-action-output')).toContainText('log line for c1')
})
