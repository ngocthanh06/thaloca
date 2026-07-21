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
  await expect(page.locator('#document-answer-results')).toHaveCount(0)
  await expect(page.locator('#document-add-folder')).toBeDisabled()
  await expect(page.locator('#document-refresh')).toBeDisabled()
  await expect(page.locator('#document-install-longbrain')).toBeVisible()
})

test('keeps search available but defers Answer from passages to a later phase', async ({ page }) => {
  await installMockApp(page)
  await page.addInitScript(snapshot => {
    ;(window as any).__documentSnapshot = { ...snapshot, longbrain: { ...snapshot.longbrain, llm_provider: 'gemini', llm_model: 'models/gemini-2.5-flash', llm_local: false } }
    ;(window as any).__documentHits = [{ document_id: 'd1', path: '/docs/plan.md', file_name: 'plan.md', file_type: 'md', chunk_index: 0, text: 'Local search result.', score: .9 }]
  }, connectedSnapshot)
  await openDocuments(page)
  await expect(page.locator('#document-query')).toBeEnabled()
  await expect(page.locator('#document-search-form button[type="submit"]')).toBeEnabled()
  await page.locator('#document-query').fill('local result')
  await page.locator('#document-search-form button[type="submit"]').click()
  await expect(page.locator('#document-answer-results')).toBeDisabled()
  await expect(page.locator('#document-answer-results')).toHaveAttribute('title', 'Planned for a later phase')
  await expect(page.locator('#document-add-folder')).toBeEnabled()
  await expect(page.locator('#document-refresh')).toBeEnabled()
})

test('Scan settings toggles OCR and unlimited size directly from Documents', async ({ page }) => {
  await installMockApp(page)
  await page.addInitScript(snapshot => { ;(window as any).__documentSnapshot = snapshot }, connectedSnapshot)
  await page.goto('/')
  await page.evaluate(() => document.getElementById('splash-screen')?.remove())
  await page.evaluate(() => {
    const app = (window as any).go.main.App
    app.GetDocumentsOCREnabled = async () => false
    app.GetDocumentsUnlimitedEnabled = async () => false
    app.SetDocumentsOCREnabled = async (enabled: boolean) => { (window as any).__calls.push({ name: 'SetDocumentsOCREnabled', args: [enabled] }) }
    app.SetDocumentsUnlimitedEnabled = async (enabled: boolean) => { (window as any).__calls.push({ name: 'SetDocumentsUnlimitedEnabled', args: [enabled] }) }
  })
  await page.click('.nav-btn[data-view="documents"]')

  await expect(page.locator('#document-scan-settings-root')).not.toHaveClass(/open/)
  await page.click('#document-scan-settings-btn')
  await expect(page.locator('#document-scan-settings-root')).toHaveClass(/open/)
  await expect(page.locator('[data-setting-documents-ocr]')).not.toBeChecked()
  await expect(page.locator('[data-setting-documents-unlimited]')).not.toBeChecked()
  await expect(page.getByText('Some PDFs (like a full-page website screenshot saved as PDF)')).toBeVisible()
  await expect(page.getByText('Removes the default 200 page / 150 slide / 20 MB / 120 chunk automatic indexing caps')).toBeVisible()

  await page.locator('[data-setting-documents-ocr]').check()
  await page.locator('[data-setting-documents-unlimited]').check()

  const calls = await page.evaluate(() => (window as any).__calls)
  expect(calls).toContainEqual({ name: 'SetDocumentsOCREnabled', args: [true] })
  expect(calls).toContainEqual({ name: 'SetDocumentsUnlimitedEnabled', args: [true] })

  await page.click('[data-document-scan-settings-close]')
  await expect(page.locator('#document-scan-settings-root')).not.toHaveClass(/open/)
})

test('managed folder can be given a friendly name without changing its path', async ({ page }) => {
  await installMockApp(page)
  await page.addInitScript(snapshot => { ;(window as any).__documentSnapshot = snapshot }, connectedSnapshot)
  await openDocuments(page)
  await expect(page.locator('.document-root-copy strong')).toHaveText('docs')
  await page.locator('[data-document-rename-root="/docs"]').click()
  const input = page.locator('[data-document-root-name="/docs"]')
  await expect(input).toBeFocused()
  await input.fill('Tài liệu dự án chính')
  await page.locator('.document-root-rename button[type="submit"]').click()
  await expect.poll(() => page.evaluate(() => (window as any).__calls.find((call: any) => call.name === 'RenameDocumentFolder'))).toEqual({ name: 'RenameDocumentFolder', args: ['/docs', 'Tài liệu dự án chính'] })
  await expect(page.locator('.document-root-copy strong')).toHaveText('Tài liệu dự án chính')
  await expect(page.locator('.document-root-copy small')).toHaveText('/docs')
  await page.getByText('Index settings', { exact: true }).click()
  await expect(page.locator('.document-root-policy form')).toBeVisible()
  await expect(page.locator('.document-root-policy select')).toHaveCSS('appearance', 'none')
})

test('semantic result shows citation and opens the managed file', async ({ page }) => {
  await installMockApp(page)
  await page.addInitScript(snapshot => {
    ;(window as any).__documentSnapshot = snapshot
    ;(window as any).__documentHits = [{ document_id: 'd1', path: '/docs/releases/release-date-plan.md', file_name: 'release-date-plan.md', file_type: 'md', chunk_index: 0, line_start: 7, line_end: 9, text: 'The release date is scheduled for Friday.', score: .91 }]
  }, connectedSnapshot)
  await openDocuments(page)
  await page.locator('#document-query').fill('release date')
  await page.locator('#document-search-form button[type="submit"]').click()
  await expect(page.getByText('The release date is scheduled for Friday.')).toBeVisible()
  await expect(page.locator('.document-result-file strong mark')).toHaveCount(2)
  await expect(page.locator('.document-result-file small mark')).toHaveCount(1)
  await expect(page.locator('.document-result-snippet mark')).toHaveText('release date')
  await expect(page.getByRole('button', { name: 'Lines 7–9', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Lines 7–9', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__calls.filter((call: any) => call.name === 'OpenDocument').length)).toBe(1)
})

test('PowerPoint search result cites its slide number', async ({ page }) => {
  await installMockApp(page)
  await page.addInitScript(snapshot => {
    ;(window as any).__documentSnapshot = snapshot
    ;(window as any).__documentHits = [{ document_id: 'deck', path: '/docs/roadmap.pptx', file_name: 'roadmap.pptx', file_type: 'pptx', chunk_index: 0, slide: 7, text: 'Product roadmap milestones.', score: .94 }]
  }, connectedSnapshot)
  await openDocuments(page)
  await page.locator('#document-query').fill('roadmap')
  await page.locator('#document-search-form button[type="submit"]').click()
  await page.getByRole('button', { name: 'Slide 7', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__calls.find((call: any) => call.name === 'PreviewDocument'))).toEqual({ name: 'PreviewDocument', args: ['/docs/roadmap.pptx'] })
  expect(await page.evaluate(() => (window as any).__calls.some((call: any) => call.name === 'OpenDocument'))).toBe(false)
  await page.locator('#document-search-results').getByRole('button', { name: 'Extract text', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__calls.find((call: any) => call.name === 'DocumentPlainText'))).toEqual({ name: 'DocumentPlainText', args: ['/docs/roadmap.pptx'] })
})

test('active automatic scan can be cancelled', async ({ page }) => {
  await installMockApp(page)
  await page.addInitScript(snapshot => { ;(window as any).__documentSnapshot = { ...snapshot, scanning: true, scan_progress: { phase: 'indexing', current_file: '/docs/guide.md', discovered: 12, pending: 5, indexed: 2, failed: 0 } } }, connectedSnapshot)
  await openDocuments(page)
  await expect(page.locator('#document-add-folder')).toBeEnabled()
  await expect(page.getByText('Saving document index')).toBeVisible()
  await expect(page.getByText('12 found · 2/5 processed · 3 remaining')).toBeVisible()
  await expect(page.locator('#document-refresh')).toBeDisabled()
  await page.locator('#document-cancel-scan').click()
  await expect.poll(() => page.evaluate(() => (window as any).__calls.filter((call: any) => call.name === 'CancelDocumentScan').length)).toBe(1)
})

test('indexing status is read-only and retry failed reuses the safe scan path', async ({ page }) => {
  await installMockApp(page)
  await page.addInitScript(snapshot => {
    ;(window as any).__documentSnapshot = {
      ...snapshot,
      documents: [
        ...snapshot.documents,
        { id: 'd2', root: '/docs', path: '/docs/broken.pdf', relative_path: 'broken.pdf', name: 'broken.pdf', file_type: 'pdf', size: 2048, modified_at: 2, tags: [], index_status: 'failed', error: 'temporary embedding timeout', chunk_count: 0 },
      ],
      scan_progress: { phase: 'complete', discovered: 2, pending: 2, indexed: 1, failed: 1, total_chunks: 1, cache_hits: 1, cache_misses: 0, embedding_requests: 0, embedding_ms: 0, elapsed_ms: 1200 },
    }
  }, connectedSnapshot)
  await openDocuments(page)
  await expect(page.locator('.document-index-control')).toBeVisible()
  await expect(page.locator('.document-index-control')).toContainText('1/2 indexed')
  await expect(page.locator('.document-index-safety')).toContainText('Existing indexed data is preserved')
  await expect(page.locator('.document-row-reason.failed')).toContainText('Why failed: temporary embedding timeout')
  await page.locator('#document-retry-failed').click()
  await expect.poll(() => page.evaluate(() => (window as any).__calls.filter((call: any) => call.name === 'RefreshDocuments').length)).toBe(1)
})

test('skipped files can be retried after raising or removing the limit that skipped them', async ({ page }) => {
  await installMockApp(page)
  await page.addInitScript(snapshot => {
    ;(window as any).__documentSnapshot = {
      ...snapshot,
      documents: [{ id: 'large', root: '/docs', path: '/docs/large.pdf', relative_path: 'large.pdf', name: 'large.pdf', file_type: 'pdf', size: 25_000_000, modified_at: 2, tags: [], index_status: 'skipped', error: 'file exceeds the 20 MB automatic indexing limit', chunk_count: 0 }],
    }
  }, connectedSnapshot)
  await openDocuments(page)
  await page.locator('.document-scan-exceptions summary', { hasText: 'skipped files' }).click()
  await expect(page.locator('#document-retry-skipped')).toBeVisible()
  await page.locator('#document-retry-skipped').click()
  await expect.poll(() => page.evaluate(() => (window as any).__calls.filter((call: any) => call.name === 'RefreshDocuments').length)).toBe(1)
})

test('skipped and excluded files show their reasons inline', async ({ page }) => {
  await installMockApp(page)
  await page.addInitScript(snapshot => {
    ;(window as any).__documentSnapshot = {
      ...snapshot,
      documents: [{ id: 'large', root: '/docs', path: '/docs/large.pdf', relative_path: 'large.pdf', name: 'large.pdf', file_type: 'pdf', size: 25_000_000, modified_at: 2, tags: [], index_status: 'skipped', error: 'file exceeds the 20 MB automatic indexing limit', chunk_count: 0 }],
      excluded_paths: ['/docs/private.pptx'],
    }
  }, connectedSnapshot)
  await openDocuments(page)
  await expect(page.locator('.document-row-reason.skipped')).toContainText('Why skipped: file exceeds the 20 MB automatic indexing limit')
  await expect(page.locator('.document-row-reason.skipped')).toHaveAttribute('title', 'file exceeds the 20 MB automatic indexing limit')
  await expect(page.locator('.document-row-copy strong')).toHaveAttribute('title', 'large.pdf')
  await expect(page.locator('.document-scan-exceptions')).toContainText('Why excluded: Manually excluded from automatic scans')
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
  await expect(page.locator('.document-result-snippet').first().locator('mark')).toHaveText('semantic release')
  expect((await page.locator('.document-result-snippet').first().textContent())?.length).toBeLessThanOrEqual(522)
  await page.locator('[data-document-result-type="pdf"]').click()
  await expect(page.locator('.document-result-card')).toHaveCount(1)
  await expect(page.getByText('result-11.pdf', { exact: true })).toBeVisible()
})

test('a long unbroken folder path is clipped instead of stretching the page', async ({ page }) => {
  await installMockApp(page)
  const longPath = '/Users/test/very/deeply/nested/project/docs/architecture/patterns/long-folder-name-that-would-not-wrap-if-left-unclipped/file.md'
  await page.addInitScript((args) => {
    ;(window as any).__documentSnapshot = args.snapshot
    ;(window as any).__documentHits = [{ document_id: 'd1', path: args.longPath, file_name: 'file.md', file_type: 'md', chunk_index: 0, text: 'This mentions an architecture pattern in its content.', score: .9 }]
  }, { snapshot: connectedSnapshot, longPath })
  await openDocuments(page)
  await page.locator('#document-query').fill('architecture pattern')
  await page.locator('#document-search-form button[type="submit"]').click()
  await expect(page.locator('.document-result-folder-path')).toBeVisible()
  const overflowsHorizontally = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
  expect(overflowsHorizontally).toBe(false)
})

test('Ctrl+F opens a browser-style find bar for visible results', async ({ page }) => {
  await installMockApp(page)
  await page.addInitScript(snapshot => {
    ;(window as any).__documentSnapshot = snapshot
    ;(window as any).__documentHits = [{ document_id: 'd1', path: '/docs/plan.md', file_name: 'plan.md', file_type: 'md', chunk_index: 0, text: 'The release plan is ready.', score: .9 }]
  }, connectedSnapshot)
  await openDocuments(page)
  await page.locator('#document-query').fill('release plan')
  await page.locator('#document-search-form button[type="submit"]').click()
  await page.locator('#document-list-filter').focus()
  await page.keyboard.press('Control+f')
  const find = page.locator('#document-result-find-input')
  await expect(find).toBeFocused()
  await find.fill('plan')
  await expect(page.locator('#document-result-find-count')).toHaveText('1/3')
  await page.locator('[data-document-find="next"]').click()
  await expect(page.locator('#document-result-find-count')).toHaveText('2/3')
  await page.keyboard.press('Escape')
  await expect(find).toHaveCount(0)
})

test('Documents renders in Vietnamese and keeps deferred AI action disabled', async ({ page }) => {
  await installMockApp(page)
  await page.addInitScript(snapshot => {
    localStorage.setItem('thaloca-locale', 'vi')
    ;(window as any).__documentSnapshot = snapshot
    ;(window as any).__documentHits = [{ document_id: 'd1', path: '/docs/plan.md', file_name: 'plan.md', file_type: 'md', chunk_index: 0, text: 'Release plan.', score: .9 }]
  }, connectedSnapshot)
  await openDocuments(page)
  await expect(page.getByRole('heading', { name: 'Tìm đúng tệp và đoạn nội dung' })).toBeVisible()
  await expect(page.locator('#document-query')).toHaveAttribute('placeholder', 'Tìm chính xác văn bản hoặc nhập một câu hỏi đầy đủ…')
  await page.locator('#document-query').fill('release')
  await page.locator('#document-search-form button[type="submit"]').click()
  await expect(page.locator('#document-answer-results')).toBeDisabled()
  await expect(page.locator('#document-answer-results')).toContainText('Trả lời từ các đoạn')
  await page.keyboard.press('Control+f')
  await expect(page.locator('#document-result-find-input')).toHaveAttribute('placeholder', 'Tìm trong kết quả…')
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
