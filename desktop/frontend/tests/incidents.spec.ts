import { test, expect } from '@playwright/test'
import { installMockApp } from './mockApp'

test('unassigned incident can open Runtime and does not offer an invalid mute action', async ({ page }) => {
  await installMockApp(page)
  await page.goto('/')
  await page.evaluate(() => {
    const app = (window as any).go.main.App
    app.Snapshot = async () => ({
      services: [], ports: [], jobs: [], projects: [], scanned_at: new Date().toISOString(),
      anomalies: [{ service_id: 'orphan', name: 'orphan-service', project: '', kind: 'down', severity: 'critical', message: 'service is down', since: new Date().toISOString() }],
    })
  })
  await page.locator('.nav-btn[data-view="incidents"]').click()
  const incident = page.locator('.incident-item', { hasText: 'orphan-service' })
  await expect(incident.locator('[data-open-incident-runtime]')).toBeVisible()
  await expect(incident.locator('[data-mute-incident-project]')).toHaveCount(0)
  await incident.locator('[data-open-incident-runtime]').click()
  await expect(page.locator('#runtime-view')).toHaveClass(/active/)
})
