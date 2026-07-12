import { test, expect } from '@playwright/test'
import { installMockApp } from './mockApp'

test('sidebar shows the 7-item nav and Runtime has all 4 subtabs', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()) })

  await installMockApp(page)
  await page.goto('/')
  await page.waitForSelector('.nav-btn')

  const navLabels = await page.locator('.nav-btn span').allTextContents()
  expect(navLabels).toEqual(['Overview', 'Runtime', 'Source Control', 'Activity', 'Resources', 'Tools', 'Servers'])

  await page.click('.nav-btn[data-view="runtime"]')
  const subtabLabels = await page.locator('#services-subtabs .subtab').allTextContents()
  expect(subtabLabels.map(s => s.replace(/\s+\d+$/, ''))).toEqual(['Containers', 'Processes', 'Ports', 'Jobs'])

  await page.click('#services-subtabs .subtab[data-subtab="jobs"]')
  await expect(page.locator('#subview-jobs')).toHaveClass(/active/)

  expect(errors).toEqual([])
})
