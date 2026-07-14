import { test, expect } from '@playwright/test'
import { installMockApp } from './mockApp'

test('Tools labels a version-manager-managed tool instead of offering Install/Update', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', e => errors.push(e.message))
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()) })

  await installMockApp(page)
  await page.goto('/')
  await page.click('.nav-btn[data-view="tools"]')
  await page.waitForSelector('.tool-card')

  const npmCard = page.locator('.tool-card', { hasText: 'npm' })
  await expect(npmCard).toContainText('Managed by nvm')
  await expect(npmCard.locator('[data-tool-update]')).toHaveCount(0)

  const goCard = page.locator('.tool-card', { hasText: 'Go' })
  await expect(goCard.locator('[data-tool-install]')).toHaveCount(1)

  expect(errors).toEqual([])
})

test('Markdown Preview renders a resizable document workspace with developer controls', async ({ page }) => {
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
  await page.locator('[data-utility-id="markdown-preview"]').evaluate((element: HTMLElement) => element.click())

  const workspace = page.locator('.markdown-workspace')
  await expect(workspace).toBeVisible()
  await expect(workspace).toHaveClass(/modal/)
  await expect(page.locator('.markdown-modal-backdrop')).toBeVisible()
  await expect(workspace.locator('.markdown-splitter')).toHaveAttribute('role', 'separator')
  await expect(workspace.locator('.markdown-line-numbers')).toHaveText('1')

  await workspace.locator('.markdown-source').fill(`# Preview\n\n> Useful note\n\n- [x] Complete\n\n| Tool | Status |\n| --- | --- |\n| Preview | Ready |\n\n\`\`\`ts\nconst ready = true\n\`\`\`\n\n\`\`\`mermaid\nflowchart LR\n  A[Write] --> B[Preview]\n\`\`\``)

  await expect(workspace.locator('.markdown-document h1')).toHaveText('Preview')
  await expect(workspace.locator('.task-list-item input')).toBeChecked()
  await expect(workspace.locator('table')).toContainText('Ready')
  await expect(workspace.locator('.markdown-code-header')).toContainText('ts')
  await expect(workspace.locator('.mermaid svg')).toBeVisible()
  await expect(workspace.locator('[data-stat="words"]')).not.toHaveText('0')
  await expect(workspace.locator('.markdown-line-numbers')).toContainText('12')

  await workspace.locator('[data-mode="light"]').click()
  await expect(workspace).toHaveAttribute('data-preview-mode', 'light')
  await expect(workspace.locator('.markdown-zoom-value')).toHaveText('110%')
  await workspace.locator('[data-zoom="in"]').click()
  await expect(workspace.locator('.markdown-zoom-value')).toHaveText('120%')
  for (let index = 0; index < 8; index++) await workspace.locator('[data-zoom="in"]').click()
  await expect(workspace.locator('.markdown-zoom-value')).toHaveText('200%')
  const contentFitsPaper = await workspace.locator('.markdown-document').evaluate(documentElement => {
    const content = documentElement.querySelector<HTMLElement>('.markdown-document-content')!
    return content.getBoundingClientRect().right <= documentElement.getBoundingClientRect().right + 1
  })
  expect(contentFitsPaper).toBe(true)

  await workspace.locator('[data-zoom="reset"]').click()
  const mermaidWidthAt100 = await workspace.locator('.mermaid svg').evaluate(svg => svg.getBoundingClientRect().width)
  await expect(workspace.locator('[data-mermaid-zoom]')).toHaveCount(0)
  await workspace.locator('.mermaid').dispatchEvent('wheel', { ctrlKey: true, deltaY: -40 })
  await expect(workspace.locator('.markdown-mermaid-zoom-indicator')).toBeVisible()
  await page.waitForTimeout(180)
  const mermaidWidthAfterPinch = await workspace.locator('.mermaid svg').evaluate(svg => svg.getBoundingClientRect().width)
  expect(mermaidWidthAfterPinch).toBeGreaterThan(mermaidWidthAt100 * 1.4)
  await workspace.locator('.markdown-close').click()
  await expect(workspace).toHaveCount(0)

  await page.locator('[data-utility-id="markdown-preview"]').evaluate((element: HTMLElement) => element.click())
  await expect(page.locator('.markdown-source')).toHaveValue(/# Preview/)
  await expect(page.locator('.markdown-zoom-value')).toHaveText('100%')
  await page.locator('.markdown-close').click()

  await page.locator('[data-utility-id="base64"]').evaluate((element: HTMLElement) => element.click())
  await expect(page.locator('.utility-tool-modal')).toBeVisible()
  await expect(page.locator('.utility-modal-header')).toContainText('Base64 Encode/Decode')
  await expect(page.locator('.utility-tool-modal .utility-bidirectional')).toBeVisible()
  await page.locator('.utility-tool-modal .utility-pane-left').fill('hello')
  await page.locator('.utility-tool-modal .utility-to-right').click()
  await expect(page.locator('.utility-tool-modal .utility-pane-right')).toHaveValue('aGVsbG8=')
  await page.locator('.utility-tool-modal .utility-modal-close').click()
  await expect(page.locator('.utility-modal-launcher')).toBeVisible()
  await page.locator('.utility-modal-reopen').click()
  await expect(page.locator('.utility-tool-modal')).toBeVisible()
  await expect(page.locator('.utility-tool-modal .utility-pane-left')).toHaveValue('hello')
  await expect(page.locator('.utility-tool-modal .utility-pane-right')).toHaveValue('aGVsbG8=')
  await page.locator('.utility-tool-modal .utility-modal-close').click()

  await page.locator('[data-utility-id="case-converter"]').evaluate((element: HTMLElement) => element.click())
  await expect(page.locator('.case-converter-panel')).toBeVisible()
  await page.locator('.case-source-input').fill('{"user_id":1052,"contact":{"phone_number":null}}')
  await expect(page.locator('.case-input-kind')).toHaveText('JSON keys · values preserved')
  await expect(page.locator('.case-variant-output')).toContainText('"userId": 1052')
  await page.locator('[data-case-variant="snake"]').click()
  await expect(page.locator('.case-variant-output')).toContainText('"phone_number": null')
  await page.locator('.utility-tool-modal .utility-modal-close').click()

  await page.locator('[data-utility-id="json-format"]').evaluate((element: HTMLElement) => element.click())
  await page.locator('.utility-input-field textarea').fill('{"ready":true,"count":2}')
  await page.locator('.utility-run-btn').click()
  await expect(page.locator('.utility-output-field .utility-generated-output')).toContainText('"ready": true')
  await expect(page.locator('.utility-output-field textarea[readonly]')).toHaveCount(0)

})

test('Text Diff clearly distinguishes original and modified lines', async ({ page }) => {
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

  await page.locator('[data-utility-id="text-diff"]').evaluate((element: HTMLElement) => element.click())
  const textDiff = page.locator('.utility-tool-modal[data-tool-id="text-diff"]')
  await expect(textDiff).toBeVisible()
  await expect(textDiff.locator('.utility-pane-label')).toHaveText(['Original (A)', 'Modified (B)'])
  await textDiff.locator('.utility-input-a').fill('same\nremoved line\nend')
  await textDiff.locator('.utility-input-b').fill('same\nadded line\nend')
  await textDiff.locator('.utility-run-btn').click()
  await expect(textDiff.locator('.utility-diff-summary')).toContainText('Original A → Modified B')
  await expect(textDiff.locator('.utility-diff-stats .removed')).toHaveText('−1 removed')
  await expect(textDiff.locator('.utility-diff-stats .added')).toHaveText('+1 added')
  await expect(textDiff.locator('.diff-del')).toContainText('−2removed line')
  await expect(textDiff.locator('.diff-add')).toContainText('+2added line')
  await expect(textDiff.locator('.utility-diff-legend')).toContainText('Only in Original (A)')
})

test('JSON and env comparisons use structured added removed and changed rows', async ({ page }) => {
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

  await page.locator('[data-utility-id="json-compare"]').evaluate((element: HTMLElement) => element.click())
  const jsonCompare = page.locator('.utility-tool-modal[data-tool-id="json-compare"]')
  await expect(jsonCompare.locator('.utility-pane-label')).toHaveText(['Original JSON (A)', 'Modified JSON (B)'])
  await jsonCompare.locator('.utility-input-a').fill('{"same":1,"removed":2,"changed":"old"}')
  await jsonCompare.locator('.utility-input-b').fill('{"same":1,"added":3,"changed":"new"}')
  await jsonCompare.locator('.utility-run-btn').click()
  await expect(jsonCompare.locator('.utility-diff-stats .removed')).toHaveText('−1 removed')
  await expect(jsonCompare.locator('.utility-diff-stats .changed')).toHaveText('1 changed')
  await expect(jsonCompare.locator('.utility-diff-stats .added')).toHaveText('+1 added')
  await expect(jsonCompare.locator('.diff-kind')).toHaveText(['Removed', 'Changed', 'Added'])
  await jsonCompare.locator('.utility-modal-close').click()

  await page.locator('[data-utility-id="env-compare"]').evaluate((element: HTMLElement) => element.click())
  const envCompare = page.locator('.utility-tool-modal[data-tool-id="env-compare"]')
  await expect(envCompare.locator('.utility-pane-label')).toHaveText(['Original .env (A)', 'Modified .env (B)'])
  await envCompare.locator('.utility-input-a').fill('SAME=1\nOLD=gone\nAPI_TOKEN=alpha-private')
  await envCompare.locator('.utility-input-b').fill('SAME=1\nNEW=here\nAPI_TOKEN=beta-private')
  await envCompare.locator('.utility-run-btn').click()
  const envOutput = envCompare.locator('.utility-html-output')
  await expect(envOutput.locator('.diff-kind')).toHaveText(['Changed', 'Added', 'Removed'])
  await expect(envOutput).toContainText('value differs — hidden')
  await expect(envOutput).not.toContainText('alpha-private')
  await expect(envOutput).not.toContainText('beta-private')
})

test('plain utility output stays plain and modal behavior follows category', async ({ page }) => {
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

  await page.locator('[data-utility-id="uuid-v4"]').evaluate((element: HTMLElement) => element.click())
  await expect(page.locator('.utility-tool-modal')).toHaveCount(0)
  await expect(page.locator('.utility-generator-panel')).toBeVisible()

  await page.locator('[data-utility-id="cidr-calculator"]').evaluate((element: HTMLElement) => element.click())
  const cidr = page.locator('.utility-tool-modal[data-tool-id="cidr-calculator"]')
  await expect(cidr).toBeVisible()
  await cidr.locator('.utility-input-field textarea').fill('192.168.1.10/24')
  const output = cidr.locator('.utility-generated-output')
  await expect(output).toContainText('Network Address: 192.168.1.0')
  await expect(output.locator('[class^="tok-"]')).toHaveCount(0)

  await page.locator('[data-utility-id="case-converter"]').evaluate((element: HTMLElement) => element.click())
  const caseConverter = page.locator('.utility-tool-modal[data-tool-id="case-converter"]')
  await caseConverter.locator('.case-source-input').fill('true')
  await expect(caseConverter.locator('.case-input-kind')).toHaveText('Plain text')
  await expect(caseConverter.locator('.case-variant-output')).toHaveText('true')
  await expect(caseConverter.locator('.case-variant-output [class^="tok-"]')).toHaveCount(0)
  await caseConverter.locator('.case-source-input').fill('{"enabled":true}')
  await expect(caseConverter.locator('.case-input-kind')).toHaveText('JSON keys · values preserved')
  await expect(caseConverter.locator('.case-variant-output .tok-keyword')).toHaveText('true')

  await page.locator('[data-utility-id="regex-tester"]').evaluate((element: HTMLElement) => element.click())
  const regex = page.locator('.utility-tool-modal[data-tool-id="regex-tester"]')
  await regex.locator('.utility-regex-pattern').fill('true|false')
  await regex.locator('.utility-regex-text').fill('true false')
  await regex.locator('.utility-run-btn').click()
  await expect(regex.locator('.utility-regex-output')).toContainText('true')
  await expect(regex.locator('.utility-regex-output [class^="tok-"]')).toHaveCount(0)
})

test('Markdown Preview cleans up global shortcuts and ignores editable targets', async ({ page }) => {
  await installMockApp(page)
  await page.goto('/')
  await page.evaluate(async () => {
    document.getElementById('splash-screen')?.remove()
    document.querySelectorAll('.view, #tools-view .subview').forEach(element => element.classList.remove('active'))
    document.getElementById('tools-view')?.classList.add('active')
    document.getElementById('subview-tools-utilities')?.classList.add('active')
    const originalAdd = document.addEventListener.bind(document)
    const originalRemove = document.removeEventListener.bind(document)
    ;(window as any).__markdownKeydownAdds = 0
    ;(window as any).__markdownKeydownRemoves = 0
    document.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
      if (type === 'keydown') (window as any).__markdownKeydownAdds++
      originalAdd(type, listener, options)
    }) as typeof document.addEventListener
    document.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
      if (type === 'keydown') (window as any).__markdownKeydownRemoves++
      originalRemove(type, listener, options)
    }) as typeof document.removeEventListener
    const utilities = await import('/src/views/utilities.ts')
    utilities.initUtilitiesView()
  })

  await page.locator('[data-utility-id="markdown-preview"]').evaluate((element: HTMLElement) => element.click())
  const workspace = page.locator('.markdown-workspace')
  await workspace.locator('[data-zoom="reset"]').click()
  await expect(workspace.locator('.markdown-zoom-value')).toHaveText('100%')
  await workspace.locator('.markdown-source').focus()
  await workspace.locator('.markdown-source').dispatchEvent('keydown', { ctrlKey: true, key: '+' })
  await expect(workspace.locator('.markdown-zoom-value')).toHaveText('100%')
  await page.evaluate(() => document.dispatchEvent(new KeyboardEvent('keydown', { ctrlKey: true, key: '+' })))
  await expect(workspace.locator('.markdown-zoom-value')).toHaveText('110%')

  await page.locator('[data-utility-id="uuid-v4"]').evaluate((element: HTMLElement) => element.click())
  await expect(workspace).toHaveCount(0)
  const listenerCounts = await page.evaluate(() => ({
    added: (window as any).__markdownKeydownAdds,
    removed: (window as any).__markdownKeydownRemoves,
  }))
  expect(listenerCounts).toEqual({ added: 1, removed: 1 })
})

test('utility tool modals clean up their global Escape listener when switching tools', async ({ page }) => {
  await installMockApp(page)
  await page.goto('/')
  await page.evaluate(async () => {
    document.getElementById('splash-screen')?.remove()
    document.querySelectorAll('.view, #tools-view .subview').forEach(element => element.classList.remove('active'))
    document.getElementById('tools-view')?.classList.add('active')
    document.getElementById('subview-tools-utilities')?.classList.add('active')
    const originalAdd = document.addEventListener.bind(document)
    const originalRemove = document.removeEventListener.bind(document)
    ;(window as any).__utilityKeydownAdds = 0
    ;(window as any).__utilityKeydownRemoves = 0
    document.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
      if (type === 'keydown') (window as any).__utilityKeydownAdds++
      originalAdd(type, listener, options)
    }) as typeof document.addEventListener
    document.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
      if (type === 'keydown') (window as any).__utilityKeydownRemoves++
      originalRemove(type, listener, options)
    }) as typeof document.removeEventListener
    const utilities = await import('/src/views/utilities.ts')
    utilities.initUtilitiesView()
  })

  await page.locator('[data-utility-id="base64"]').evaluate((element: HTMLElement) => element.click())
  await expect(page.locator('.utility-tool-modal[data-tool-id="base64"]')).toBeVisible()
  await page.locator('[data-utility-id="uuid-v4"]').evaluate((element: HTMLElement) => element.click())
  await expect(page.locator('.utility-tool-modal')).toHaveCount(0)

  const listenerCounts = await page.evaluate(() => ({
    added: (window as any).__utilityKeydownAdds,
    removed: (window as any).__utilityKeydownRemoves,
  }))
  expect(listenerCounts).toEqual({ added: 1, removed: 1 })
})
