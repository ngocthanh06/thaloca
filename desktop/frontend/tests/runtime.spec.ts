import { test, expect } from '@playwright/test'
import { installMockApp } from './mockApp'

test('project-level unified logs panel shows combined compose logs', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()) })

  await installMockApp(page)
  await page.goto('/')
  await page.click('.nav-btn[data-view="runtime"]')
  await page.waitForSelector('.project-group-header')

  await page.click('[data-project-logs="shop"]')
  const logs = await page.locator('.project-group pre.job-log').textContent()
  expect(logs).toContain('shop-api-1')
  expect(logs).toContain('shop-worker-1')

  expect(errors).toEqual([])
})

test('Service Inspector shows a Logs toggle for docker services', async ({ page }) => {
  await installMockApp(page)
  await page.goto('/')
  await page.click('.nav-btn[data-view="overview"]')
  await page.waitForSelector('[data-overview-service]')

  await page.click('[data-overview-service="docker:c1"]')
  await page.waitForSelector('#inspector-panel.open')
  await page.click('[data-inspector-logs]')

  const logs = await page.locator('#inspector-panel pre.job-log').textContent()
  expect(logs).toContain('log line for container')
})
