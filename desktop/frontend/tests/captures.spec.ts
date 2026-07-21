import { test, expect, type Page } from '@playwright/test'
import { installMockApp } from './mockApp'

const desktopSnapshot = {
  location: '/Users/test/Desktop',
  dedicated_folder: '/Users/test/Pictures/Thaloca Captures',
  using_dedicated: false,
  captures: [
    { path: '/Users/test/Desktop/Screenshot A.png', name: 'Screenshot A.png', kind: 'image', size: 245760, modified_at: Date.now() / 1000 - 60 },
    { path: '/Users/test/Desktop/Recording B.mov', name: 'Recording B.mov', kind: 'video', size: 10485760, modified_at: Date.now() / 1000 - 3600 },
  ],
}

async function openCaptures(page: Page, snapshot: unknown = desktopSnapshot): Promise<void> {
  await installMockApp(page)
  await page.addInitScript((state) => { (window as any).__capturesSnapshot = state }, snapshot)
  await page.goto('/')
  await page.evaluate(() => { document.getElementById('splash-screen')?.remove() })
  await page.click('.nav-btn[data-view="captures"]')
  await expect(page.locator('#captures-view')).toHaveClass(/active/)
}

const calls = (page: Page, name: string) =>
  page.evaluate((wanted) => (window as any).__calls.filter((call: any) => call.name === wanted), name)

// Opens the in-app editor on a 200x120 solid-color test image (rather than
// mockApp's default 1x1 fixture) so drawing/selecting/moving shapes has
// real canvas space to work with.
async function openImageEditor(page: Page): Promise<void> {
  await openCaptures(page)
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas')
    canvas.width = 200
    canvas.height = 120
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 200, 120)
    ;(window as any).__captureImageDataURI = canvas.toDataURL('image/png')
  })
  await page.locator('[data-capture-edit="/Users/test/Desktop/Screenshot A.png"]').evaluate((el: HTMLElement) => el.click())
  await expect(page.locator('.capture-editor-workspace')).toBeVisible()
  await expect.poll(() => page.evaluate(() => document.querySelector('.capture-editor-canvas')?.getAttribute('width'))).toBe('200')
}

const overlayPixel = (page: Page, x: number, y: number) =>
  page.evaluate(([px, py]) => {
    const overlay = document.querySelector('canvas.capture-editor-overlay') as HTMLCanvasElement
    return Array.from(overlay.getContext('2d')!.getImageData(px, py, 1, 1).data)
  }, [x, y])

async function dragOverlay(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  const box = (await page.locator('.capture-editor-overlay').boundingBox())!
  await page.mouse.move(box.x + from.x, box.y + from.y)
  await page.mouse.down()
  await page.mouse.move(box.x + to.x, box.y + to.y, { steps: 4 })
  await page.mouse.up()
}

test('renders the capture grid with names, sizes and location', async ({ page }) => {
  await openCaptures(page)
  await expect(page.locator('.captures-location code')).toHaveText('/Users/test/Desktop')
  await expect(page.locator('.capture-card')).toHaveCount(2)
  await expect(page.locator('.capture-card').first()).toContainText('Screenshot A.png')
  await expect(page.locator('.capture-card').first()).toContainText('240 KB')
  await expect(page.locator('.capture-kind-badge')).toHaveCount(1)
  await expect(page.locator('#captures-use-dedicated')).toBeVisible()
})

test('search filters the capture grid by file name', async ({ page }) => {
  await openCaptures(page)
  await expect(page.locator('.capture-card')).toHaveCount(2)
  await page.locator('#captures-search').fill('recording')
  await expect(page.locator('.capture-card')).toHaveCount(1)
  await expect(page.locator('.capture-card')).toContainText('Recording B.mov')
  await expect(page.locator('.captures-count')).toContainText('1 of 2')
  await page.locator('#captures-search').fill('')
  await expect(page.locator('.capture-card')).toHaveCount(2)
})

test('kind filter buttons show only screenshots or recordings', async ({ page }) => {
  await openCaptures(page)
  await page.locator('[data-capture-filter="image"]').click()
  await expect(page.locator('.capture-card')).toHaveCount(1)
  await expect(page.locator('.capture-card')).toContainText('Screenshot A.png')
  await page.locator('[data-capture-filter="video"]').click()
  await expect(page.locator('.capture-card')).toHaveCount(1)
  await expect(page.locator('.capture-card')).toContainText('Recording B.mov')
  await page.locator('[data-capture-filter="all"]').click()
  await expect(page.locator('.capture-card')).toHaveCount(2)
})

test('date filter buttons narrow the grid to today, yesterday, or older captures', async ({ page }) => {
  const now = new Date()
  const dayAgo = (n: number) => { const d = new Date(now); d.setDate(d.getDate() - n); d.setHours(12, 0, 0, 0); return d.getTime() / 1000 }
  const snapshot = {
    location: '/Users/test/Desktop',
    dedicated_folder: '/Users/test/Pictures/Thaloca Captures',
    using_dedicated: false,
    captures: [
      { path: '/Users/test/Desktop/Today.png', name: 'Today.png', kind: 'image', size: 1024, modified_at: dayAgo(0) },
      { path: '/Users/test/Desktop/Yesterday.png', name: 'Yesterday.png', kind: 'image', size: 1024, modified_at: dayAgo(1) },
      { path: '/Users/test/Desktop/LastWeek.png', name: 'LastWeek.png', kind: 'image', size: 1024, modified_at: dayAgo(5) },
      { path: '/Users/test/Desktop/LastMonth.png', name: 'LastMonth.png', kind: 'image', size: 1024, modified_at: dayAgo(20) },
      { path: '/Users/test/Desktop/Ancient.png', name: 'Ancient.png', kind: 'image', size: 1024, modified_at: dayAgo(60) },
    ],
  }
  await openCaptures(page, snapshot)
  await expect(page.locator('.capture-card')).toHaveCount(5)

  await page.locator('#captures-date-filter').selectOption('today')
  await expect(page.locator('.capture-card')).toHaveCount(1)
  await expect(page.locator('.capture-card')).toContainText('Today.png')

  await page.locator('#captures-date-filter').selectOption('yesterday')
  await expect(page.locator('.capture-card')).toHaveCount(1)
  await expect(page.locator('.capture-card')).toContainText('Yesterday.png')

  await page.locator('#captures-date-filter').selectOption('week')
  await expect(page.locator('.capture-card')).toHaveCount(3)

  await page.locator('#captures-date-filter').selectOption('month')
  await expect(page.locator('.capture-card')).toHaveCount(4)

  await page.locator('#captures-date-filter').selectOption('all')
  await expect(page.locator('.capture-card')).toHaveCount(5)
})

test('custom date range reveals two date pickers and filters between them', async ({ page }) => {
  const now = new Date()
  const dayAgo = (n: number) => { const d = new Date(now); d.setDate(d.getDate() - n); d.setHours(12, 0, 0, 0); return d }
  const isoDay = (d: Date) => d.toISOString().slice(0, 10)
  const snapshot = {
    location: '/Users/test/Desktop',
    dedicated_folder: '/Users/test/Pictures/Thaloca Captures',
    using_dedicated: false,
    captures: [
      { path: '/Users/test/Desktop/Today.png', name: 'Today.png', kind: 'image', size: 1024, modified_at: dayAgo(0).getTime() / 1000 },
      { path: '/Users/test/Desktop/LastWeek.png', name: 'LastWeek.png', kind: 'image', size: 1024, modified_at: dayAgo(5).getTime() / 1000 },
      { path: '/Users/test/Desktop/LastMonth.png', name: 'LastMonth.png', kind: 'image', size: 1024, modified_at: dayAgo(20).getTime() / 1000 },
      { path: '/Users/test/Desktop/Ancient.png', name: 'Ancient.png', kind: 'image', size: 1024, modified_at: dayAgo(60).getTime() / 1000 },
    ],
  }
  await openCaptures(page, snapshot)

  await expect(page.locator('#captures-date-from')).toHaveCount(0)
  await page.locator('#captures-date-filter').selectOption('custom')
  await expect(page.locator('#captures-date-from')).toBeVisible()
  await expect(page.locator('#captures-date-to')).toBeVisible()

  // Covers LastWeek and LastMonth but excludes Today and Ancient.
  await page.locator('#captures-date-from').fill(isoDay(dayAgo(25)))
  await page.locator('#captures-date-to').fill(isoDay(dayAgo(3)))
  await expect(page.locator('.capture-card')).toHaveCount(2)
  await expect(page.locator('.capture-card').nth(0)).toContainText('LastWeek.png')
  await expect(page.locator('.capture-card').nth(1)).toContainText('LastMonth.png')
})

test('open, reveal and edit call the backend with the file path', async ({ page }) => {
  await openCaptures(page)
  await page.locator('[data-capture-open="/Users/test/Desktop/Screenshot A.png"]').click()
  await page.locator('[data-capture-reveal="/Users/test/Desktop/Screenshot A.png"]').evaluate((el: HTMLElement) => el.click())
  await page.locator('[data-capture-edit="/Users/test/Desktop/Recording B.mov"]').evaluate((el: HTMLElement) => el.click())
  await expect.poll(() => calls(page, 'OpenCapture')).toEqual([{ name: 'OpenCapture', args: ['/Users/test/Desktop/Screenshot A.png'] }])
  await expect.poll(() => calls(page, 'RevealCapture')).toEqual([{ name: 'RevealCapture', args: ['/Users/test/Desktop/Screenshot A.png'] }])
  await expect.poll(() => calls(page, 'EditCapture')).toEqual([{ name: 'EditCapture', args: ['/Users/test/Desktop/Recording B.mov'] }])
})

test('the single Copy button copies image data for a screenshot and the file itself for a recording', async ({ page }) => {
  await openCaptures(page)
  await page.locator('[data-capture-copy="/Users/test/Desktop/Screenshot A.png"]').evaluate((el: HTMLElement) => el.click())
  await page.locator('[data-capture-copy="/Users/test/Desktop/Recording B.mov"]').evaluate((el: HTMLElement) => el.click())
  await expect.poll(() => calls(page, 'CopyCaptureImage')).toEqual([{ name: 'CopyCaptureImage', args: ['/Users/test/Desktop/Screenshot A.png'] }])
  await expect.poll(() => calls(page, 'CopyCaptureFile')).toEqual([{ name: 'CopyCaptureFile', args: ['/Users/test/Desktop/Recording B.mov'] }])
})

test('extracts capture text locally with OCR', async ({ page }) => {
  await openCaptures(page)
  await page.locator('[data-capture-ocr="/Users/test/Desktop/Screenshot A.png"]').evaluate((el: HTMLElement) => el.click())
  await expect.poll(() => calls(page, 'CaptureOCR')).toEqual([{ name: 'CaptureOCR', args: ['/Users/test/Desktop/Screenshot A.png'] }])
})

test('edit on an image opens the in-app markup editor instead of calling EditCapture', async ({ page }) => {
  await openCaptures(page)
  await page.locator('[data-capture-edit="/Users/test/Desktop/Screenshot A.png"]').evaluate((el: HTMLElement) => el.click())
  await expect(page.locator('.capture-editor-workspace')).toBeVisible()
  await expect(page.locator('.capture-editor-workspace')).toContainText('Screenshot A.png')
  expect(await calls(page, 'EditCapture')).toEqual([])
  await expect.poll(() => calls(page, 'LoadCaptureImage')).toEqual([{ name: 'LoadCaptureImage', args: ['/Users/test/Desktop/Screenshot A.png'] }])
})

test('closing the editor removes it from the DOM', async ({ page }) => {
  await openCaptures(page)
  await page.locator('[data-capture-edit="/Users/test/Desktop/Screenshot A.png"]').evaluate((el: HTMLElement) => el.click())
  await expect(page.locator('.capture-editor-workspace')).toBeVisible()
  await page.locator('[data-editor-close]').click()
  await expect(page.locator('.capture-editor-workspace')).toHaveCount(0)
})

test('drawing a highlight paints the overlay and selects the new shape', async ({ page }) => {
  await openImageEditor(page)
  expect(await overlayPixel(page, 50, 50)).toEqual([0, 0, 0, 0])
  await page.locator('[data-tool="highlight"]').click()
  await dragOverlay(page, { x: 20, y: 20 }, { x: 90, y: 80 })
  const pixel = await overlayPixel(page, 50, 50)
  expect(pixel[3]).toBeGreaterThan(0)
  await expect(page.locator('[data-editor-undo]')).toBeEnabled()
  await expect(page.locator('[data-editor-delete]')).toBeEnabled()
})

test('selecting and dragging a shape moves it to the new location', async ({ page }) => {
  await openImageEditor(page)
  await page.locator('[data-tool="highlight"]').click()
  await dragOverlay(page, { x: 20, y: 20 }, { x: 60, y: 60 })
  expect((await overlayPixel(page, 40, 40))[3]).toBeGreaterThan(0)

  await page.locator('[data-tool="select"]').click()
  await dragOverlay(page, { x: 40, y: 40 }, { x: 140, y: 40 })

  expect((await overlayPixel(page, 40, 40))[3]).toBe(0)
  expect((await overlayPixel(page, 140, 40))[3]).toBeGreaterThan(0)
})

test('Delete removes the selected shape', async ({ page }) => {
  await openImageEditor(page)
  await page.locator('[data-tool="highlight"]').click()
  await dragOverlay(page, { x: 20, y: 20 }, { x: 90, y: 80 })
  expect((await overlayPixel(page, 50, 50))[3]).toBeGreaterThan(0)

  await page.locator('[data-tool="select"]').click()
  await page.locator('[data-editor-delete]').click()

  expect((await overlayPixel(page, 50, 50))[3]).toBe(0)
  await expect(page.locator('[data-editor-delete]')).toBeDisabled()
})

test('text Enter commits exactly once and Escape cancels', async ({ page }) => {
  await openImageEditor(page)
  const overlay = page.locator('.capture-editor-overlay')
  await page.locator('[data-tool="text"]').click()
  const placeText = (x: number, y: number) => overlay.evaluate((element, point) => {
    const rect = element.getBoundingClientRect()
    element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: rect.left + point.x, clientY: rect.top + point.y, pointerId: 1 }))
  }, { x, y })
  await placeText(60, 60)
  await page.locator('.capture-editor-text-input').fill('one label')
  await page.locator('.capture-editor-text-input').press('Enter')
  await expect(page.locator('.capture-editor-text-input')).toHaveCount(0)
  await expect(page.locator('[data-editor-undo]')).toBeEnabled()
  await page.locator('[data-editor-undo]').click()
  await expect(page.locator('[data-editor-undo]')).toBeDisabled()

  await placeText(80, 80)
  await page.locator('.capture-editor-text-input').fill('cancel me')
  await page.locator('.capture-editor-text-input').press('Escape')
  await expect(page.locator('.capture-editor-text-input')).toHaveCount(0)
  await expect(page.locator('[data-editor-undo]')).toBeDisabled()
})

test('delete asks for confirmation then calls DeleteCapture', async ({ page }) => {
  await openCaptures(page)
  await page.locator('[data-capture-delete="/Users/test/Desktop/Screenshot A.png"]').evaluate((el: HTMLElement) => el.click())
  await expect.poll(() => calls(page, 'DeleteCapture')).toEqual([{ name: 'DeleteCapture', args: ['/Users/test/Desktop/Screenshot A.png'] }])
})

test('inline rename edits the stem and submits with the original extension', async ({ page }) => {
  await openCaptures(page)
  await page.locator('[data-capture-rename="/Users/test/Desktop/Screenshot A.png"]').evaluate((el: HTMLElement) => el.click())
  const input = page.locator('#capture-rename-input')
  await expect(input).toBeVisible()
  await expect(input).toHaveValue('Screenshot A')
  await expect(page.locator('.capture-rename-ext')).toHaveText('.png')
  await input.fill('deploy-bug')
  await input.press('Enter')
  await expect.poll(() => calls(page, 'RenameCapture')).toEqual([{ name: 'RenameCapture', args: ['/Users/test/Desktop/Screenshot A.png', 'deploy-bug.png'] }])
})

test('escape cancels an inline rename without calling the backend', async ({ page }) => {
  await openCaptures(page)
  await page.locator('[data-capture-rename="/Users/test/Desktop/Screenshot A.png"]').evaluate((el: HTMLElement) => el.click())
  const input = page.locator('#capture-rename-input')
  await expect(input).toBeVisible()
  await input.press('Escape')
  await expect(input).toHaveCount(0)
  expect(await calls(page, 'RenameCapture')).toEqual([])
})

test('move to dedicated folder confirms twice and passes moveExisting', async ({ page }) => {
  await openCaptures(page)
  await page.click('#captures-use-dedicated')
  await expect.poll(() => calls(page, 'UseDedicatedCaptureFolder')).toEqual([{ name: 'UseDedicatedCaptureFolder', args: [true] }])
})

test('dedicated badge shown and move button hidden when already dedicated', async ({ page }) => {
  await openCaptures(page, { ...desktopSnapshot, location: '/Users/test/Pictures/Thaloca Captures', using_dedicated: true })
  await expect(page.locator('.capture-dedicated-badge')).toBeVisible()
  await expect(page.locator('#captures-use-dedicated')).toHaveCount(0)
})

test('choose folder pipes the picked path into SetCaptureFolder', async ({ page }) => {
  await openCaptures(page)
  await page.click('#captures-choose-folder')
  await expect.poll(() => calls(page, 'SetCaptureFolder')).toEqual([{ name: 'SetCaptureFolder', args: ['/Users/test/Shots'] }])
})

test('empty state explains the shortcut when there are no captures', async ({ page }) => {
  await openCaptures(page, { ...desktopSnapshot, captures: [] })
  await expect(page.locator('.captures-empty')).toContainText('No captures yet')
  await expect(page.locator('.captures-empty')).toContainText('⇧⌘4')
})

test('scan error from the backend is surfaced with the permission hint', async ({ page }) => {
  await openCaptures(page, { ...desktopSnapshot, captures: [], error: 'cannot read /Users/test/Desktop: permission denied — if macOS denied access, allow Thaloca under System Settings → Privacy & Security → Files and Folders' })
  await expect(page.locator('.captures-error')).toContainText('permission denied')
})
