import { test, expect } from '@playwright/test'
import { installMockApp } from './mockApp'

test('AI Monitor renders local service state without invoking an AI scan', async ({ page }) => {
  await installMockApp(page)
  await page.goto('/')
  await page.locator('.nav-btn[data-view="ai-monitor"]').click()
  await expect(page.locator('#ai-monitor-content')).toContainText('AI Services')
  await expect(page.locator('#ai-monitor-content')).toContainText('LongBrain')
  await expect(page.locator('#ai-monitor-content')).toContainText('Local, read-only monitoring')
})

test('keyboard shortcut helpers reject bare keys and normalize modified keys', async ({ page }) => {
  await installMockApp(page)
  await page.goto('/')
  const result = await page.evaluate(async () => {
    const shortcuts = await import('/src/keyboardShortcuts.ts')
    return {
      bare: shortcuts.comboFromEvent(new KeyboardEvent('keydown', { key: 'k' })),
      modified: shortcuts.comboFromEvent(new KeyboardEvent('keydown', { key: 'K', metaKey: true, shiftKey: true })),
      formatted: shortcuts.formatCombo('meta+shift+k'),
    }
  })
  expect(result).toEqual({ bare: null, modified: 'meta+shift+k', formatted: '⌘+⇧+K' })
})

test('fast tooltip exposes a complete title on hover', async ({ page }) => {
  await installMockApp(page)
  await page.goto('/')
  await page.waitForSelector('.nav-btn')
  await page.waitForTimeout(50)
  await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<button id="target" title="Complete information">Short label</button>'))
  await page.evaluate(async () => (await import('/src/components/fastTooltip.ts')).initFastTooltips())
  await page.locator('#target').hover()
  await expect(page.locator('.fast-tooltip')).toHaveText('Complete information')
  await expect(page.locator('#target')).not.toHaveAttribute('title')
})
