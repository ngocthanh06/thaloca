import { test, expect } from '@playwright/test'
import { installMockApp } from './mockApp'

test('sidebar shows every nav item and Runtime has all 7 subtabs', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()) })

  await installMockApp(page)
  await page.goto('/')
  await page.waitForSelector('.nav-btn')

  const groups = await page.locator('.nav-group').evaluateAll(nodes => nodes.map(node => ({
    label: node.querySelector('.nav-group-title')?.textContent,
    tabs: Array.from(node.querySelectorAll('.nav-btn span')).map(tab => tab.textContent),
  })))
  expect(groups).toEqual([
    { label: 'Workspace', tabs: ['Overview', 'Source Control', 'Documents'] },
    { label: 'Operations', tabs: ['Incidents', 'Runtime', 'Resources', 'Servers', 'Logs', 'Security'] },
    { label: 'Utilities', tabs: ['Tools', 'AI Services', 'Captures'] },
  ])

  for (const view of ['incidents', 'ai-monitor']) {
    await page.click(`.nav-btn[data-view="${view}"]`)
    await expect(page.locator(`#${view}-view`)).toHaveClass(/active/)
  }

  await page.click('.nav-btn[data-view="runtime"]')
  const subtabLabels = await page.locator('#services-subtabs .subtab').allTextContents()
  expect(subtabLabels.map(s => s.replace(/\s+\d+$/, ''))).toEqual(['Containers', 'Processes', 'Ports', 'Jobs', 'Volumes', 'Networks', 'Images'])

  await page.click('#services-subtabs .subtab[data-subtab="jobs"]')
  await expect(page.locator('#subview-jobs')).toHaveClass(/active/)

  await page.click('.nav-btn[data-view="source"]')
  await expect(page.locator('#source-subtabs .subtab')).toHaveText(['Workspace', 'Repositories'])
  await page.click('#source-subtabs .subtab[data-source-subtab="repositories"]')
  await expect(page.locator('#repos-list')).toBeVisible()

  expect(errors).toEqual([])
})

test('container runtime status loads only on Runtime and refreshes once after Stop', async ({ page }) => {
  await installMockApp(page)
  await page.addInitScript(() => {
    ;(window as any).__containerRuntimeStatus = {
      engines: [
        { kind: 'docker-desktop', name: 'Docker Desktop', download_url: 'https://example.com/docker', installed: true, running: true },
        { kind: 'orbstack', name: 'OrbStack', download_url: 'https://example.com/orbstack', installed: false, running: false },
        { kind: 'colima', name: 'Colima', installed: false, running: false },
      ],
      multiple_running: false,
      homebrew_available: false,
    }
  })
  await page.goto('/')
  await page.evaluate(() => {
    document.getElementById('splash-screen')?.remove()
  })

  const statusCallCount = () => page.evaluate(() => (window as any).__calls.filter((call: any) => call.name === 'GetContainerRuntimeStatus').length)
  expect(await statusCallCount()).toBe(0)
  await page.click('.nav-btn[data-view="runtime"]')
  await expect(page.locator('[data-engine-stop="docker-desktop"]')).toBeVisible()
  expect(await statusCallCount()).toBe(1)
  await page.locator('[data-engine-stop="docker-desktop"]').evaluate((button: HTMLButtonElement) => button.click())
  await expect.poll(() => page.evaluate(() => (window as any).__calls.filter((call: any) => call.name === 'StopContainerRuntime').length)).toBe(1)
  await expect.poll(statusCallCount).toBe(2)
})
