import { test, expect } from '@playwright/test'
import { installMockApp } from './mockApp'

test('Overview is an actionable command center for health, attention and projects', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()) })

  await installMockApp(page)
  await page.goto('/')
  await page.waitForSelector('.overview-command-center')
  await expect(page.locator('.overview-health-ring')).toHaveCount(0)
  await expect(page.locator('.overview-command-center')).toContainText('Runtime needs attention')
  await expect(page.locator('.overview-status-signals button')).toHaveCount(3)
  await expect(page.locator('.overview-workspace-tabs button')).toHaveCount(5)
  await expect(page.locator('.overview-expected-select').first()).toHaveCSS('appearance', 'none')
  await page.getByText('+ Custom workspace', { exact: true }).click()
  await expect(page.locator('#overview-workspace-form')).toBeVisible()
  await expect(page.locator('#overview-workspace-form input[type="checkbox"]').first()).toHaveCSS('accent-color', /rgb/)
  await page.getByText('+ Custom workspace', { exact: true }).click()
  await expect(page.locator('.overview-grid')).toHaveClass(/overview-grid-compact/)
  await expect(page.locator('.overview-service-row')).toHaveCount(0)
  const cardLayout = await page.locator('.overview-card').evaluateAll(cards => cards.map(card => {
    const bounds = card.getBoundingClientRect()
    const controls = [...card.querySelectorAll<HTMLElement>('.overview-expected-select, .repo-action')]
    return {
      cardWidth: bounds.width,
      controlsInside: controls.every(control => {
        const rect = control.getBoundingClientRect()
        return rect.left >= bounds.left && rect.right <= bounds.right
      }),
    }
  }))
  expect(cardLayout.every(card => card.cardWidth >= 245 && card.controlsInside)).toBe(true)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  await page.locator('.overview-more').first().click()
  await expect(page.locator('.overview-service-row').first()).toBeVisible()
  await page.getByRole('button', { name: 'Detailed' }).click()
  await expect(page.locator('.overview-grid')).toHaveClass(/overview-grid-detailed/)

  await expect(page.locator('.anomaly-row')).toContainText('shop-worker restarted')
  await expect(page.locator('.overview-card')).toContainText('shop')

  await page.locator('[data-overview-nav="documents"]').click()
  await expect(page.locator('#documents-view')).toHaveClass(/active/)

  expect(errors).toEqual([])
})
