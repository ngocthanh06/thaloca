import { api, type DocumentAnswer, type DocumentScanProgress, type DocumentSearchHit, type DocumentSnapshot, type ProductPreferences } from '../api'
import { escapeHTML, formatBytes, showError } from '../dom'
import { copyToClipboard } from '../clipboard'
import { BrowserOpenURL, EventsOn } from '../../wailsjs/runtime/runtime'
import { LOCALE_CHANGE_EVENT, t } from '../i18n'

const longbrainInstallCommand = 'curl -fsSL https://raw.githubusercontent.com/ngocthanh06/longbrain/main/install.sh | bash'

let snapshot: DocumentSnapshot | null = null
let documentPreferences: ProductPreferences = { expected_projects: {}, workspaces: [], document_policies: {} }
let results: DocumentSearchHit[] = []
let answer: DocumentAnswer | null = null
let busy: 'search' | 'ask' | 'refresh' | 'cancel' | '' = ''
let initialized = false
let documentFilter = ''
let documentVisibleLimit = 100
const documentFolderExpansion = new Map<string, boolean>()
let searchQuery = ''
let lastQuery = ''
let searchMode: 'exact' | 'semantic' = 'exact'
let lastSearchMode: 'exact' | 'semantic' = 'exact'
let resultVisibleLimit = 8
let resultFileType = 'all'
let installCommandCopied = false
let scanStartedAt = 0
let scanInitialProcessed = 0
let resultFindOpen = false
let resultFindQuery = ''
let resultFindIndex = 0
let editingRootPath = ''
let editingRootName = ''
let ocrEnabled = false
let unlimitedEnabled = false

function scanETA(progress: DocumentScanProgress): string {
  const processed = progress.indexed + progress.failed
  if (!scanStartedAt || processed <= scanInitialProcessed) return ''
  const elapsedSeconds = (Date.now() - scanStartedAt) / 1000
  const completed = processed - scanInitialProcessed
  if (elapsedSeconds < 2 || completed < 1) return ''
  const remaining = Math.max(0, progress.pending - processed)
  const seconds = Math.ceil(remaining / (completed / elapsedSeconds))
  if (!Number.isFinite(seconds) || seconds <= 0) return remaining === 0 ? t('finishing') : ''
  if (seconds < 60) return `~${seconds}s ${t('left')}`
  if (seconds < 3600) return `~${Math.ceil(seconds / 60)}m ${t('left')}`
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.ceil((seconds % 3600) / 60)
  return `~${hours}h ${minutes}m ${t('left')}`
}

function compactDuration(milliseconds = 0): string {
  if (milliseconds < 1000) return `${milliseconds}ms`
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)}s`
  return `${Math.floor(milliseconds / 60_000)}m ${Math.round(milliseconds % 60_000 / 1000)}s`
}

function lastScanSummary(state: DocumentSnapshot): string {
  const progress = state.scan_progress
  if (!progress || state.scanning || !progress.elapsed_ms) return ''
  return ` · ${progress.total_chunks || 0} ${t('chunks')} · ${t('cache')} ${progress.cache_hits || 0}/${progress.cache_misses || 0} · ${progress.embedding_requests || 0} ${t('embedding requests')} · ${compactDuration(progress.elapsed_ms)}`
}

function emptySnapshot(): DocumentSnapshot { return { roots: [], documents: [], excluded_paths: [], longbrain: { installed: false, healthy: false, qdrant_healthy: false, llm_available: false, embedding_provider: '', embedding_model: '', embedding_local: false, llm_provider: '', llm_model: '', llm_local: false, url: 'http://localhost:8800', install_url: 'https://longbrain.cc.cd', message: 'LongBrain is not installed' }, scanning: false, scan_cancelled: false } }

function locator(hit: DocumentSearchHit): string {
  if (hit.slide) return `${t('Slide')} ${hit.slide}`
  if (hit.page) return `${t('Page')} ${hit.page}`
  if (hit.line_start) return hit.line_end && hit.line_end !== hit.line_start ? `${t('Lines')} ${hit.line_start}–${hit.line_end}` : `${t('Line')} ${hit.line_start}`
  if (hit.paragraph_start) return hit.paragraph_end && hit.paragraph_end !== hit.paragraph_start ? `${t('Paragraphs')} ${hit.paragraph_start}–${hit.paragraph_end}` : `${t('Paragraph')} ${hit.paragraph_start}`
  return hit.heading || `${t('Chunk')} ${hit.chunk_index + 1}`
}

function queryTerms(query: string): string[] {
  return [...new Set(query.toLocaleLowerCase().split(/\s+/).map(term => term.replace(/[^\p{L}\p{N}_-]/gu, '')).filter(term => term.length >= 2))].slice(0, 8)
}

function queryHighlights(query: string): string[] {
  const raw = query.trim().replace(/^["“”'`]+|["“”'`]+$/g, '').toLocaleLowerCase()
  const quoted = [...query.matchAll(/["“]([^"”]+)["”]/g)].map(match => match[1].trim().toLocaleLowerCase()).filter(Boolean)
  return [...new Set([raw, ...quoted, ...queryTerms(query)].filter(value => value.length >= 2))].sort((left, right) => right.length - left.length).slice(0, 12)
}

function highlightedText(value: string): string {
  const highlights = queryHighlights(lastQuery)
  if (!highlights.length) return escapeHTML(value)
  const matcher = new RegExp(`(${highlights.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'giu')
  return value.split(matcher).map((part, index) => index % 2 ? `<mark>${escapeHTML(part)}</mark>` : escapeHTML(part)).join('')
}

function folderPath(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const end = normalized.lastIndexOf('/')
  return end > 0 ? normalized.slice(0, end) : normalized
}

function resultSnippet(text: string): string {
  const value = text.replace(/\s+/g, ' ').trim()
  const limit = 520
  if (value.length <= limit) return value
  const lower = value.toLocaleLowerCase()
  const positions = queryHighlights(lastQuery).map(term => lower.indexOf(term)).filter(index => index >= 0)
  const match = positions.length ? Math.min(...positions) : 0
  const start = Math.max(0, Math.min(match - 140, value.length - limit))
  return `${start > 0 ? '…' : ''}${value.slice(start, start + limit).trim()}${start + limit < value.length ? '…' : ''}`
}

function highlightedSnippet(text: string): string {
  return highlightedText(resultSnippet(text))
}

function hitCard(hit: DocumentSearchHit, index = 0): string {
  const score = Math.max(0, Math.min(100, Math.round(hit.score * 100)))
  const scoreLabel = t(answer || lastSearchMode === 'semantic' ? 'Relevance' : 'Match')
  return `<article class="document-result-card">
    <button class="document-result-source" data-document-open="${escapeHTML(hit.path)}" title="${escapeHTML(hit.path)}"><span class="document-citation-index">[${index + 1}]</span><span class="document-type-icon">${escapeHTML((hit.file_type || 'file').toUpperCase())}</span><span class="document-result-file"><strong title="${escapeHTML(hit.file_name)}">${highlightedText(hit.file_name)}</strong><small class="document-result-folder" title="${escapeHTML(hit.path)}"><span>${t('Folder')}</span><span class="document-result-folder-path">${highlightedText(folderPath(hit.path))}</span></small><em title="${escapeHTML(hit.heading || locator(hit))}">${highlightedText(hit.heading || locator(hit))}</em></span><span class="document-score" title="${escapeHTML(scoreLabel)}"><b>${score}%</b><em>${escapeHTML(scoreLabel)}</em><i><span style="width:${score}%"></span></i></span></button>
    <p class="document-result-snippet">${highlightedSnippet(hit.text)}</p>
    <div class="document-result-actions"><button class="citation-chip" data-document-open="${escapeHTML(hit.path)}">${escapeHTML(locator(hit))}</button><button class="document-text-action" data-document-preview="${escapeHTML(hit.path)}">${t('Preview')}</button><button class="document-text-action document-copy-action" data-document-copy-text="${escapeHTML(hit.path)}">${t(hit.file_type === 'pptx' ? 'Extract text' : 'Copy text')}</button><button class="document-text-action" data-document-reveal="${escapeHTML(hit.path)}">${t('Show in Finder')}</button></div>
  </article>`
}

function renderResultToolbar(items: DocumentSearchHit[]): string {
  const types = [...new Set(items.map(hit => hit.file_type).filter(Boolean))].sort()
  const mode = t(answer ? 'answer citations' : lastSearchMode === 'semantic' ? 'meaning search' : 'exact search')
  const askAction = !answer && items.length ? `<button id="document-answer-results" class="document-answer-results" disabled title="${t('Planned for a later phase')}">${t('Answer from passages')} <small>${t('Coming later')}</small></button>` : ''
  return `<div class="document-results-toolbar"><div><strong>${items.length} ${t('passages')}</strong><small>${escapeHTML(mode)} ${t('for')} “${escapeHTML(lastQuery)}”</small></div><div class="document-result-filters">${askAction}<button data-document-result-type="all" class="${resultFileType === 'all' ? 'active' : ''}">${t('All')}</button>${types.map(type => `<button data-document-result-type="${escapeHTML(type)}" class="${resultFileType === type ? 'active' : ''}">${escapeHTML(type.toUpperCase())}</button>`).join('')}<button id="document-clear-results" class="document-clear-results">${t('Clear')}</button></div></div>`
}

function renderResults(available = true): string {
  if (busy === 'search' || busy === 'ask') return `<div class="document-search-loading"><span></span><div><strong>${t(busy === 'ask' ? 'Writing an answer from passages' : 'Searching your documents')}</strong><small>${t(busy === 'ask' ? 'Using only the passages currently shown.' : 'Finding the most relevant passages…')}</small></div></div>`
  const items = answer?.citations || results
  if (answer) return `<section class="document-answer"><div class="document-answer-label">${t('Answer from passages')}</div><p>${escapeHTML(answer.answer)}</p><div class="document-answer-meta">${answer.citations.length} ${t('cited passages')}</div></section>${renderResultToolbar(items)}${items.map(hitCard).join('')}`
  if (!lastQuery) return ''
  if (!items.length) return `<div class="document-no-results"><strong>${t('No relevant passages found')}</strong><p>${t('Try a broader phrase, or run Scan now if files were recently changed.')}</p><button id="document-results-scan" class="btn-secondary" ${available ? '' : 'disabled'}>${t('Scan now')}</button></div>`
  const filtered = resultFileType === 'all' ? items : items.filter(hit => hit.file_type === resultFileType)
  const visible = filtered.slice(0, resultVisibleLimit)
  return `${renderResultToolbar(items)}<div class="document-result-grid">${visible.map(hitCard).join('')}</div>${filtered.length > visible.length ? `<button id="document-results-more" class="document-load-more">${t('Show')} ${Math.min(8, filtered.length - visible.length)} ${t('more results')}</button>` : ''}`
}

function renderResultFind(): string {
  if (!resultFindOpen) return ''
  return `<div class="document-result-find" role="search"><input id="document-result-find-input" type="search" value="${escapeHTML(resultFindQuery)}" placeholder="${t('Find in results…')}" autocomplete="off"><span id="document-result-find-count">0/0</span><button type="button" data-document-find="previous" title="${t('Previous match')}">↑</button><button type="button" data-document-find="next" title="${t('Next match')}">↓</button><button type="button" data-document-find="close" title="${t('Close')}">×</button></div>`
}

function applyResultFind(move = 0): void {
  document.querySelectorAll('#document-search-results .document-find-match').forEach(node => node.replaceWith(document.createTextNode(node.textContent || '')))
  const root = document.getElementById('document-search-results')
  const count = document.getElementById('document-result-find-count')
  const query = resultFindQuery.trim()
  if (!root || !query) { if (count) count.textContent = '0/0'; return }
  const matcher = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu')
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: node => node.parentElement?.closest('.document-result-find, script, style') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT })
  const nodes: Text[] = []
  while (walker.nextNode()) nodes.push(walker.currentNode as Text)
  for (const node of nodes) {
    const value = node.data
    matcher.lastIndex = 0
    if (!matcher.test(value)) continue
    matcher.lastIndex = 0
    const fragment = document.createDocumentFragment()
    let offset = 0
    for (const match of value.matchAll(matcher)) {
      const start = match.index || 0
      fragment.append(value.slice(offset, start))
      const mark = document.createElement('span'); mark.className = 'document-find-match'; mark.textContent = match[0]; fragment.append(mark)
      offset = start + match[0].length
    }
    fragment.append(value.slice(offset)); node.replaceWith(fragment)
  }
  const matches = [...root.querySelectorAll<HTMLElement>('.document-find-match')]
  resultFindIndex = matches.length ? (resultFindIndex + move + matches.length) % matches.length : 0
  matches.forEach((match, index) => match.classList.toggle('current', index === resultFindIndex))
  if (count) count.textContent = matches.length ? `${resultFindIndex + 1}/${matches.length}` : '0/0'
  if (move && matches[resultFindIndex]) matches[resultFindIndex].scrollIntoView({ block: 'center', behavior: 'smooth' })
}

function renderSearchModeControl(): string {
  return `<div class="document-search-mode" role="group" aria-label="${t('Search mode')}"><button type="button" data-document-search-mode="exact" class="${searchMode === 'exact' ? 'active' : ''}">${t('Exact')}</button><button type="button" data-document-search-mode="semantic" class="${searchMode === 'semantic' ? 'active' : ''}">${t('Meaning')}</button></div>`
}

function rootDefaultName(path: string): string { return path.replace(/[\\/]$/, '').split(/[\\/]/).pop() || path }

function renderScanSettingsModal(): string {
  return `<div class="settings-box">
    <header><h2>${t('Scan settings')}</h2><button class="btn-secondary" data-document-scan-settings-close>${t('Close')}</button></header>
    <section class="settings-section">
      <label class="settings-checkbox"><input type="checkbox" data-setting-documents-ocr ${ocrEnabled ? 'checked' : ''}> ${t('Enable OCR for image-only PDFs')}</label>
      <p class="resource-detail muted">${t('Some PDFs (like a full-page website screenshot saved as PDF) have no real text layer, so Thaloca cannot index them by default. Turning this on runs on-device OCR (the same recognizer as Captures\' "Extract text") on image-only pages during indexing. This adds real time per page, so large scanned PDFs will index more slowly.')}</p>
    </section>
    <section class="settings-section">
      <label class="settings-checkbox"><input type="checkbox" data-setting-documents-unlimited ${unlimitedEnabled ? 'checked' : ''}> ${t('No page/size limit')}</label>
      <p class="resource-detail muted">${t('Removes the default 200 page / 150 slide / 20 MB / 120 chunk automatic indexing caps for every folder. A very large or very long document will noticeably slow down scanning once this is on.')}</p>
    </section>
  </div>`
}

function renderRoots(state: DocumentSnapshot): string {
  if (!state.roots.length) return `<div class="documents-empty-small">${t('Add a folder to discover PDF, PPTX, DOCX, TXT and Markdown files. Images, scanned PDFs and empty files are skipped.')}</div>`
  return state.roots.map(root => {
    const editing = editingRootPath === root.path
    const name = root.name || rootDefaultName(root.path)
    const policy = documentPreferences.document_policies[root.path] || { mode: 'semantic', max_mb: 20, max_pages: 200, max_slides: 150 }
    return `<div class="document-root-row ${editing ? 'editing' : ''}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h5l2 2h11v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>${editing
      ? `<form class="document-root-rename" data-document-root-form="${escapeHTML(root.path)}"><input data-document-root-name="${escapeHTML(root.path)}" value="${escapeHTML(editingRootName)}" maxlength="80" aria-label="${t('Folder display name')}" autocomplete="off"><button class="btn-secondary document-root-save" type="submit">${t('Save')}</button><button class="btn-icon document-root-action" type="button" data-document-root-cancel title="${t('Cancel')}" aria-label="${t('Cancel')}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg></button></form>`
      : `<span class="document-root-copy" title="${escapeHTML(root.path)}"><strong>${escapeHTML(name)}</strong><small>${escapeHTML(root.path)}</small></span><details class="document-root-policy"><summary>${t('Index settings')}</summary><form data-document-policy="${escapeHTML(root.path)}"><select name="mode"><option value="semantic" ${policy.mode === 'semantic' ? 'selected' : ''}>${t('Semantic + exact')}</option><option value="excluded" ${policy.mode === 'excluded' ? 'selected' : ''}>${t('Do not index')}</option></select><label>MB <input name="max_mb" type="number" min="1" max="500" value="${policy.max_mb}"></label><label>${t('PDF pages')} <input name="max_pages" type="number" min="1" max="2000" value="${policy.max_pages}"></label><label>${t('PPTX slides')} <input name="max_slides" type="number" min="1" max="1000" value="${policy.max_slides}"></label><button class="btn-secondary" type="submit">${t('Save')}</button></form></details><button class="btn-icon document-root-action" data-document-rename-root="${escapeHTML(root.path)}" data-document-root-current-name="${escapeHTML(name)}" title="${t('Rename display name')}" aria-label="${t('Rename display name')}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 1 3 3L8 18l-4 1 1-4Z"/></svg></button><button class="btn-icon document-root-action document-root-remove" data-document-remove-root="${escapeHTML(root.path)}" title="${t('Stop managing this folder')}" aria-label="${t('Stop managing this folder')}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5"/></svg></button>`}</div>`
  }).join('')
}

type DocumentFolderNode = {
  key: string
  name: string
  detail: string
  depth: number
  children: Map<string, DocumentFolderNode>
  documents: DocumentSnapshot['documents']
  total: number
  visible: number
  size: number
  indexed: number
  failed: number
}

function newFolderNode(key: string, name: string, detail: string, depth: number): DocumentFolderNode {
  return { key, name, detail, depth, children: new Map(), documents: [], total: 0, visible: 0, size: 0, indexed: 0, failed: 0 }
}

function addDocumentStats(node: DocumentFolderNode, doc: DocumentSnapshot['documents'][number], visible: boolean): void {
  node.total += 1
  node.visible += visible ? 1 : 0
  node.size += doc.size
  if (doc.index_status === 'indexed') node.indexed += 1
  if (doc.index_status === 'failed') node.failed += 1
}

function documentTree(documents: DocumentSnapshot['documents'], visibleDocuments: DocumentSnapshot['documents']): DocumentFolderNode[] {
  const roots = new Map<string, DocumentFolderNode>()
  const visiblePaths = new Set(visibleDocuments.map(doc => doc.path))
  for (const doc of documents) {
    const rootParts = doc.root.replace(/\\/g, '/').split('/').filter(Boolean)
    const root = roots.get(doc.root) || newFolderNode(doc.root, rootParts.at(-1) || doc.root, doc.root, 0)
    roots.set(doc.root, root)
    const isVisible = visiblePaths.has(doc.path)
    addDocumentStats(root, doc, isVisible)
    const relative = doc.relative_path.replace(/\\/g, '/').split('/').filter(Boolean)
    const directories = relative.slice(0, -1)
    let node = root
    let relativeDirectory = ''
    for (const directory of directories) {
      relativeDirectory = relativeDirectory ? `${relativeDirectory}/${directory}` : directory
      const key = `${doc.root.replace(/[\\/]$/, '')}/${relativeDirectory}`
      const child = node.children.get(directory) || newFolderNode(key, directory, relativeDirectory, node.depth + 1)
      node.children.set(directory, child)
      addDocumentStats(child, doc, isVisible)
      node = child
    }
    if (isVisible) node.documents.push(doc)
  }
  return [...roots.values()].filter(root => root.visible > 0).sort((a, b) => a.key.localeCompare(b.key))
}

function renderDocumentRow(doc: DocumentSnapshot['documents'][number], depth: number): string {
  const copyLabel = doc.file_type === 'pptx' ? t('Extract text') : t('Copy text')
  const reason = doc.error && ['failed', 'skipped', 'waiting', 'unavailable'].includes(doc.index_status)
    ? `<small class="document-row-reason ${escapeHTML(doc.index_status)}" title="${escapeHTML(doc.error)}"><b>${escapeHTML(t(doc.index_status === 'skipped' ? 'Why skipped:' : doc.index_status === 'failed' ? 'Why failed:' : 'Reason:'))}</b> ${escapeHTML(doc.error)}</small>`
    : ''
  return `<div class="document-row" style="--document-tree-depth:${depth}"><button class="document-row-main" data-document-open="${escapeHTML(doc.path)}" title="${escapeHTML(doc.path)}"><span class="document-type-icon">${escapeHTML(doc.file_type.toUpperCase())}</span><span class="document-row-copy"><strong title="${escapeHTML(doc.name)}">${escapeHTML(doc.name)}</strong><small title="${escapeHTML(doc.relative_path)}">${escapeHTML(doc.relative_path)} · ${formatBytes(doc.size)}</small>${reason}</span></button><span class="document-index-status ${escapeHTML(doc.index_status)}" title="${escapeHTML(doc.error || t(doc.index_status))}">${escapeHTML(t(doc.index_status))}</span><span class="document-row-actions"><button class="btn-secondary document-row-action" data-document-preview="${escapeHTML(doc.path)}">${t('Preview')}</button><button class="btn-secondary document-row-action document-copy-action" data-document-copy-text="${escapeHTML(doc.path)}">${copyLabel}</button><button class="btn-secondary document-row-action" data-document-reveal="${escapeHTML(doc.path)}">Finder</button></span></div>`
}

function renderDocumentFolder(node: DocumentFolderNode, filtering: boolean): string {
  const expanded = filtering || (documentFolderExpansion.get(node.key) ?? node.depth === 0)
  const status = node.failed ? `${node.failed} ${t('failed')}` : `${node.indexed}/${node.total} ${t('indexed')}`
  const children = [...node.children.values()].filter(child => child.visible > 0).sort((a, b) => a.name.localeCompare(b.name))
  const contents = expanded
    ? `<div class="document-folder-children">${children.map(child => renderDocumentFolder(child, filtering)).join('')}${node.documents.map(doc => renderDocumentRow(doc, node.depth)).join('')}</div>`
    : ''
  return `<section class="document-folder-group ${expanded ? 'expanded' : ''}" style="--document-tree-depth:${node.depth}"><button class="document-folder-header" data-document-folder="${escapeHTML(node.key)}" aria-expanded="${expanded}" title="${escapeHTML(node.key)}"><span class="document-folder-chevron">›</span><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h5l2 2h11v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg><span class="document-folder-copy"><strong title="${escapeHTML(node.name)}">${escapeHTML(node.name)}</strong><small title="${escapeHTML(node.detail)}">${escapeHTML(node.detail)}</small></span><span class="document-folder-summary"><strong>${node.total} ${t(node.total === 1 ? 'file' : 'files')}</strong><small>${formatBytes(node.size)} · ${status}</small></span></button>${contents}</section>`
}

function renderDocuments(state: DocumentSnapshot): string {
  const query = documentFilter.trim().toLocaleLowerCase()
  const filtered = query ? state.documents.filter(doc => `${doc.name}\n${doc.relative_path}`.toLocaleLowerCase().includes(query)) : state.documents
  if (!filtered.length) return `<div class="documents-empty-small">${t(query ? 'No documents match this filter.' : 'No supported documents discovered yet.')}</div>`
  const visible = filtered.slice(0, documentVisibleLimit)
  const tree = documentTree(filtered, visible)
  const folders = tree.map(root => renderDocumentFolder(root, !!query)).join('')
  const remaining = filtered.length - visible.length
  return `<div class="document-folder-hint">${tree.length} ${t('managed')} ${t(tree.length === 1 ? 'folder' : 'folders')} · ${t(query ? 'matching branches expanded' : 'browse as a folder tree')}</div>${folders}` + (remaining > 0 ? `<button id="document-load-more" class="document-load-more">${t('Show 100 more')} · ${remaining} ${t('remaining')}</button>` : '')
}

function renderDocumentFailures(state: DocumentSnapshot): string {
  const failed = state.documents.filter(doc => doc.index_status === 'failed')
  const skipped = state.documents.filter(doc => doc.index_status === 'skipped')
  const excluded = state.excluded_paths || []
  if (!failed.length && !skipped.length && !excluded.length) return ''
  return `<div class="document-scan-exceptions">${failed.length ? `<details open><summary><span>${failed.length} ${t('failed files')}</span><button id="document-retry-failed" class="btn-secondary" ${state.scanning ? 'disabled' : ''}>${t('Retry failed')}</button></summary>${failed.map(doc => `<div><span title="${escapeHTML(doc.path)}"><strong>${escapeHTML(doc.name)}</strong><small><b>${t('Why failed:')}</b> ${escapeHTML(doc.error || t('Indexing failed'))}</small></span><button class="btn-secondary" data-document-exclude="${escapeHTML(doc.path)}">${t('Exclude from scans')}</button></div>`).join('')}</details>` : ''}${skipped.length ? `<details><summary><span>${skipped.length} ${t('skipped files')}</span><button id="document-retry-skipped" class="btn-secondary" ${state.scanning ? 'disabled' : ''}>${t('Retry skipped')}</button></summary>${skipped.map(doc => `<div><span title="${escapeHTML(doc.path)}"><strong>${escapeHTML(doc.name)}</strong><small><b>${t('Why skipped:')}</b> ${escapeHTML(doc.error || t('Skipped by automatic indexing limits'))}</small></span><button class="btn-secondary" data-document-preview="${escapeHTML(doc.path)}">${t('Preview')}</button></div>`).join('')}</details>` : ''}${excluded.length ? `<details><summary>${excluded.length} ${t('excluded files')}</summary>${excluded.map(path => `<div><span title="${escapeHTML(path)}"><strong>${escapeHTML(path.split('/').pop() || path)}</strong><small><b>${t('Why excluded:')}</b> ${t('Manually excluded from automatic scans')} · ${escapeHTML(path)}</small></span><button class="btn-secondary" data-document-restore="${escapeHTML(path)}">${t('Restore')}</button></div>`).join('')}</details>` : ''}</div>`
}

function renderIndexingStatus(state: DocumentSnapshot): string {
  const indexed = state.documents.filter(doc => doc.index_status === 'indexed').length
  const failed = state.documents.filter(doc => doc.index_status === 'failed').length
  const skipped = state.documents.filter(doc => doc.index_status === 'skipped').length
  const pending = Math.max(0, state.documents.length - indexed - failed - skipped)
  const chunks = state.documents.reduce((total, doc) => total + (doc.chunk_count || 0), 0)
  const progress = state.scan_progress
  const cacheTotal = (progress?.cache_hits || 0) + (progress?.cache_misses || 0)
  const cacheRate = cacheTotal ? Math.round((progress?.cache_hits || 0) / cacheTotal * 100) : 0
  const model = state.longbrain.embedding_model || t('Unavailable')
  const stateLabel = state.scanning ? t('Indexing') : failed ? t('Needs attention') : pending ? t('Pending') : t('Ready')
  return `<details class="document-index-control" ${state.scanning || failed ? 'open' : ''}>
    <summary><span><strong>${t('Indexing status')}</strong><small>${escapeHTML(stateLabel)} · ${indexed}/${state.documents.length} ${t('indexed')} · ${chunks} ${t('chunks')}</small></span><span class="document-index-control-badge ${failed ? 'warning' : state.scanning ? 'running' : 'ready'}">${escapeHTML(stateLabel)}</span></summary>
    <div class="document-index-control-grid">
      <span><small>${t('Files')}</small><strong>${indexed} ${t('ready')}</strong><em>${pending} ${t('pending')} · ${failed} ${t('failed')}</em></span>
      <span><small>${t('Chunks')}</small><strong>${chunks}</strong><em>${progress?.total_chunks || 0} ${t('processed in last scan')}</em></span>
      <span><small>${t('Embedding cache')}</small><strong>${cacheRate}%</strong><em>${progress?.cache_hits || 0} hit · ${progress?.cache_misses || 0} miss</em></span>
      <span><small>${t('Local embedding')}</small><strong title="${escapeHTML(model)}">${escapeHTML(model)}</strong><em>${escapeHTML(state.longbrain.embedding_provider || '—')}</em></span>
    </div>
    <p class="document-index-safety">${t('Existing indexed data is preserved. Scans skip unchanged files and retry only missing, changed, or failed documents.')}</p>
  </details>`
}

function renderScanProgress(state: DocumentSnapshot): string {
  if (!state.scanning && busy !== 'refresh' && busy !== 'cancel') return ''
  const progress = state.scan_progress || { phase: busy === 'cancel' ? 'cancelling' : 'discovering', discovered: 0, pending: 0, indexed: 0, failed: 0 }
  const phaseLabels: Record<string, string> = { discovering: t('Discovering files'), embedding: t('Creating semantic index'), indexing: t('Saving document index'), cleaning: t('Removing stale entries'), cancelling: t('Stopping scan') }
  const processed = progress.indexed + progress.failed
	const remaining = Math.max(0, progress.pending - processed)
  const percent = progress.pending > 0 && !['discovering', 'cleaning'].includes(progress.phase) ? Math.min(100, Math.round(processed / progress.pending * 100)) : 0
  const current = progress.current_file ? progress.current_file.split('/').slice(-2).join('/') : ''
  const eta = scanETA(progress)
  const batches = progress.embedding_batches || []
  const batchDetails = batches.map((batch, index) => `#${index + 1}: ${batch.texts} texts · ${compactDuration(batch.duration_ms)}`).join('\n')
  const metrics = progress.total_chunks ? `${progress.total_chunks} chunks · cache ${progress.cache_hits || 0} hit / ${progress.cache_misses || 0} miss · ${progress.embedding_requests || 0} requests · embedding ${compactDuration(progress.embedding_ms)} · total ${compactDuration(progress.elapsed_ms)}` : ''
  return `<div class="document-scan-progress"><div class="document-scan-progress-icon"><span></span></div><div class="document-scan-progress-copy"><div><strong>${escapeHTML(phaseLabels[progress.phase] || t('Scanning documents'))}</strong><small>${progress.discovered} ${t('found')}${progress.pending ? ` · ${processed}/${progress.pending} ${t('processed')} · ${remaining} ${t('remaining')}` : ''}${progress.failed ? ` · ${progress.failed} ${t('failed')}` : ''}${eta ? ` · ${eta}` : ''}</small></div>${metrics ? `<code class="document-scan-metrics" title="${escapeHTML(batchDetails)}">${escapeHTML(metrics)}</code>` : ''}${current ? `<code class="document-scan-current" title="${escapeHTML(progress.current_file || '')}">${escapeHTML(current)}</code>` : ''}<div class="document-scan-track"><span class="${percent ? '' : 'indeterminate'}" style="${percent ? `width:${percent}%` : ''}"></span></div></div><button id="document-cancel-scan" class="btn-danger">${t(busy === 'cancel' ? 'Stopping…' : 'Cancel')}</button></div>`
}

function updateDocumentRows(): void {
  const rows = document.getElementById('document-list-rows')
  if (rows) rows.innerHTML = renderDocuments(snapshot || emptySnapshot())
}

function render(): void {
  const container = document.getElementById('documents-content'); if (!container) return
  const active = document.activeElement instanceof HTMLInputElement ? document.activeElement : null
  const restoreID = active && ['document-query', 'document-list-filter'].includes(active.id) ? active.id : ''
  const selectionStart = active?.selectionStart ?? null
  const selectionEnd = active?.selectionEnd ?? null
  const state = snapshot || emptySnapshot(); const runtimeAvailable = state.longbrain.healthy && state.longbrain.qdrant_healthy; const available = runtimeAvailable && state.longbrain.embedding_local; const scanning = state.scanning || busy === 'refresh' || busy === 'cancel'
  container.innerHTML = `
    <div class="documents-hero"><div><h2>${t('Find the exact file and passage')}</h2><p>${t('Original files stay in place. Document indexing and search are provided by LongBrain.')}</p></div><div class="documents-hero-status"><button id="document-scan-settings-btn" class="btn-icon" title="${t('Scan settings')}" aria-label="${t('Scan settings')}"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button><div class="longbrain-health ${available ? 'connected' : 'offline'}"><span></span>${t(available ? 'Index ready' : 'Documents unavailable')}<small>${escapeHTML(t(state.longbrain.message))}</small></div></div></div>
    ${runtimeAvailable ? '' : `<div class="longbrain-install-card"><div class="longbrain-install-copy"><strong>${t('Install or start LongBrain to use Documents')}</strong><p>${t('Adding folders, scanning and semantic search stay locked until LongBrain and Qdrant are ready. Requires Docker Desktop.')}</p><div class="longbrain-install-command"><code>${escapeHTML(longbrainInstallCommand)}</code><button id="document-copy-install" class="btn-secondary">${t(installCommandCopied ? 'Copied' : 'Copy')}</button></div><small>${t('Guide')}: <code>${escapeHTML(state.longbrain.install_url || 'https://longbrain.cc.cd')}</code></small></div><div class="longbrain-install-actions"><button id="document-install-longbrain" class="primary">${t('Open install guide')}</button></div></div>`}
    <form id="document-search-form" class="document-search-box ${available ? '' : 'locked'}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>${renderSearchModeControl()}<input id="document-query" type="search" value="${escapeHTML(searchQuery)}" placeholder="${t(available ? (searchMode === 'semantic' ? 'Search by meaning, or ask a full question…' : 'Search exact text, or ask a full question…') : 'LongBrain document service is unavailable')}" title="${t('Search documents')}" autocomplete="off" ${available ? '' : 'disabled'}><button class="btn-secondary" type="submit" ${!available || busy ? 'disabled' : ''}>${t('Search passages')}</button></form>
    ${renderResultFind()}<div id="document-search-results">${renderResults(available)}</div>
    <div class="documents-layout"><aside class="document-roots-panel"><div class="documents-section-header"><div class="documents-section-title"><strong>${t('Folders')}</strong><small>${state.roots.length} ${t('managed')} · ${t('auto-scan every minute')}</small></div><button id="document-add-folder" class="primary" ${available ? '' : 'disabled'} title="${t(available ? 'Add a document folder' : 'LongBrain and Qdrant are required')}">${t('Add folder')}</button></div>${renderRoots(state)}</aside>
    <section class="document-list-panel"><div class="documents-section-header"><div class="documents-section-title"><strong>${t('Documents')}</strong><small>${state.documents.length} ${t('discovered')}${state.last_scan_at ? ` · ${t('last scan')} ${escapeHTML(new Date(state.last_scan_at).toLocaleTimeString())}` : ''}${escapeHTML(lastScanSummary(state))}</small></div><div class="document-list-tools"><input id="document-list-filter" type="search" value="${escapeHTML(documentFilter)}" placeholder="${t('Filter files…')}" autocomplete="off" spellcheck="false"><button id="document-refresh" class="btn-secondary" ${!available || scanning ? 'disabled' : ''} title="${t(available ? 'Scan managed folders now' : 'LongBrain and Qdrant are required')}">${t(scanning ? 'Scanning…' : 'Scan now')}</button></div></div>${renderIndexingStatus(state)}${renderScanProgress(state)}${renderDocumentFailures(state)}<div id="document-list-rows">${renderDocuments(state)}</div></section></div>`
  if (restoreID) {
    const restored = document.getElementById(restoreID) as HTMLInputElement | null
    restored?.focus({ preventScroll: true })
    if (restored && selectionStart !== null && selectionEnd !== null) restored.setSelectionRange(selectionStart, selectionEnd)
  }
  applyResultFind()
}

export async function loadDocumentsView(): Promise<void> {
  try {
    [snapshot, documentPreferences, ocrEnabled, unlimitedEnabled] = await Promise.all([
      api.documentLibrary(), api.productPreferences(), api.getDocumentsOCREnabled(), api.getDocumentsUnlimitedEnabled(),
    ])
  } catch (error) {
    snapshot = emptySnapshot()
    showError(String(error))
  }
  render()
}
async function addFolder(): Promise<void> { try { const path = await api.pickDocumentFolder(); if (!path) return; snapshot = await api.addDocumentFolder(path); render() } catch (error) { showError(String(error)) } }
async function removeFolder(path: string): Promise<void> {
  if (!(await api.confirmDialog('Remove document folder', `Stop managing ${path}? Original files will not be deleted.`))) return
  try {
    snapshot = await api.removeDocumentFolder(path)
    results = []
    answer = null
    render()
  } catch (error) {
    showError(String(error))
  }
}
async function renameFolder(path: string, name: string): Promise<void> {
  const value = name.trim()
  if (!value) { showError(t('Folder name is required')); return }
  try {
    snapshot = await api.renameDocumentFolder(path, value)
    editingRootPath = ''; editingRootName = ''; render()
  } catch (error) { showError(String(error)) }
}
async function copyDocumentText(path: string): Promise<void> {
  try {
    const text = await api.documentPlainText(path)
    await copyToClipboard(text, `Document text: ${path.split('/').pop() || path}`)
  } catch (error) { showError(String(error)) }
}
function isPowerPoint(path: string): boolean { return path.toLocaleLowerCase().endsWith('.pptx') }

function openDocumentPath(path: string): void {
  if (isPowerPoint(path)) { void api.previewDocument(path).catch(error => showError(String(error))); return }
  void api.openDocument(path).catch(error => showError(String(error)))
}

function previewDocumentPath(path: string): void {
  void api.previewDocument(path).catch(error => showError(String(error)))
}
async function refresh(): Promise<void> { try { busy = 'refresh'; if (snapshot) snapshot.scanning = true; render(); snapshot = await api.refreshDocuments() } catch (error) { showError(String(error)) } finally { busy = ''; render() } }
async function cancelScan(): Promise<void> { try { busy = 'cancel'; render(); await api.cancelDocumentScan() } catch (error) { showError(String(error)) } }
async function runQuery(): Promise<void> { const query = searchQuery.trim(); if (!query) return; try { busy = 'search'; lastQuery = query; lastSearchMode = searchMode; resultVisibleLimit = 8; resultFileType = 'all'; results = []; answer = null; render(); results = searchMode === 'semantic' ? await api.semanticSearchDocuments(query) : await api.searchDocuments(query) } catch (error) { showError(String(error)) } finally { busy = ''; render() } }
async function answerFromResults(): Promise<void> { const query = lastQuery.trim(); if (!query || !results.length) return; try { busy = 'ask'; answer = null; render(); answer = await api.askDocumentPassages(query, results.slice(0, 6)) } catch (error) { showError(String(error)) } finally { busy = ''; render() } }

async function handleOCRToggle(enabled: boolean): Promise<void> {
  ocrEnabled = enabled
  try {
    await api.setDocumentsOCREnabled(enabled)
  } catch (error) {
    ocrEnabled = !enabled
    renderScanSettingsRoot()
    showError(`${t('Could not save setting:')} ${String(error)}`)
  }
}

async function handleUnlimitedToggle(enabled: boolean): Promise<void> {
  unlimitedEnabled = enabled
  try {
    await api.setDocumentsUnlimitedEnabled(enabled)
  } catch (error) {
    unlimitedEnabled = !enabled
    renderScanSettingsRoot()
    showError(`${t('Could not save setting:')} ${String(error)}`)
  }
}

function renderScanSettingsRoot(): void {
  const root = document.getElementById('document-scan-settings-root')
  if (root) root.innerHTML = renderScanSettingsModal()
}

function initScanSettingsModal(): void {
  if (document.getElementById('document-scan-settings-root')) return
  const root = document.createElement('div')
  root.id = 'document-scan-settings-root'
  root.className = 'settings-overlay'
  document.body.appendChild(root)
  root.addEventListener('mousedown', event => { if (event.target === root) closeScanSettingsModal() })
  root.addEventListener('click', event => {
    if ((event.target as HTMLElement).closest('[data-document-scan-settings-close]')) closeScanSettingsModal()
  })
  root.addEventListener('change', event => {
    const input = event.target as HTMLInputElement
    if (input.matches('[data-setting-documents-ocr]')) { void handleOCRToggle(input.checked); return }
    if (input.matches('[data-setting-documents-unlimited]')) { void handleUnlimitedToggle(input.checked); return }
  })
}

function openScanSettingsModal(): void {
  renderScanSettingsRoot()
  document.getElementById('document-scan-settings-root')?.classList.add('open')
}

function closeScanSettingsModal(): void {
  document.getElementById('document-scan-settings-root')?.classList.remove('open')
}

export function initDocumentsView(): void {
  if (initialized) return; initialized = true; const view = document.getElementById('documents-view')
  initScanSettingsModal()
  document.addEventListener(LOCALE_CHANGE_EVENT, () => { render(); renderScanSettingsRoot() })
  document.addEventListener('keydown', event => {
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLocaleLowerCase() !== 'f' || !view?.classList.contains('active')) return
    event.preventDefault()
    resultFindOpen = true
    render()
    const input = document.getElementById('document-result-find-input') as HTMLInputElement | null
    input?.focus(); input?.select()
  })
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !resultFindOpen || !view?.classList.contains('active')) return
    resultFindOpen = false; resultFindQuery = ''; resultFindIndex = 0; render()
  })
  EventsOn('documents-scan-state', (scanning: boolean) => { if (snapshot) snapshot.scanning = scanning; if (scanning && !scanStartedAt) { scanStartedAt = Date.now(); scanInitialProcessed = 0 } if (!scanning) { scanStartedAt = 0; scanInitialProcessed = 0; busy = ''; void loadDocumentsView() } else render() })
  EventsOn('documents-scan-progress', (progress: DocumentScanProgress) => { if (snapshot) { const scanning = !['complete', 'cancelled'].includes(progress.phase); if (scanning && !scanStartedAt) { scanStartedAt = Date.now(); scanInitialProcessed = progress.indexed + progress.failed } if (!scanning) { scanStartedAt = 0; scanInitialProcessed = 0 } snapshot.scanning = scanning; snapshot.scan_progress = progress; render() } })
  view?.addEventListener('submit', event => { const form = event.target as HTMLFormElement; if (form.id === 'document-search-form') { event.preventDefault(); void runQuery(); return } if (form.dataset.documentPolicy) { event.preventDefault(); const values = new FormData(form); void api.setDocumentRootPolicy(form.dataset.documentPolicy, { mode: String(values.get('mode')), max_mb: Number(values.get('max_mb')), max_pages: Number(values.get('max_pages')), max_slides: Number(values.get('max_slides')) }).then(value => { documentPreferences = value; render() }); return } if (form.dataset.documentRootForm) { event.preventDefault(); void renameFolder(form.dataset.documentRootForm, editingRootName) } })
  view?.addEventListener('input', event => { const input = event.target as HTMLInputElement; if (input.id === 'document-query') searchQuery = input.value; if (input.dataset.documentRootName) editingRootName = input.value; if (input.id === 'document-result-find-input') { resultFindQuery = input.value; resultFindIndex = 0; applyResultFind() } if (input.id === 'document-list-filter') { documentFilter = input.value; documentVisibleLimit = 100; updateDocumentRows() } })
  view?.addEventListener('click', event => { const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button'); if (!button) return
    if (button.id === 'document-install-longbrain') { BrowserOpenURL(snapshot?.longbrain.install_url || 'https://longbrain.cc.cd'); return }
    if (button.dataset.documentFind === 'close') { resultFindOpen = false; resultFindQuery = ''; resultFindIndex = 0; render(); return }
    if (button.dataset.documentFind === 'previous') { applyResultFind(-1); return }
    if (button.dataset.documentFind === 'next') { applyResultFind(1); return }
    if (button.id === 'document-copy-install') { void copyToClipboard(longbrainInstallCommand, 'LongBrain install command').then(() => { installCommandCopied = true; render() }).catch(error => showError(String(error))); return }
    if (button.id === 'document-scan-settings-btn') { openScanSettingsModal(); return }; if (button.id === 'document-add-folder') { void addFolder(); return }; if (button.id === 'document-refresh' || button.id === 'document-results-scan' || button.id === 'document-retry-failed' || button.id === 'document-retry-skipped') { void refresh(); return }; if (button.id === 'document-cancel-scan') { void cancelScan(); return }; if (button.id === 'document-load-more') { documentVisibleLimit += 100; updateDocumentRows(); return }; if (button.id === 'document-results-more') { resultVisibleLimit += 8; render(); return }; if (button.id === 'document-clear-results') { results = []; answer = null; lastQuery = ''; resultFileType = 'all'; render(); return }; if (button.id === 'document-answer-results') { void answerFromResults(); return }; if (button.dataset.documentSearchMode === 'exact' || button.dataset.documentSearchMode === 'semantic') { searchMode = button.dataset.documentSearchMode; render(); return }; if (button.dataset.documentResultType) { resultFileType = button.dataset.documentResultType; resultVisibleLimit = 8; render(); return }
    if (button.dataset.documentFolder) { documentFolderExpansion.set(button.dataset.documentFolder, button.getAttribute('aria-expanded') !== 'true'); updateDocumentRows(); return }
    if (button.dataset.documentRenameRoot) { editingRootPath = button.dataset.documentRenameRoot; editingRootName = button.dataset.documentRootCurrentName || rootDefaultName(editingRootPath); render(); requestAnimationFrame(() => { const input = document.querySelector<HTMLInputElement>(`[data-document-root-name="${CSS.escape(editingRootPath)}"]`); input?.focus(); input?.select() }); return }
    if (button.hasAttribute('data-document-root-cancel')) { editingRootPath = ''; editingRootName = ''; render(); return }
    if (button.dataset.documentOpen) { openDocumentPath(button.dataset.documentOpen); return }; if (button.dataset.documentPreview) { previewDocumentPath(button.dataset.documentPreview); return }; if (button.dataset.documentCopyText) { void copyDocumentText(button.dataset.documentCopyText); return }; if (button.dataset.documentReveal) { void api.revealDocument(button.dataset.documentReveal).catch(error => showError(String(error))); return }
    if (button.dataset.documentRemoveRoot) { void removeFolder(button.dataset.documentRemoveRoot); return }
    if (button.dataset.documentExclude) { void api.excludeDocument(button.dataset.documentExclude).then(value => { snapshot = value; render() }).catch(error => showError(String(error))); return }
    if (button.dataset.documentRestore) { void api.restoreExcludedDocument(button.dataset.documentRestore).then(value => { snapshot = value; render() }).catch(error => showError(String(error))); return }
  }); render()
}
