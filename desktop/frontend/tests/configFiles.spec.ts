import { test, expect } from '@playwright/test'
import { installMockApp } from './mockApp'

test('cancelling a config file disable keeps its toggle enabled', async ({ page }) => {
  await installMockApp(page)
  await page.goto('/')
  await page.evaluate(() => {
    const app = (window as any).go.main.App
    app.ListConfigFiles = async () => ([{
      id: 'shell:test',
      category: 'shell',
      name: 'test-config.zsh',
      path: '/tmp/test-config.zsh',
      source_name: '.zshrc',
      description: 'Test config',
      enabled: true,
      toggleable: true,
    }])
    app.Confirm = async () => false
    app.ToggleConfigFile = async (path: string) => {
      ;(window as any).__calls.push({ name: 'ToggleConfigFile', args: [path] })
      return false
    }
  })

  await page.click('.nav-btn[data-view="tools"]')
  await page.click('#tools-subtabs .subtab[data-tools-subtab="config-files"]')

  const toggle = page.locator('[data-config-toggle="shell:test"]')
  await expect(toggle).toBeChecked()
  await toggle.click()

  await expect(toggle).toBeChecked()
  expect(await page.evaluate(() => (window as any).__calls.filter((call: any) => call.name === 'ToggleConfigFile'))).toEqual([])
})
