import { api, type DocumentSnapshot, type ProcessInfo, type ToolInfo } from '../api'
import { escapeHTML, showError } from '../dom'
import { t } from '../i18n'

const aiPattern = /ollama|llama|qdrant|longbrain|openai|anthropic|claude|codex|embedding|transformers|huggingface/i
let processes: ProcessInfo[] = []
let tools: ToolInfo[] = []
let documents: DocumentSnapshot | null = null
let loading = false

function render(): void {
  const root = document.getElementById('ai-monitor-content')
  if (!root) return
  const aiProcesses = processes.filter(process => aiPattern.test(`${process.command} ${process.path}`))
  const aiTools = tools.filter(tool => aiPattern.test(`${tool.name} ${tool.command} ${tool.path || ''}`))
  const lb = documents?.longbrain
  root.innerHTML = `
    <div class="feature-hero"><div><h2>${t('AI Services')}</h2><p>${t('Local, read-only monitoring. No AI model is used to scan your machine.')}</p></div><button id="ai-monitor-refresh" class="btn-secondary" ${loading ? 'disabled' : ''}>${t(loading ? 'Refreshing…' : 'Refresh')}</button></div>
    <div class="feature-metrics">
      <article><strong>${aiProcesses.length}</strong><span>${t('Running processes')}</span></article><article><strong>${aiTools.filter(tool => tool.installed).length}</strong><span>${t('Installed tools')}</span></article>
      <article><strong>${lb?.healthy ? t('Ready') : t('Offline')}</strong><span>LongBrain</span></article><article><strong>${documents?.scan_progress?.indexed || 0}/${documents?.scan_progress?.pending || 0}</strong><span>${t('Index progress')}</span></article>
    </div>
    <section class="feature-panel"><header><div><strong>LongBrain</strong><small>${escapeHTML(lb?.message || t('Status unavailable'))}</small></div><span class="chip ${lb?.healthy ? '' : 'critical'}">${t(lb?.healthy ? 'Connected' : 'Offline')}</span></header>
      <div class="ai-runtime-grid"><span><small>${t('Embedding')}</small><strong>${escapeHTML(lb?.embedding_model || '—')}</strong><em>${lb?.embedding_local ? t('Local') : t('Remote')}</em></span><span><small>LLM</small><strong>${escapeHTML(lb?.llm_model || '—')}</strong><em>${lb?.llm_local ? t('Local') : t('Remote')}</em></span><span><small>Qdrant</small><strong>${t(lb?.qdrant_healthy ? 'Ready' : 'Offline')}</strong><em>${escapeHTML(lb?.url || '')}</em></span></div>
      ${documents?.scanning ? `<div class="indexing-live"><span class="spinner"></span><div><strong>${t('Indexing in background')}</strong><p>${escapeHTML(documents.scan_progress?.current_file || '')}</p></div></div>` : ''}
    </section>
    <section class="feature-panel"><header><div><strong>${t('Detected local AI processes')}</strong><small>${t('Read-only view from the local process table')}</small></div></header><div class="incident-list">${aiProcesses.length ? aiProcesses.map(process => `<article class="incident-item severity-info"><span class="anomaly-dot"></span><div><strong>${escapeHTML(process.command)}</strong><small>PID ${process.pid} · CPU ${process.cpu_percent.toFixed(1)}% · RAM ${process.mem_percent.toFixed(1)}%</small><p>${escapeHTML(process.path)}</p></div></article>`).join('') : `<div class="feature-empty"><p>${t('No known local AI process is running.')}</p></div>`}</div></section>`
}

export async function loadAIMonitorView(): Promise<void> {
  loading = true; render()
  try {
    const [resources, toolSnapshot, library] = await Promise.all([api.resources(), api.tools(), api.documentLibrary()])
    processes = resources.processes || []; tools = toolSnapshot.tools || []; documents = library
  } catch (error) {
    showError(String(error))
  } finally { loading = false; render() }
}

export function initAIMonitorView(): void {
  document.getElementById('ai-monitor-content')?.addEventListener('click', event => {
    if ((event.target as HTMLElement).closest('#ai-monitor-refresh')) void loadAIMonitorView()
  })
}
