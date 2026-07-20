import { test, expect } from '@playwright/test'
import { installMockApp } from './mockApp'

test('Image Resize tool loads an image, keeps aspect ratio, resizes and offers download', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()) })

  await installMockApp(page)
  await page.goto('/')
  await page.evaluate(async () => {
    document.getElementById('splash-screen')?.remove()
    document.querySelectorAll('.view, #tools-view .subview').forEach(element => element.classList.remove('active'))
    document.getElementById('tools-view')?.classList.add('active')
    document.getElementById('subview-tools-utilities')?.classList.add('active')
    const utilities = await import('/src/views/utilities.ts')
    utilities.initUtilitiesView()
  })

  await expect(page.locator('.utilities-category', { hasText: 'Images' })).toBeVisible()
  await page.locator('[data-utility-id="image-resize"]').evaluate((element: HTMLElement) => element.click())
  await expect(page.locator('.utilities-detail-title')).toHaveText('Image Resize')
  await expect(page.locator('.utility-image-drop')).toBeVisible()

  const png = await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 200
    canvas.height = 100
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#3a6'
    ctx.fillRect(0, 0, 200, 100)
    return canvas.toDataURL('image/png').split(',')[1]
  })
  await page.locator('.utility-image-file').setInputFiles({
    name: 'sample.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64'),
  })

  await expect(page.locator('.utility-image-info')).toContainText('sample.png — 200 × 100 px')
  await page.locator('.utility-image-width').fill('100')
  await expect(page.locator('.utility-image-height')).toHaveValue('50')
  await page.locator('[data-image-scale="0.5"]').click()
  await expect(page.locator('.utility-image-width')).toHaveValue('100')
  await expect(page.locator('.utility-image-height')).toHaveValue('50')
  await page.locator('.utility-image-resize-btn').click()
  await expect(page.locator('.utility-image-preview')).toBeVisible()
  await expect(page.locator('.utility-image-result-info')).toContainText('100 × 50 px')
  await expect(page.locator('.utility-image-download')).toHaveAttribute('download', 'sample-100x50.png')
  const dims = await page.locator('.utility-image-result').evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight])
  expect(dims).toEqual([100, 50])

  await page.locator('.utility-image-file').setInputFiles({
    name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello'),
  })
  await expect(page.locator('.utility-error')).toContainText('is not an image')
  expect(errors).toEqual([])
})
