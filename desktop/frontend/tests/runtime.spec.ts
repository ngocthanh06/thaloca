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

test('container row shows disk usage once ContainerSize resolves', async ({ page }) => {
  await installMockApp(page)
  await page.goto('/')
  await page.click('.nav-btn[data-view="runtime"]')
  await page.waitForSelector('.project-group-header')
  // Typing a search query force-expands matching project groups (same as
  // renderDockerProjects's `expanded = expandedProjects.has(project) ||
  // Boolean(ctx.searchQuery)`), which is a more reliable way to reveal a
  // specific container row than toggling the group open.
  await page.fill('#search-input', 'shop-api')

  await expect(page.locator('.container-row', { hasText: 'shop-api' }).locator('.container-size')).toHaveText('1.2MB (virtual 245MB)')
})

test('container size loading limits Docker requests to four at a time', async ({ page }) => {
  await installMockApp(page)
  await page.goto('/')
  const peak = await page.evaluate(async () => {
    let active = 0
    let highest = 0
    ;(window as any).go.main.App.ContainerSize = async () => {
      active++
      highest = Math.max(highest, active)
      await new Promise(resolve => setTimeout(resolve, 20))
      active--
      return '1MB'
    }
    const { loadContainerSizes } = await import('/src/views/runtime.ts')
    const services = Array.from({ length: 12 }, (_, index) => ({
      id: `docker:${index}`, name: `service-${index}`, source: 'docker', status: 'running',
      ports: [], pid: 0, container_id: `container-${index}`, repo_path: '', command: '', labels: {},
    }))
    await loadContainerSizes(services as any, new Map())
    return highest
  })
  expect(peak).toBe(4)
})

test('Service Inspector shows a Logs toggle for docker services', async ({ page }) => {
  await installMockApp(page)
  await page.goto('/')
  await page.click('.nav-btn[data-view="overview"]')
  await page.locator('.overview-more').first().click()
  await page.waitForSelector('[data-overview-service]')

  await page.click('[data-overview-service="docker:c1"]')
  await page.waitForSelector('#inspector-panel.open')
  await page.click('[data-inspector-logs]')

  const logs = await page.locator('#inspector-panel pre.job-log').textContent()
  expect(logs).toContain('log line for container')
})
