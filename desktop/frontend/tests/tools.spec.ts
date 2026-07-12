import { test, expect } from '@playwright/test'
import { installMockApp } from './mockApp'

test('Tools labels a version-manager-managed tool instead of offering Install/Update', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()) })

  await installMockApp(page)
  await page.goto('/')
  await page.click('.nav-btn[data-view="tools"]')
  await page.waitForSelector('.tool-card')

  const npmCard = page.locator('.tool-card', { hasText: 'npm' })
  await expect(npmCard).toContainText('Managed by nvm')
  await expect(npmCard.locator('[data-tool-update]')).toHaveCount(0)

  const goCard = page.locator('.tool-card', { hasText: 'Go' })
  await expect(goCard.locator('[data-tool-install]')).toHaveCount(1)

  expect(errors).toEqual([])
})
