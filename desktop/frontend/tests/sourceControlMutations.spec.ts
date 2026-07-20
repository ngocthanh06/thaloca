import { test, expect } from '@playwright/test'
import { installMockApp } from './mockApp'

// These specifically exercise the destructive git operations (stage/unstage/
// commit, branch create/switch/merge/delete) that moved into
// views/sourceControl.ts — the highest-risk part of that extraction, since a
// broken reference here would mean a real user's stage/commit/merge action
// silently does nothing.
test.describe('Source Control mutations reach the right backend call', () => {
  test('staging a file calls StageFile with the right repo and path', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', e => errors.push(e.message))

    await installMockApp(page)
    await page.goto('/')
    await page.click('.nav-btn[data-view="source"]')
    await page.click('.source-repo')
    await page.waitForSelector('[data-stage]')

    await page.click('[data-stage]')
    await page.waitForTimeout(200)

    const calls = await page.evaluate(() => (window as any).__calls)
    const staged = calls.find((c: any) => c.name === 'StageFile')
    expect(staged?.args).toEqual(['/repo/shop-api', 'src/App.tsx'])
    expect(errors).toEqual([])
  })

  test('creating a branch calls CreateBranch with the typed name', async ({ page }) => {
    await installMockApp(page)
    await page.goto('/')
    await page.click('.nav-btn[data-view="source"]')
    await page.click('.source-repo')
    await page.click('[data-repo-tab="branches"]')
    await page.waitForSelector('.branch-toolbar')

    await page.fill('.branch-toolbar input:not(#branch-filter)', 'feature/new-thing')
    await page.click('[data-branch-create]')
    await page.waitForTimeout(200)

    const calls = await page.evaluate(() => (window as any).__calls)
    const created = calls.find((c: any) => c.name === 'CreateBranch')
    expect(created?.args).toEqual(['/repo/shop-api', 'feature/new-thing'])
  })

  test('switching, merging, and deleting a branch call the matching backend method', async ({ page }) => {
    await installMockApp(page)
    await page.goto('/')
    await page.click('.nav-btn[data-view="source"]')
    await page.click('.source-repo')
    await page.click('[data-repo-tab="branches"]')
    await page.waitForSelector('[data-branch-switch]')

    await page.click('[data-branch-switch]')
    await page.waitForTimeout(200)
    await page.click('[data-branch-merge]')
    await page.waitForTimeout(200)
    await page.click('[data-branch-delete]')
    await page.waitForTimeout(200)

    const calls = await page.evaluate(() => (window as any).__calls)
    expect(calls.find((c: any) => c.name === 'SwitchBranch')?.args).toEqual(['/repo/shop-api', 'feature/x'])
    expect(calls.find((c: any) => c.name === 'MergeBranch')?.args).toEqual(['/repo/shop-api', 'feature/x'])
    expect(calls.find((c: any) => c.name === 'DeleteBranch')?.args).toEqual(['/repo/shop-api', 'feature/x'])
  })

  test('release tags can be created, checked out, pushed and deleted', async ({ page }) => {
    await installMockApp(page)
    await page.goto('/')
    await page.click('.nav-btn[data-view="source"]')
    await page.click('.source-repo')
    await page.click('[data-repo-tab="tags"]')
    await page.waitForSelector('[data-tag-create]')

    await page.fill('[data-tag-name]', 'v2.0.0')
    await page.fill('[data-tag-target]', 'main')
    await page.fill('[data-tag-message]', 'Release 2.0.0')
    await page.click('[data-tag-create]')
    await page.waitForTimeout(100)
    await page.click('[data-tag-checkout]')
    await page.click('[data-tag-push]')
    await page.click('[data-tag-delete]')
    await page.click('[data-tag-delete-remote]')
    await page.waitForTimeout(200)

    const calls = await page.evaluate(() => (window as any).__calls)
    expect(calls.find((c: any) => c.name === 'CreateTag')?.args).toEqual(['/repo/shop-api', 'v2.0.0', 'main', 'Release 2.0.0'])
    expect(calls.find((c: any) => c.name === 'CheckoutTag')?.args).toEqual(['/repo/shop-api', 'v1.2.3'])
    expect(calls.find((c: any) => c.name === 'PushTag')?.args).toEqual(['/repo/shop-api', 'v1.2.3'])
    expect(calls.find((c: any) => c.name === 'DeleteTag')?.args).toEqual(['/repo/shop-api', 'v1.2.3'])
    expect(calls.find((c: any) => c.name === 'DeleteRemoteTag')?.args).toEqual(['/repo/shop-api', 'v1.2.3'])
  })
})
