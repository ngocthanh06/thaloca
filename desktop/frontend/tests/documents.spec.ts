import { test, expect } from '@playwright/test'
import { installMockApp } from './mockApp'

const connectedSnapshot = {
  roots: [{ path: '/docs', added_at: new Date().toISOString() }],
  documents: [{ id: 'd1', root: '/docs', path: '/docs/plan.md', relative_path: 'plan.md', name: 'plan.md', file_type: 'md', size: 1024, modified_at: 1, tags: [], index_status: 'indexed', chunk_count: 1 }],
  longbrain: { installed: true, healthy: true, qdrant_healthy: true, llm_available: true, embedding_provider: 'fastembed', embedding_model: 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2', embedding_local: true, llm_provider: 'ollama', llm_model: 'qwen3', llm_local: true, url: 'http://localhost:8800', install_url: 'https://longbrain.cc.cd', message: 'LongBrain connected' },
  scanning: false, scan_cancelled: false,
}

async function openDocuments(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.evaluate(() => document.getElementById('splash-screen')?.remove())
  await page.click('.nav-btn[data-view="documents"]')
}

test('requires LongBrain and exposes its install link', async ({ page }) => {
  await installMockApp(page)
  await openDocuments(page)
  await expect(page.getByText('Install or start LongBrain to use Documents')).toBeVisible()
  await expect(page.getByText('curl -fsSL https://raw.githubusercontent.com/ngocthanh06/longbrain/main/install.sh | bash')).toBeVisible()
  await expect(page.locator('#document-query')).toBeDisabled()
  await expect(page.locator('#document-search-form button[type="submit"]')).toBeDisabled()
  await expect(page.locator('#document-ask')).toBeDisabled()
  await expect(page.locator('#document-add-folder')).toBeDisabled()
  await expect(page.locator('#document-refresh')).toBeDisabled()
  await expect(page.locator('#document-install-longbrain')).toBeVisible()
})

test('keeps local search enabled but blocks Ask AI for Gemini', async ({ page }) => {
  await installMockApp(page)
  await page.addInitScript(snapshot => {
    ;(window as any).__documentSnapshot = { ...snapshot, longbrain: { ...snapshot.longbrain, llm_provider: 'gemini', llm_model: 'models/gemini-2.5-flash', llm_local: false } }
  }, connectedSnapshot)
  await openDocuments(page)
  await expect(page.getByText('Local search ready · Ask AI blocked')).toBeVisible()
  await expect(page.getByText('gemini / models/gemini-2.5-flash')).toBeVisible()
  await expect(page.locator('#document-query')).toBeEnabled()
  await expect(page.locator('#document-search-form button[type="submit"]')).toBeEnabled()
  await expect(page.locator('#document-ask')).toBeDisabled()
  await expect(page.locator('#document-add-folder')).toBeEnabled()
  await expect(page.locator('#document-refresh')).toBeEnabled()
})

test('semantic result shows citation and opens the managed file', async ({ page }) => {
  await installMockApp(page)
  await page.addInitScript(snapshot => {
    ;(window as any).__documentSnapshot = snapshot
    ;(window as any).__documentHits = [{ document_id: 'd1', path: '/docs/plan.md', file_name: 'plan.md', file_type: 'md', chunk_index: 0, line_start: 7, line_end: 9, text: 'The release is scheduled for Friday.', score: .91 }]
  }, connectedSnapshot)
  await openDocuments(page)
  await page.locator('#document-query').fill('release date')
  await page.locator('#document-search-form button[type="submit"]').click()
  await expect(page.getByText('The release is scheduled for Friday.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Lines 7–9' })).toBeVisible()
  await page.getByRole('button', { name: 'Lines 7–9' }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__calls.filter((call: any) => call.name === 'OpenDocument').length)).toBe(1)
})

test('active automatic scan can be cancelled', async ({ page }) => {
  await installMockApp(page)
  await page.addInitScript(snapshot => { ;(window as any).__documentSnapshot = { ...snapshot, scanning: true, scan_progress: { phase: 'indexing', current_file: '/docs/guide.md', discovered: 12, pending: 5, indexed: 2, failed: 0 } } }, connectedSnapshot)
  await openDocuments(page)
  await expect(page.locator('#document-add-folder')).toBeEnabled()
  await expect(page.getByText('Saving document index')).toBeVisible()
  await expect(page.getByText('12 found · 5 to index · 2 indexed')).toBeVisible()
  await expect(page.locator('#document-refresh')).toBeDisabled()
  await page.locator('#document-cancel-scan').click()
  await expect.poll(() => page.evaluate(() => (window as any).__calls.filter((call: any) => call.name === 'CancelDocumentScan').length)).toBe(1)
})

test('search results are concise, highlighted, filterable and paginated', async ({ page }) => {
  await installMockApp(page)
  await page.addInitScript(snapshot => {
    ;(window as any).__documentSnapshot = snapshot
    ;(window as any).__documentHits = Array.from({ length: 12 }, (_, index) => ({
      document_id: `d${index}`, path: `/docs/result-${index}.${index === 11 ? 'pdf' : 'md'}`, file_name: `result-${index}.${index === 11 ? 'pdf' : 'md'}`,
      file_type: index === 11 ? 'pdf' : 'md', chunk_index: index, line_start: 1, line_end: 2,
      text: `${'Background context '.repeat(45)}semantic release answer ${index}${' trailing detail'.repeat(45)}`, score: .9 - index / 100,
    }))
  }, connectedSnapshot)
  await openDocuments(page)
  await page.locator('#document-query').fill('semantic release')
  await page.locator('#document-search-form button[type="submit"]').click()
  await expect(page.locator('.document-result-card')).toHaveCount(8)
  await expect(page.locator('.document-result-snippet').first()).toContainText('semantic release')
  await expect(page.locator('.document-result-snippet').first().locator('mark')).toHaveCount(2)
  expect((await page.locator('.document-result-snippet').first().textContent())?.length).toBeLessThanOrEqual(522)
  await page.locator('[data-document-result-type="pdf"]').click()
  await expect(page.locator('.document-result-card')).toHaveCount(1)
  await expect(page.getByText('result-11.pdf', { exact: true })).toBeVisible()
})

test('large libraries render in batches so controls stay responsive', async ({ page }) => {
  await installMockApp(page)
  await page.addInitScript(snapshot => {
    ;(window as any).__documentSnapshot = {
      ...snapshot,
      documents: Array.from({ length: 250 }, (_, index) => ({
        id: `d${index}`, root: '/docs', path: `/docs/file-${index}.md`, relative_path: `file-${index}.md`, name: `file-${index}.md`,
        file_type: 'md', size: 100, modified_at: 1, tags: [], index_status: 'indexed', chunk_count: 1,
      })),
    }
  }, connectedSnapshot)
  await openDocuments(page)
  await expect(page.locator('.document-folder-group')).toHaveCount(1)
  await expect(page.locator('.document-folder-header')).toContainText('250 files')
  await expect(page.locator('.document-row')).toHaveCount(100)
  await expect(page.locator('#document-load-more')).toContainText('150 remaining')
  const filter = page.locator('#document-list-filter')
  const scan = page.locator('#document-refresh')
  const [filterBox, scanBox] = await Promise.all([filter.boundingBox(), scan.boundingBox()])
  expect(Math.abs((filterBox?.y || 0) - (scanBox?.y || 0))).toBeLessThan(2)
  expect(filterBox?.height).toBe(scanBox?.height)
  await filter.focus()
  await page.evaluate(() => { ;(window as any).__documentFilterNode = document.getElementById('document-list-filter') })
  await filter.fill('file-249')
  await expect(page.locator('.document-folder-hint')).toContainText('matching branches expanded')
  await expect(page.locator('.document-row')).toHaveCount(1)
  await expect(page.getByText('file-249.md', { exact: true })).toBeVisible()
  expect(await page.evaluate(() => ({ sameNode: (window as any).__documentFilterNode === document.getElementById('document-list-filter'), active: document.activeElement?.id, start: (document.activeElement as HTMLInputElement).selectionStart, end: (document.activeElement as HTMLInputElement).selectionEnd }))).toEqual({ sameNode: true, active: 'document-list-filter', start: 8, end: 8 })
})

test('documents render as a nested folder tree with collapsible branches', async ({ page }) => {
  await installMockApp(page)
  await page.addInitScript(snapshot => {
    ;(window as any).__documentSnapshot = {
      ...snapshot,
      documents: [
        { id: 'd1', root: '/docs', path: '/docs/notes/one.md', relative_path: 'notes/one.md', name: 'one.md', file_type: 'md', size: 100, modified_at: 1, tags: [], index_status: 'indexed', chunk_count: 1 },
        { id: 'd2', root: '/docs', path: '/docs/notes/archive/two.md', relative_path: 'notes/archive/two.md', name: 'two.md', file_type: 'md', size: 200, modified_at: 1, tags: [], index_status: 'indexed', chunk_count: 1 },
        { id: 'd3', root: '/reports', path: '/reports/q1.pdf', relative_path: 'q1.pdf', name: 'q1.pdf', file_type: 'pdf', size: 300, modified_at: 1, tags: [], index_status: 'waiting', chunk_count: 0 },
      ],
    }
  }, connectedSnapshot)
  await openDocuments(page)
  await expect(page.locator('.document-folder-hint')).toContainText('2 managed folders')
  await expect(page.locator('.document-folder-group')).toHaveCount(3)
  await expect(page.locator('.document-row')).toHaveCount(1)
  const docs = page.locator('.document-folder-header[data-document-folder="/docs"]')
  await expect(docs).toContainText('2 files')
  const notes = page.locator('.document-folder-header[data-document-folder="/docs/notes"]')
  await expect(notes).toHaveAttribute('aria-expanded', 'false')
  await expect(notes.locator('.document-folder-chevron')).toHaveCSS('transform', 'none')
  await notes.click()
  await expect(notes).toHaveAttribute('aria-expanded', 'true')
  await expect(notes.locator('.document-folder-chevron')).not.toHaveCSS('transform', 'none')
  await expect(page.locator('.document-folder-header[data-document-folder="/docs/notes/archive"]')).toBeVisible()
  await expect(page.locator('.document-row')).toHaveCount(2)
  await expect(page.getByText('one.md', { exact: true })).toBeVisible()
  await expect(page.getByText('two.md', { exact: true })).not.toBeVisible()
  await page.locator('.document-folder-header[data-document-folder="/docs/notes/archive"]').click()
  await expect(page.getByText('two.md', { exact: true })).toBeVisible()
})

test('adding a folder immediately enters automatic scan state', async ({ page }) => {
  await installMockApp(page)
  await page.addInitScript(snapshot => {
    ;(window as any).__documentSnapshot = { ...snapshot, scanning: true, scan_progress: { phase: 'discovering', current_file: '', discovered: 0, pending: 0, indexed: 0, failed: 0 } }
  }, connectedSnapshot)
  await openDocuments(page)
  await page.locator('#document-add-folder').click()
  await expect.poll(() => page.evaluate(() => (window as any).__calls.filter((call: any) => call.name === 'AddDocumentFolder').length)).toBe(1)
  await expect(page.getByText('Discovering files')).toBeVisible()
})
