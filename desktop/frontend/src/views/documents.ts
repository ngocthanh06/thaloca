import { api, type DocumentAnswer, type DocumentScanProgress, type DocumentSearchHit, type DocumentSnapshot } from '../api'
import { escapeHTML, formatBytes, showError } from '../dom'
import { copyToClipboard } from '../clipboard'
import { BrowserOpenURL, EventsOn } from '../../wailsjs/runtime/runtime'

const longbrainInstallCommand = 'curl -fsSL https://raw.githubusercontent.com/ngocthanh06/longbrain/main/install.sh | bash'

let snapshot: DocumentSnapshot | null = null
let results: DocumentSearchHit[] = []
let answer: DocumentAnswer | null = null
let busy: 'search' | 'ask' | 'refresh' | 'cancel' | '' = ''
let initialized = false
let documentFilter = ''
let documentVisibleLimit = 100
const documentFolderExpansion = new Map<string, boolean>()
let searchQuery = ''
let lastQuery = ''
let resultVisibleLimit = 8
let resultFileType = 'all'
let installCommandCopied = false

function emptySnapshot(): DocumentSnapshot { return { roots: [], documents: [], longbrain: { installed: false, healthy: false, qdrant_healthy: false, llm_available: false, embedding_provider: '', embedding_model: '', embedding_local: false, llm_provider: '', llm_model: '', llm_local: false, url: 'http://localhost:8800', install_url: 'https://longbrain.cc.cd', message: 'LongBrain is not installed' }, scanning: false, scan_cancelled: false } }

function locator(hit: DocumentSearchHit): string {
  if (hit.page) return `Page ${hit.page}`
  if (hit.line_start) return hit.line_end && hit.line_end !== hit.line_start ? `Lines ${hit.line_start}–${hit.line_end}` : `Line ${hit.line_start}`
  if (hit.paragraph_start) return hit.paragraph_end && hit.paragraph_end !== hit.paragraph_start ? `Paragraphs ${hit.paragraph_start}–${hit.paragraph_end}` : `Paragraph ${hit.paragraph_start}`
  return hit.heading || `Chunk ${hit.chunk_index + 1}`
}

function queryTerms(query: string): string[] {
  return [...new Set(query.toLocaleLowerCase().split(/\s+/).map(term => term.replace(/[^\p{L}\p{N}_-]/gu, '')).filter(term => term.length >= 2))].slice(0, 8)
}

function resultSnippet(text: string): string {
  const value = text.replace(/\s+/g, ' ').trim()
  const limit = 520
  if (value.length <= limit) return value
  const lower = value.toLocaleLowerCase()
  const positions = queryTerms(lastQuery).map(term => lower.indexOf(term)).filter(index => index >= 0)
  const match = positions.length ? Math.min(...positions) : 0
  const start = Math.max(0, Math.min(match - 140, value.length - limit))
  return `${start > 0 ? '…' : ''}${value.slice(start, start + limit).trim()}${start + limit < value.length ? '…' : ''}`
}

function highlightedSnippet(text: string): string {
  const snippet = resultSnippet(text)
  const terms = queryTerms(lastQuery)
  if (!terms.length) return escapeHTML(snippet)
  const escapedTerms = terms.map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const matcher = new RegExp(`(${escapedTerms.join('|')})`, 'giu')
  return snippet.split(matcher).map(part => terms.includes(part.toLocaleLowerCase()) ? `<mark>${escapeHTML(part)}</mark>` : escapeHTML(part)).join('')
}

function hitCard(hit: DocumentSearchHit, index = 0): string {
  const score = Math.max(0, Math.min(100, Math.round(hit.score * 100)))
  return `<article class="document-result-card">
    <button class="document-result-source" data-document-open="${escapeHTML(hit.path)}"><span class="document-citation-index">[${index + 1}]</span><span class="document-type-icon">${escapeHTML((hit.file_type || 'file').toUpperCase())}</span><span><strong>${escapeHTML(hit.file_name)}</strong><small>${escapeHTML(hit.path)}</small></span><span class="document-score"><b>${score}%</b><i><span style="width:${score}%"></span></i></span></button>
    <p class="document-result-snippet">${highlightedSnippet(hit.text)}</p>
    <div class="document-result-actions"><button class="citation-chip" data-document-open="${escapeHTML(hit.path)}">${escapeHTML(locator(hit))}</button><button class="document-text-action" data-document-reveal="${escapeHTML(hit.path)}">Show in Finder</button></div>
  </article>`
}

function renderResultToolbar(items: DocumentSearchHit[]): string {
  const types = [...new Set(items.map(hit => hit.file_type).filter(Boolean))].sort()
  return `<div class="document-results-toolbar"><div><strong>${items.length} relevant passages</strong><small>for “${escapeHTML(lastQuery)}”</small></div><div class="document-result-filters"><button data-document-result-type="all" class="${resultFileType === 'all' ? 'active' : ''}">All</button>${types.map(type => `<button data-document-result-type="${escapeHTML(type)}" class="${resultFileType === type ? 'active' : ''}">${escapeHTML(type.toUpperCase())}</button>`).join('')}<button id="document-clear-results" class="document-clear-results">Clear</button></div></div>`
}

function renderResults(available = true): string {
  if (busy === 'search' || busy === 'ask') return `<div class="document-search-loading"><span></span><div><strong>${busy === 'ask' ? 'Asking LongBrain' : 'Searching your documents'}</strong><small>Finding the most relevant passages…</small></div></div>`
  const items = answer?.citations || results
  if (answer) return `<section class="document-answer"><div class="document-answer-label">LongBrain answer</div><p>${escapeHTML(answer.answer)}</p><div class="document-answer-meta">${answer.citations.length} cited passages</div></section>${renderResultToolbar(items)}${items.map(hitCard).join('')}`
  if (!lastQuery) return ''
  if (!items.length) return `<div class="document-no-results"><strong>No relevant passages found</strong><p>Try a broader phrase, or run Scan now if files were recently changed.</p><button id="document-results-scan" class="btn-secondary" ${available ? '' : 'disabled'}>Scan now</button></div>`
  const filtered = resultFileType === 'all' ? items : items.filter(hit => hit.file_type === resultFileType)
  const visible = filtered.slice(0, resultVisibleLimit)
  return `${renderResultToolbar(items)}<div class="document-result-grid">${visible.map(hitCard).join('')}</div>${filtered.length > visible.length ? `<button id="document-results-more" class="document-load-more">Show ${Math.min(8, filtered.length - visible.length)} more results</button>` : ''}`
}

function renderRoots(state: DocumentSnapshot): string { return state.roots.length ? state.roots.map(root => `<div class="document-root-row"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h5l2 2h11v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg><span title="${escapeHTML(root.path)}">${escapeHTML(root.path)}</span><button class="btn-icon document-root-remove" data-document-remove-root="${escapeHTML(root.path)}" title="Stop managing this folder">×</button></div>`).join('') : '<div class="documents-empty-small">Add a folder to discover PDF, DOCX, TXT and Markdown files.</div>' }

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
  return `<div class="document-row" style="--document-tree-depth:${depth}"><button class="document-row-main" data-document-open="${escapeHTML(doc.path)}"><span class="document-type-icon">${escapeHTML(doc.file_type.toUpperCase())}</span><span class="document-row-copy"><strong>${escapeHTML(doc.name)}</strong><small>${escapeHTML(doc.relative_path)} · ${formatBytes(doc.size)}</small></span></button><span class="document-index-status ${escapeHTML(doc.index_status)}" title="${escapeHTML(doc.error || '')}">${escapeHTML(doc.index_status)}</span><button class="btn-secondary" data-document-reveal="${escapeHTML(doc.path)}">Finder</button></div>`
}

function renderDocumentFolder(node: DocumentFolderNode, filtering: boolean): string {
  const expanded = filtering || (documentFolderExpansion.get(node.key) ?? node.depth === 0)
  const status = node.failed ? `${node.failed} failed` : `${node.indexed}/${node.total} indexed`
  const children = [...node.children.values()].filter(child => child.visible > 0).sort((a, b) => a.name.localeCompare(b.name))
  const contents = expanded
    ? `<div class="document-folder-children">${children.map(child => renderDocumentFolder(child, filtering)).join('')}${node.documents.map(doc => renderDocumentRow(doc, node.depth)).join('')}</div>`
    : ''
  return `<section class="document-folder-group ${expanded ? 'expanded' : ''}" style="--document-tree-depth:${node.depth}"><button class="document-folder-header" data-document-folder="${escapeHTML(node.key)}" aria-expanded="${expanded}" title="${escapeHTML(node.key)}"><span class="document-folder-chevron">›</span><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h5l2 2h11v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg><span class="document-folder-copy"><strong>${escapeHTML(node.name)}</strong><small>${escapeHTML(node.detail)}</small></span><span class="document-folder-summary"><strong>${node.total} ${node.total === 1 ? 'file' : 'files'}</strong><small>${formatBytes(node.size)} · ${status}</small></span></button>${contents}</section>`
}

function renderDocuments(state: DocumentSnapshot): string {
  const query = documentFilter.trim().toLocaleLowerCase()
  const filtered = query ? state.documents.filter(doc => `${doc.name}\n${doc.relative_path}`.toLocaleLowerCase().includes(query)) : state.documents
  if (!filtered.length) return `<div class="documents-empty-small">${query ? 'No documents match this filter.' : 'No supported documents discovered yet.'}</div>`
  const visible = filtered.slice(0, documentVisibleLimit)
  const tree = documentTree(filtered, visible)
  const folders = tree.map(root => renderDocumentFolder(root, !!query)).join('')
  const remaining = filtered.length - visible.length
  return `<div class="document-folder-hint">${tree.length} managed ${tree.length === 1 ? 'folder' : 'folders'} · ${query ? 'matching branches expanded' : 'browse as a folder tree'}</div>${folders}` + (remaining > 0 ? `<button id="document-load-more" class="document-load-more">Show 100 more · ${remaining} remaining</button>` : '')
}

function renderScanProgress(state: DocumentSnapshot): string {
  if (!state.scanning && busy !== 'refresh' && busy !== 'cancel') return ''
  const progress = state.scan_progress || { phase: busy === 'cancel' ? 'cancelling' : 'discovering', discovered: 0, pending: 0, indexed: 0, failed: 0 }
  const phaseLabels: Record<string, string> = { discovering: 'Discovering files', embedding: 'Creating semantic index', indexing: 'Saving document index', cleaning: 'Removing stale entries', cancelling: 'Stopping scan' }
  const processed = progress.indexed + progress.failed
  const percent = progress.pending > 0 && progress.phase === 'indexing' ? Math.min(100, Math.round(processed / progress.pending * 100)) : 0
  const current = progress.current_file ? progress.current_file.split('/').slice(-2).join('/') : ''
  return `<section class="document-scan-progress"><div class="document-scan-progress-icon"><span></span></div><div class="document-scan-progress-copy"><div><strong>${escapeHTML(phaseLabels[progress.phase] || 'Scanning documents')}</strong><small>${progress.discovered} found${progress.pending ? ` · ${progress.pending} to index` : ''}${progress.indexed ? ` · ${progress.indexed} indexed` : ''}${progress.failed ? ` · ${progress.failed} failed` : ''}</small></div>${current ? `<code title="${escapeHTML(progress.current_file || '')}">${escapeHTML(current)}</code>` : ''}<div class="document-scan-track"><span class="${percent ? '' : 'indeterminate'}" style="${percent ? `width:${percent}%` : ''}"></span></div></div><button id="document-cancel-scan" class="btn-danger">${busy === 'cancel' ? 'Stopping…' : 'Cancel'}</button></section>`
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
  const state = snapshot || emptySnapshot(); const runtimeAvailable = state.longbrain.healthy && state.longbrain.qdrant_healthy; const available = runtimeAvailable && state.longbrain.embedding_local; const askAvailable = available && state.longbrain.llm_available && state.longbrain.llm_local; const scanning = state.scanning || busy === 'refresh' || busy === 'cancel'
  container.innerHTML = `
    <div class="documents-hero"><div><h2>Find the exact file and passage</h2><p>Original files stay in place. Thaloca owns the isolated <code>thaloca_documents</code> index. Indexing and AI are enabled only for providers on the local-provider allowlist.</p></div><div class="longbrain-health ${available ? 'connected' : 'offline'}"><span></span>${available ? 'Local index ready' : 'Documents locked'}<small>${escapeHTML(state.longbrain.message)}</small></div></div>
    ${runtimeAvailable ? '' : `<div class="longbrain-install-card"><div class="longbrain-install-copy"><strong>Install or start LongBrain to use Documents</strong><p>Add folder, scanning, semantic search and Ask AI stay locked until the local LongBrain and Qdrant services are ready. Requires Docker Desktop.</p><div class="longbrain-install-command"><code>${escapeHTML(longbrainInstallCommand)}</code><button id="document-copy-install" class="btn-secondary">${installCommandCopied ? 'Copied' : 'Copy'}</button></div><small>Guide: <code>${escapeHTML(state.longbrain.install_url || 'https://longbrain.cc.cd')}</code></small></div><div class="longbrain-install-actions"><button id="document-install-longbrain" class="primary">Open install guide</button></div></div>`}
    ${runtimeAvailable && !state.longbrain.embedding_local ? `<div class="document-privacy-card blocked"><strong>Document indexing blocked</strong><p>Embedding provider <code>${escapeHTML(state.longbrain.embedding_provider || 'unknown')}</code> is not on the local-provider allowlist. Thaloca will not send document contents to it.</p></div>` : ''}
    ${available && state.longbrain.llm_available && !state.longbrain.llm_local ? `<div class="document-privacy-card"><strong>Local search ready · Ask AI blocked</strong><p>LongBrain is configured with <code>${escapeHTML(state.longbrain.llm_provider || 'unknown')} / ${escapeHTML(state.longbrain.llm_model || 'unknown')}</code>. That provider may send document passages outside this Mac.</p></div>` : ''}
    <form id="document-search-form" class="document-search-box ${available ? '' : 'locked'}"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg><input id="document-query" type="search" value="${escapeHTML(searchQuery)}" placeholder="${available ? 'Search a keyword, question, or idea…' : 'An allowlisted local embedding provider is required'}" autocomplete="off" ${available ? '' : 'disabled'}><button class="btn-secondary" type="submit" ${!available || busy ? 'disabled' : ''}>Search</button><button id="document-ask" class="primary" type="button" ${!askAvailable || busy ? 'disabled' : ''} title="${askAvailable ? 'Ask the allowlisted local LongBrain LLM using cited passages' : state.longbrain.llm_available && !state.longbrain.llm_local ? 'Blocked: configured LLM provider is not on the local-provider allowlist' : 'LongBrain has no local LLM configured'}">Ask AI</button></form>
    ${renderScanProgress(state)}
    <div id="document-search-results">${renderResults(available)}</div>
    <div class="documents-layout"><aside class="document-roots-panel"><div class="documents-section-header"><div class="documents-section-title"><strong>Folders</strong><small>${state.roots.length} managed · auto-scan every minute</small></div><button id="document-add-folder" class="primary" ${available ? '' : 'disabled'} title="${available ? 'Add a document folder' : 'LongBrain and Qdrant are required'}">Add folder</button></div>${renderRoots(state)}</aside>
    <section class="document-list-panel"><div class="documents-section-header"><div class="documents-section-title"><strong>Documents</strong><small>${state.documents.length} discovered${state.last_scan_at ? ` · last scan ${escapeHTML(new Date(state.last_scan_at).toLocaleTimeString())}` : ''}</small></div><div class="document-list-tools"><input id="document-list-filter" type="search" value="${escapeHTML(documentFilter)}" placeholder="Filter files…" autocomplete="off" spellcheck="false"><button id="document-refresh" class="btn-secondary" ${!available || scanning ? 'disabled' : ''} title="${available ? 'Scan managed folders now' : 'LongBrain and Qdrant are required'}">${scanning ? 'Scanning…' : 'Scan now'}</button></div></div><div id="document-list-rows">${renderDocuments(state)}</div></section></div>`
  if (restoreID) {
    const restored = document.getElementById(restoreID) as HTMLInputElement | null
    restored?.focus({ preventScroll: true })
    if (restored && selectionStart !== null && selectionEnd !== null) restored.setSelectionRange(selectionStart, selectionEnd)
  }
}

export async function loadDocumentsView(): Promise<void> { try { snapshot = await api.documentLibrary() } catch (error) { snapshot = emptySnapshot(); showError(String(error)) }; render() }
async function addFolder(): Promise<void> { try { const path = await api.pickDocumentFolder(); if (!path) return; snapshot = await api.addDocumentFolder(path); render() } catch (error) { showError(String(error)) } }
async function refresh(): Promise<void> { try { busy = 'refresh'; if (snapshot) snapshot.scanning = true; render(); snapshot = await api.refreshDocuments() } catch (error) { showError(String(error)) } finally { busy = ''; render() } }
async function cancelScan(): Promise<void> { try { busy = 'cancel'; render(); await api.cancelDocumentScan() } catch (error) { showError(String(error)) } }
async function runQuery(mode: 'search' | 'ask'): Promise<void> { const query = searchQuery.trim(); if (!query) return; try { busy = mode; lastQuery = query; resultVisibleLimit = 8; resultFileType = 'all'; results = []; answer = null; render(); if (mode === 'ask') answer = await api.askDocuments(query); else results = await api.searchDocuments(query) } catch (error) { showError(String(error)) } finally { busy = ''; render() } }

export function initDocumentsView(): void {
  if (initialized) return; initialized = true; const view = document.getElementById('documents-view')
  EventsOn('documents-scan-state', (scanning: boolean) => { if (snapshot) snapshot.scanning = scanning; if (!scanning) { busy = ''; void loadDocumentsView() } else render() })
  EventsOn('documents-scan-progress', (progress: DocumentScanProgress) => { if (snapshot) { snapshot.scanning = !['complete', 'cancelled'].includes(progress.phase); snapshot.scan_progress = progress; render() } })
  view?.addEventListener('submit', event => { if ((event.target as HTMLElement).id === 'document-search-form') { event.preventDefault(); void runQuery('search') } })
  view?.addEventListener('input', event => { const input = event.target as HTMLInputElement; if (input.id === 'document-query') searchQuery = input.value; if (input.id === 'document-list-filter') { documentFilter = input.value; documentVisibleLimit = 100; updateDocumentRows() } })
  view?.addEventListener('click', event => { const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button'); if (!button) return
    if (button.id === 'document-install-longbrain') { BrowserOpenURL(snapshot?.longbrain.install_url || 'https://longbrain.cc.cd'); return }
    if (button.id === 'document-copy-install') { void copyToClipboard(longbrainInstallCommand, 'LongBrain install command').then(() => { installCommandCopied = true; render() }).catch(error => showError(String(error))); return }
    if (button.id === 'document-add-folder') { void addFolder(); return }; if (button.id === 'document-refresh' || button.id === 'document-results-scan') { void refresh(); return }; if (button.id === 'document-cancel-scan') { void cancelScan(); return }; if (button.id === 'document-load-more') { documentVisibleLimit += 100; updateDocumentRows(); return }; if (button.id === 'document-results-more') { resultVisibleLimit += 8; render(); return }; if (button.id === 'document-clear-results') { results = []; answer = null; lastQuery = ''; resultFileType = 'all'; render(); return }; if (button.dataset.documentResultType) { resultFileType = button.dataset.documentResultType; resultVisibleLimit = 8; render(); return }; if (button.id === 'document-ask') { void runQuery('ask'); return }
    if (button.dataset.documentFolder) { documentFolderExpansion.set(button.dataset.documentFolder, button.getAttribute('aria-expanded') !== 'true'); updateDocumentRows(); return }
    if (button.dataset.documentOpen) { void api.openDocument(button.dataset.documentOpen).catch(error => showError(String(error))); return }; if (button.dataset.documentReveal) { void api.revealDocument(button.dataset.documentReveal).catch(error => showError(String(error))); return }
    if (button.dataset.documentRemoveRoot && window.confirm(`Stop managing ${button.dataset.documentRemoveRoot}? Original files will not be deleted.`)) void api.removeDocumentFolder(button.dataset.documentRemoveRoot).then(value => { snapshot = value; results = []; answer = null; render() }).catch(error => showError(String(error)))
  }); render()
}
