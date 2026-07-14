// Tools > Utilities: small self-contained developer utilities (generators,
// encoders, format converters) — entirely client-side, no Go binding. The
// only external dependencies are `qrcode` (QR Code Generator) and `mermaid`
// (diagram rendering inside Markdown Preview's ```mermaid fences) —
// everything else, including hashing (native Web Crypto, plus a small
// bundled MD5 since that's not in Web Crypto), diffing, and the Markdown
// parser itself, is hand-rolled. Unlike the rest of the app, each utility
// binds its own event listeners directly (scoped to the element it just
// created) instead of going through main.ts's shared delegated click
// handler — funneling dozens of independent, purely-local widgets through
// that one dispatcher would bloat it for no benefit, since nothing here
// touches any other view's state. main.ts only needs to call
// initUtilitiesView() once, the first time this subtab is opened.
import { copyToClipboard } from '../clipboard'
import { escapeHTML } from '../dom'
import { getTheme } from '../theme'
import QRCode from 'qrcode'
import mermaid from 'mermaid'

interface UtilityTool {
  id: string
  name: string
  category: string
  mount: (container: HTMLElement) => void
}

let initialized = false
let activeToolId = ''
let searchQuery = ''

export function initUtilitiesView(): void {
  const root = document.getElementById('utilities-content')
  if (!root || initialized) return
  initialized = true

  root.innerHTML = `
    <div class="utilities-layout">
      <div class="utilities-sidebar">
        <input id="utilities-search" class="search-input" type="search" placeholder="Search tools..." autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false">
        <div class="utilities-list" id="utilities-list"></div>
      </div>
      <div class="utilities-detail" id="utilities-detail">
        <div class="empty compact">Pick a tool from the list.</div>
      </div>
    </div>`

  document.getElementById('utilities-search')!.addEventListener('input', event => {
    searchQuery = (event.target as HTMLInputElement).value.trim().toLowerCase()
    renderList()
  })

  renderList()
  if (tools.length) selectTool(tools[0].id)
}

function renderList(): void {
  const list = document.getElementById('utilities-list')
  if (!list) return
  const filtered = tools.filter(t => !searchQuery || t.name.toLowerCase().includes(searchQuery) || t.category.toLowerCase().includes(searchQuery))
  const byCategory = new Map<string, UtilityTool[]>()
  for (const t of filtered) {
    const list = byCategory.get(t.category) || []
    list.push(t)
    byCategory.set(t.category, list)
  }
  list.innerHTML = [...byCategory.entries()].map(([category, items]) => `
    <div class="utilities-category">${category}</div>
    ${items.map(t => `<button class="utilities-list-item ${t.id === activeToolId ? 'active' : ''}" data-utility-id="${t.id}">${t.name}</button>`).join('')}
  `).join('') || '<div class="empty compact">No tools match.</div>'

  list.querySelectorAll<HTMLButtonElement>('[data-utility-id]').forEach(btn => {
    btn.addEventListener('click', () => selectTool(btn.dataset.utilityId!))
  })
}

function selectTool(id: string): void {
  activeToolId = id
  renderList()
  const detail = document.getElementById('utilities-detail')
  if (!detail) return
  const tool = tools.find(t => t.id === id)
  if (!tool) return
  detail.innerHTML = ''
  const heading = document.createElement('h3')
  heading.className = 'utilities-detail-title'
  heading.textContent = tool.name
  detail.appendChild(heading)
  const body = document.createElement('div')
  body.className = 'utilities-detail-body'
  detail.appendChild(body)
  tool.mount(body)
}

// ---- Shared IO panel builder ----------------------------------------

interface IOPanelOptions {
  inputLabel: string
  outputLabel: string
  actionLabel: string
  placeholder?: string
  transform: (input: string) => string | Promise<string>
  liveUpdate?: boolean // run transform on every keystroke instead of needing a button click
  // Optional: render the transform's return value as actual HTML (e.g. a
  // rendered Markdown preview) instead of dumping it into a plain readonly
  // textarea — same idea as buildTwoInputPanel's renderOutput. "Copy result"
  // still copies transform's raw string return value, not the rendered DOM.
  renderOutput?: (result: string) => string
  // Called right after renderOutput's HTML lands in the DOM — e.g. to run
  // Mermaid's async diagram rendering against the freshly-inserted
  // `.mermaid` elements, which can't be done from renderOutput itself since
  // that only returns a string. Only meaningful alongside renderOutput.
  afterRender?: (outputEl: HTMLElement) => void
}

// Builds the common "textarea in -> button -> textarea out (+ Copy)" shape
// most of these utilities share, wiring it up and returning the elements in
// case a caller needs to add more controls (e.g. JWT's secret/key input).
function buildIOPanel(container: HTMLElement, opts: IOPanelOptions): { input: HTMLTextAreaElement; run: () => void } {
  const wrap = document.createElement('div')
  wrap.className = 'utility-io-panel'
  wrap.innerHTML = `
    <label class="utility-field">
      <span>${opts.inputLabel}</span>
      <textarea class="utility-textarea" placeholder="${opts.placeholder || ''}"></textarea>
    </label>
    <div class="security-toolbar"><button class="btn-primary utility-run-btn">${opts.actionLabel}</button></div>
    <label class="utility-field">
      <span>${opts.outputLabel}</span>
      ${opts.renderOutput ? `
        <div class="utility-preview-container">
          <div class="security-toolbar"><button class="btn-secondary utility-maximize-btn" type="button">Maximize</button></div>
          <div class="utility-textarea utility-rendered-output"></div>
        </div>` : '<textarea class="utility-textarea" readonly></textarea>'}
    </label>
    <div class="security-toolbar"><button class="btn-secondary utility-copy-btn">Copy result</button></div>
    <p class="resource-detail tool-action-failed utility-error" style="display:none"></p>`
  container.appendChild(wrap)

  const input = wrap.querySelector<HTMLTextAreaElement>('.utility-textarea')!
  const previewOutput = wrap.querySelector<HTMLElement>('.utility-rendered-output')
  const textOutput = wrap.querySelector<HTMLTextAreaElement>('.utility-textarea[readonly]')
  const errorEl = wrap.querySelector<HTMLElement>('.utility-error')!
  const runBtn = wrap.querySelector<HTMLButtonElement>('.utility-run-btn')!

  let resultText = ''
  const setOutput = (value: string) => {
    resultText = value
    if (previewOutput) {
      previewOutput.innerHTML = opts.renderOutput!(value)
      if (opts.afterRender) opts.afterRender(previewOutput)
    } else if (textOutput) {
      textOutput.value = value
    }
  }

  // "Maximize" expands the preview to near-fullscreen (a backdrop click or
  // "Restore" shrinks it back) — same pattern as Source Control's file
  // viewer (.file-view.maximized in style.css), reused here since a
  // rendered Markdown/Mermaid preview benefits from the same "see more of
  // it at once" need as a long file does. The toggle/click target the
  // *container* (toolbar + preview), not the preview div alone — the
  // preview div's innerHTML gets fully replaced on every render, which
  // would otherwise destroy a "Restore" button placed inside it.
  const previewContainer = wrap.querySelector<HTMLElement>('.utility-preview-container')
  const maximizeBtn = wrap.querySelector<HTMLButtonElement>('.utility-maximize-btn')
  let previewBackdrop: HTMLElement | null = null
  const setMaximized = (on: boolean) => {
    if (!previewContainer) return
    previewContainer.classList.toggle('maximized', on)
    if (maximizeBtn) maximizeBtn.textContent = on ? 'Restore' : 'Maximize'
    if (on && !previewBackdrop) {
      previewBackdrop = document.createElement('div')
      previewBackdrop.className = 'utility-preview-backdrop'
      previewBackdrop.addEventListener('click', () => setMaximized(false))
      // Appended inside wrap (not document.body) so switching to a
      // different utility tool — which clears this tool's container via
      // innerHTML = '' — removes the backdrop along with everything else,
      // instead of leaking an undismissable full-screen overlay.
      wrap.appendChild(previewBackdrop)
    } else if (!on && previewBackdrop) {
      previewBackdrop.remove()
      previewBackdrop = null
    }
  }
  maximizeBtn?.addEventListener('click', () => setMaximized(!previewContainer?.classList.contains('maximized')))

  const run = () => {
    try {
      const result = opts.transform(input.value)
      if (result instanceof Promise) {
        result.then(value => { setOutput(value); errorEl.style.display = 'none' })
          .catch(error => { setOutput(''); errorEl.textContent = String(error instanceof Error ? error.message : error); errorEl.style.display = 'block' })
      } else {
        setOutput(result)
        errorEl.style.display = 'none'
      }
    } catch (error) {
      setOutput('')
      errorEl.textContent = String(error instanceof Error ? error.message : error)
      errorEl.style.display = 'block'
    }
  }
  runBtn.addEventListener('click', run)
  if (opts.liveUpdate) input.addEventListener('input', run)

  wrap.querySelector('.utility-copy-btn')!.addEventListener('click', () => {
    void copyToClipboard(resultText, `Utilities: ${opts.outputLabel}`)
  })

  return { input, run }
}

// For tools that take two separate text inputs (compare, diff): same
// left-pane / middle-toolbar / right-pane shape as buildBidirectionalPanel,
// but the middle strip holds one "Compare" action (not two opposing
// transforms) and the result renders full-width below both panes.
function buildTwoInputPanel(container: HTMLElement, opts: {
  labelA: string
  labelB: string
  outputLabel: string
  actionLabel: string
  transform: (a: string, b: string) => string
  // Optional: render the plain-text result as colorized HTML (e.g. Text
  // Diff's +/- lines) instead of dumping it into a plain readonly textarea.
  // "Copy result" still copies opts.transform's plain-text return value.
  renderOutput?: (result: string) => string
}): void {
  const wrap = document.createElement('div')
  wrap.className = 'utility-io-panel'
  wrap.innerHTML = `
    <div class="utility-bidirectional">
      <div class="utility-bidirectional-pane">
        <span class="utility-pane-label">${opts.labelA}</span>
        <textarea class="utility-textarea utility-input-a"></textarea>
      </div>
      <div class="utility-bidirectional-controls">
        <button class="btn-primary utility-run-btn">${opts.actionLabel}</button>
      </div>
      <div class="utility-bidirectional-pane">
        <span class="utility-pane-label">${opts.labelB}</span>
        <textarea class="utility-textarea utility-input-b"></textarea>
      </div>
    </div>
    <label class="utility-field"><span>${opts.outputLabel}</span>${
      opts.renderOutput ? '<pre class="utility-textarea utility-html-output"></pre>' : '<textarea class="utility-textarea" readonly></textarea>'
    }</label>
    <div class="security-toolbar"><button class="btn-secondary utility-copy-btn">Copy result</button></div>
    <p class="resource-detail tool-action-failed utility-error" style="display:none"></p>`
  container.appendChild(wrap)

  const inputA = wrap.querySelector<HTMLTextAreaElement>('.utility-input-a')!
  const inputB = wrap.querySelector<HTMLTextAreaElement>('.utility-input-b')!
  const htmlOutput = wrap.querySelector<HTMLElement>('.utility-html-output')
  const textOutput = wrap.querySelector<HTMLTextAreaElement>('.utility-textarea[readonly]')
  const errorEl = wrap.querySelector<HTMLElement>('.utility-error')!
  let resultText = ''
  const setOutput = (value: string) => {
    resultText = value
    if (htmlOutput) htmlOutput.innerHTML = opts.renderOutput!(value)
    else if (textOutput) textOutput.value = value
  }
  wrap.querySelector('.utility-run-btn')!.addEventListener('click', () => {
    try {
      setOutput(opts.transform(inputA.value, inputB.value))
      errorEl.style.display = 'none'
    } catch (error) {
      setOutput('')
      errorEl.textContent = String(error instanceof Error ? error.message : error)
      errorEl.style.display = 'block'
    }
  })
  wrap.querySelector('.utility-copy-btn')!.addEventListener('click', () => {
    void copyToClipboard(resultText, `Utilities: ${opts.outputLabel}`)
  })
}

// For genuinely bidirectional pairs (encode<->decode, CSV<->JSON, timestamp
// <->date): two editable panes side by side with a middle control strip,
// instead of two independent input->output panels — matches how a real
// left/right editor with a transform toolbar in between reads, and halves
// the number of textareas from four down to two. Both panes are always
// editable, and each transform button runs "explicitly" (no liveUpdate)
// since auto-transforming while the OTHER pane might also be mid-edit
// would fight itself.
function buildBidirectionalPanel(container: HTMLElement, opts: {
  leftLabel: string
  rightLabel: string
  toRightLabel: string
  toLeftLabel: string
  toRight: (s: string) => string
  toLeft: (s: string) => string
}): void {
  const wrap = document.createElement('div')
  wrap.className = 'utility-io-panel'
  wrap.innerHTML = `
    <div class="utility-bidirectional">
      <div class="utility-bidirectional-pane">
        <span class="utility-pane-label">${opts.leftLabel}</span>
        <textarea class="utility-textarea utility-pane-left"></textarea>
        <button class="btn-secondary utility-copy-left">Copy</button>
      </div>
      <div class="utility-bidirectional-controls">
        <button class="btn-primary utility-to-right">${opts.toRightLabel} →</button>
        <button class="btn-primary utility-to-left">← ${opts.toLeftLabel}</button>
      </div>
      <div class="utility-bidirectional-pane">
        <span class="utility-pane-label">${opts.rightLabel}</span>
        <textarea class="utility-textarea utility-pane-right"></textarea>
        <button class="btn-secondary utility-copy-right">Copy</button>
      </div>
    </div>
    <p class="resource-detail tool-action-failed utility-error" style="display:none"></p>`
  container.appendChild(wrap)

  const left = wrap.querySelector<HTMLTextAreaElement>('.utility-pane-left')!
  const right = wrap.querySelector<HTMLTextAreaElement>('.utility-pane-right')!
  const errorEl = wrap.querySelector<HTMLElement>('.utility-error')!

  const showError = (error: unknown) => {
    errorEl.textContent = String(error instanceof Error ? error.message : error)
    errorEl.style.display = 'block'
  }
  const clearError = () => { errorEl.style.display = 'none' }

  wrap.querySelector('.utility-to-right')!.addEventListener('click', () => {
    try { right.value = opts.toRight(left.value); clearError() } catch (error) { showError(error) }
  })
  wrap.querySelector('.utility-to-left')!.addEventListener('click', () => {
    try { left.value = opts.toLeft(right.value); clearError() } catch (error) { showError(error) }
  })
  wrap.querySelector('.utility-copy-left')!.addEventListener('click', () => void copyToClipboard(left.value, `Utilities: ${opts.leftLabel}`))
  wrap.querySelector('.utility-copy-right')!.addEventListener('click', () => void copyToClipboard(right.value, `Utilities: ${opts.rightLabel}`))
}

function buildGeneratorPanel(container: HTMLElement, label: string, generate: () => string): void {
  const wrap = document.createElement('div')
  wrap.className = 'utility-io-panel'
  wrap.innerHTML = `
    <div class="security-toolbar"><button class="btn-primary utility-run-btn">Generate</button></div>
    <label class="utility-field">
      <span>${label}</span>
      <textarea class="utility-textarea" readonly></textarea>
    </label>
    <div class="security-toolbar"><button class="btn-secondary utility-copy-btn">Copy result</button></div>`
  container.appendChild(wrap)
  const output = wrap.querySelector<HTMLTextAreaElement>('.utility-textarea')!
  const fill = () => { output.value = generate() }
  wrap.querySelector('.utility-run-btn')!.addEventListener('click', fill)
  wrap.querySelector('.utility-copy-btn')!.addEventListener('click', () => {
    void copyToClipboard(output.value, `Utilities: ${label}`)
  })
  fill()
}

// ---- Generators --------------------------------------------------------

function uuidV7(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  const ts = BigInt(Date.now())
  bytes[0] = Number((ts >> 40n) & 0xffn)
  bytes[1] = Number((ts >> 32n) & 0xffn)
  bytes[2] = Number((ts >> 24n) & 0xffn)
  bytes[3] = Number((ts >> 16n) & 0xffn)
  bytes[4] = Number((ts >> 8n) & 0xffn)
  bytes[5] = Number(ts & 0xffn)
  bytes[6] = (bytes[6] & 0x0f) | 0x70
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const NANOID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'
function nanoid(size = 21): string {
  const bytes = new Uint8Array(size)
  crypto.getRandomValues(bytes)
  let id = ''
  for (let i = 0; i < size; i++) id += NANOID_ALPHABET[bytes[i] & 63]
  return id
}

// Crockford base32 (no I/L/O/U) — 10 chars of ms timestamp + 16 chars
// (80 bits) of randomness = 26 chars total, per the ULID spec.
const ULID_ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
function ulid(): string {
  let t = BigInt(Date.now())
  let timeStr = ''
  for (let i = 0; i < 10; i++) {
    timeStr = ULID_ENCODING[Number(t % 32n)] + timeStr
    t /= 32n
  }
  const randomBytes = new Uint8Array(10)
  crypto.getRandomValues(randomBytes)
  let bits = 0n
  for (const b of randomBytes) bits = (bits << 8n) | BigInt(b)
  let randStr = ''
  for (let i = 0; i < 16; i++) {
    randStr = ULID_ENCODING[Number(bits & 31n)] + randStr
    bits >>= 5n
  }
  return timeStr + randStr
}

// ---- Fake data -----------------------------------------------------------

const FAKE_FIRST_NAMES = ['James', 'Mary', 'John', 'Patricia', 'Robert', 'Jennifer', 'Michael', 'Linda', 'William', 'Elizabeth', 'David', 'Barbara', 'Richard', 'Susan', 'Joseph', 'Jessica']
const FAKE_LAST_NAMES = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez', 'Hernandez', 'Lopez', 'Wilson', 'Anderson']
const FAKE_DOMAINS = ['example.com', 'mail.com', 'test.org', 'demo.io']
const FAKE_STREETS = ['Main St', 'Oak Ave', 'Maple Dr', 'Cedar Ln', 'Elm St', 'Park Ave']
const FAKE_CITIES = ['Springfield', 'Riverside', 'Franklin', 'Georgetown', 'Salem', 'Clinton']

function randomItem<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function fakePerson(): Record<string, string> {
  const first = randomItem(FAKE_FIRST_NAMES)
  const last = randomItem(FAKE_LAST_NAMES)
  const phone = () => String(Math.floor(Math.random() * 900 + 100))
  return {
    id: crypto.randomUUID(),
    name: `${first} ${last}`,
    email: `${first.toLowerCase()}.${last.toLowerCase()}@${randomItem(FAKE_DOMAINS)}`,
    phone: `+1-${phone()}-${phone()}-${String(Math.floor(Math.random() * 9000 + 1000))}`,
    address: `${Math.floor(Math.random() * 9000 + 100)} ${randomItem(FAKE_STREETS)}, ${randomItem(FAKE_CITIES)}`,
  }
}

function generateFakeData(count: number): string {
  if (!Number.isFinite(count) || count < 1 || count > 100) throw new Error('Enter a count between 1 and 100')
  return JSON.stringify(Array.from({ length: Math.floor(count) }, fakePerson), null, 2)
}

// ---- Encoding helpers ---------------------------------------------------

function base64Encode(s: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(s)))
}
function base64Decode(s: string): string {
  return new TextDecoder().decode(Uint8Array.from(atob(s), c => c.charCodeAt(0)))
}

function htmlEncode(s: string): string {
  const div = document.createElement('div')
  div.textContent = s
  return div.innerHTML
}
function htmlDecode(s: string): string {
  const div = document.createElement('div')
  div.innerHTML = s
  return div.textContent || ''
}

function unicodeEscape(s: string): string {
  return [...s].map(c => {
    const code = c.codePointAt(0)!
    return code > 127 ? '\\u' + code.toString(16).padStart(4, '0') : c
  }).join('')
}
function unicodeUnescape(s: string): string {
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
}

// ---- Markdown -> HTML (best-effort, hand-rolled — not full CommonMark) ---
// Covers headings, fenced code blocks, blockquotes, ul/ol lists, hr,
// paragraphs, and the common inline spans (bold/italic/strikethrough/code/
// links/images). Single-underscore italics (_like this_) is deliberately
// not supported — it would misfire on ordinary snake_case identifiers,
// which show up constantly in dev-focused Markdown.

// Inline code is extracted first and replaced with a placeholder before any
// other span regex runs, so markdown-looking characters *inside* a code
// span (e.g. `a*b*c`) are never mistaken for real emphasis syntax.
function renderInlineMarkdown(text: string): string {
  let s = escapeHTML(text)
  const codeSpans: string[] = []
  s = s.replace(/`([^`]+)`/g, (_, code) => {
    codeSpans.push(`<code>${code}</code>`)
    return ` ${codeSpans.length - 1} `
  })
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, alt, url) => `<img src="${url}" alt="${alt}">`)
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_, label, url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`)
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>')
  s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>')
  s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>')
  s = s.replace(/ (\d+) /g, (_, i) => codeSpans[Number(i)])
  return s
}

function markdownToHTML(md: string): string {
  const lines = md.replace(/\r\n?/g, '\n').split('\n')
  const html: string[] = []
  let paragraph: string[] = []
  let listItems: string[] = []
  let listType: 'ul' | 'ol' | null = null

  const flushParagraph = () => {
    if (paragraph.length) {
      html.push(`<p>${renderInlineMarkdown(paragraph.join(' '))}</p>`)
      paragraph = []
    }
  }
  const flushList = () => {
    if (listItems.length && listType) {
      const items = listItems.map(item => `<li>${renderInlineMarkdown(item)}</li>`).join('')
      html.push(`<${listType}>${items}</${listType}>`)
    }
    listItems = []
    listType = null
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]

    const fence = line.match(/^```(\w*)\s*$/)
    if (fence) {
      flushParagraph(); flushList()
      const lang = fence[1]
      const codeLines: string[] = []
      i++
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i])
        i++
      }
      i++ // skip the closing fence
      if (lang.toLowerCase() === 'mermaid') {
        // Rendered separately, after this HTML is inserted into the DOM —
        // see the Markdown Preview tool's afterRender hook, which calls
        // mermaid.run() against every ".mermaid" element. escapeHTML here
        // is just to inject the source safely as HTML; mermaid reads it
        // back out via .textContent, which un-escapes it again.
        html.push(`<div class="mermaid">${escapeHTML(codeLines.join('\n'))}</div>`)
      } else {
        const cls = lang ? ` class="language-${escapeHTML(lang)}"` : ''
        html.push(`<pre><code${cls}>${escapeHTML(codeLines.join('\n'))}</code></pre>`)
      }
      continue
    }

    if (line.trim() === '') {
      flushParagraph(); flushList()
      i++
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/)
    if (heading) {
      flushParagraph(); flushList()
      const level = heading[1].length
      html.push(`<h${level}>${renderInlineMarkdown(heading[2].trim())}</h${level}>`)
      i++
      continue
    }

    if (/^ {0,3}([-*_])(?: *\1){2,}\s*$/.test(line)) {
      flushParagraph(); flushList()
      html.push('<hr>')
      i++
      continue
    }

    if (/^\s*>\s?/.test(line)) {
      flushParagraph(); flushList()
      const quoteLines: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ''))
        i++
      }
      html.push(`<blockquote>${quoteLines.map(renderInlineMarkdown).join('<br>')}</blockquote>`)
      continue
    }

    const ulItem = line.match(/^\s*[-*+]\s+(.*)$/)
    if (ulItem) {
      flushParagraph()
      if (listType !== 'ul') flushList()
      listType = 'ul'
      listItems.push(ulItem[1])
      i++
      continue
    }

    const olItem = line.match(/^\s*\d+\.\s+(.*)$/)
    if (olItem) {
      flushParagraph()
      if (listType !== 'ol') flushList()
      listType = 'ol'
      listItems.push(olItem[1])
      i++
      continue
    }

    flushList()
    paragraph.push(line.trim())
    i++
  }
  flushParagraph()
  flushList()
  return html.join('\n')
}

// mermaid.initialize() is global and only meant to be called once; matches
// the app's theme at the moment Markdown Preview is first opened (not
// dynamically reactive to later theme toggles — re-rendering the diagram,
// e.g. by editing the input again, is enough to pick up a new session's
// theme choice without adding a live theme-change listener for this one
// case).
let mermaidInitialized = false
function ensureMermaidInitialized(): void {
  if (mermaidInitialized) return
  mermaidInitialized = true
  mermaid.initialize({ startOnLoad: false, theme: getTheme() === 'light' ? 'default' : 'dark' })
}

// ---- XML formatting (simple, regex-based indenter) ---------------------

function formatXML(xml: string): string {
  const parsed = new DOMParser().parseFromString(xml, 'application/xml')
  if (parsed.querySelector('parsererror')) throw new Error('Invalid XML')
  const withBreaks = xml.trim().replace(/>\s*</g, '>\n<')
  let pad = 0
  return withBreaks.split('\n').map(line => {
    line = line.trim()
    if (/^<\/.+>$/.test(line)) pad = Math.max(pad - 1, 0)
    const indented = '  '.repeat(pad) + line
    if (/^<[^!?/][^>]*[^/]>$/.test(line)) pad += 1
    return indented
  }).join('\n')
}

// ---- CSV <-> JSON --------------------------------------------------------

function parseCSVLine(line: string): string[] {
  const fields: string[] = []
  let cur = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (c === '"') inQuotes = false
      else cur += c
    } else if (c === '"') inQuotes = true
    else if (c === ',') { fields.push(cur); cur = '' }
    else cur += c
  }
  fields.push(cur)
  return fields
}

function csvToJSON(csv: string): string {
  const lines = csv.split(/\r?\n/).filter(l => l.length > 0)
  if (!lines.length) return '[]'
  const headers = parseCSVLine(lines[0])
  const rows = lines.slice(1).map(line => {
    const values = parseCSVLine(line)
    const obj: Record<string, string> = {}
    headers.forEach((h, i) => { obj[h] = values[i] ?? '' })
    return obj
  })
  return JSON.stringify(rows, null, 2)
}

function csvField(value: unknown): string {
  const s = String(value ?? '')
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

function jsonToCSV(json: string): string {
  const data = JSON.parse(json)
  if (!Array.isArray(data) || !data.length) throw new Error('Expected a non-empty JSON array of objects')
  const headers = Object.keys(data[0])
  const lines = [headers.map(csvField).join(',')]
  for (const row of data) lines.push(headers.map(h => csvField(row[h])).join(','))
  return lines.join('\n')
}

// ---- Hashing ---------------------------------------------------------

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

// MD5 isn't in Web Crypto (it's considered broken for security use, but
// still commonly wanted for non-security checksums) — this is the
// standard public-domain bitwise implementation, condensed.
function md5(input: string): string {
  const rotl = (x: number, c: number) => (x << c) | (x >>> (32 - c))
  function toWords(s: string): number[] {
    const bytes = new TextEncoder().encode(s)
    const words: number[] = new Array((((bytes.length + 8) >> 6) + 1) * 16).fill(0)
    for (let i = 0; i < bytes.length; i++) words[i >> 2] |= bytes[i] << ((i % 4) * 8)
    words[bytes.length >> 2] |= 0x80 << ((bytes.length % 4) * 8)
    words[words.length - 2] = bytes.length * 8
    return words
  }
  const K = [
    0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613, 0xfd469501,
    0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193, 0xa679438e, 0x49b40821,
    0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d, 0x02441453, 0xd8a1e681, 0xe7d3fbc8,
    0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed, 0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a,
    0xfffa3942, 0x8771f681, 0x6d9d6122, 0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70,
    0x289b7ec6, 0xeaa127fa, 0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665,
    0xf4292244, 0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
    0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb, 0xeb86d391,
  ]
  const S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21]
  const words = toWords(input)
  let [a0, b0, c0, d0] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]
  for (let chunk = 0; chunk < words.length; chunk += 16) {
    let [a, b, c, d] = [a0, b0, c0, d0]
    for (let i = 0; i < 64; i++) {
      let f: number, g: number
      if (i < 16) { f = (b & c) | (~b & d); g = i }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16 }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16 }
      else { f = c ^ (b | ~d); g = (7 * i) % 16 }
      const temp = d
      d = c; c = b
      b = (b + rotl((a + f + K[i] + (words[chunk + g] | 0)) | 0, S[i])) | 0
      a = temp
    }
    a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0
  }
  const toLE = (n: number) => {
    const bytes = [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]
    return bytes.map(b => b.toString(16).padStart(2, '0')).join('')
  }
  return toLE(a0) + toLE(b0) + toLE(c0) + toLE(d0)
}

async function hashText(text: string): Promise<string> {
  const data = new TextEncoder().encode(text)
  const lines = [`MD5:    ${md5(text)}`]
  for (const algo of ['SHA-1', 'SHA-256', 'SHA-384', 'SHA-512'] as const) {
    lines.push(`${algo}: ${toHex(await crypto.subtle.digest(algo, data))}`)
  }
  return lines.join('\n')
}

// ---- Timestamp -------------------------------------------------------

function timestampToDate(input: string): string {
  const trimmed = input.trim()
  const n = Number(trimmed)
  if (Number.isNaN(n)) throw new Error('Not a number')
  const ms = trimmed.length > 10 ? n : n * 1000 // 10 digits ~ seconds, 13 ~ milliseconds
  const d = new Date(ms)
  if (Number.isNaN(d.getTime())) throw new Error('Invalid timestamp')
  return `ISO:   ${d.toISOString()}\nUTC:   ${d.toUTCString()}\nLocal: ${d.toString()}`
}

function dateToTimestamp(input: string): string {
  const d = new Date(input.trim())
  if (Number.isNaN(d.getTime())) throw new Error('Invalid date — try an ISO string like 2026-07-13T10:00:00Z')
  return `Seconds:      ${Math.floor(d.getTime() / 1000)}\nMilliseconds: ${d.getTime()}`
}

// ---- Regex tester ------------------------------------------------------

function testRegex(pattern: string, flags: string, text: string): string {
  let re: RegExp
  try {
    re = new RegExp(pattern, flags.includes('g') ? flags : flags + 'g')
  } catch (error) {
    throw new Error(`Invalid regex: ${error instanceof Error ? error.message : error}`)
  }
  const matches = [...text.matchAll(re)]
  if (!matches.length) return 'No matches.'
  return matches.map((m, i) => {
    const groups = m.length > 1 ? `\n  Groups: ${JSON.stringify(m.slice(1))}` : ''
    return `Match ${i + 1}: "${m[0]}" at index ${m.index}${groups}`
  }).join('\n')
}

// ---- Curl converter ------------------------------------------------------

function tokenizeShellCommand(s: string): string[] {
  const tokens: string[] = []
  let cur = ''
  let quote: string | null = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < s.length) { cur += s[++i] }
      else cur += c
    } else if (c === '"' || c === "'") quote = c
    else if (c === '\\' && s[i + 1] === '\n') i++
    else if (/\s/.test(c)) { if (cur) { tokens.push(cur); cur = '' } }
    else cur += c
  }
  if (cur) tokens.push(cur)
  return tokens
}

function convertCurl(input: string): string {
  const tokens = tokenizeShellCommand(input.trim().replace(/\\\n/g, ' '))
  if (tokens[0] === 'curl') tokens.shift()
  let method = 'GET'
  let url = ''
  const headers: Record<string, string> = {}
  let body: string | undefined
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === '-X' || t === '--request') method = tokens[++i]
    else if (t === '-H' || t === '--header') {
      const h = tokens[++i] || ''
      const idx = h.indexOf(':')
      if (idx > 0) headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim()
    } else if (t === '-d' || t === '--data' || t === '--data-raw' || t === '--data-binary') {
      body = tokens[++i]
      if (method === 'GET') method = 'POST'
    } else if (t === '-u' || t === '--user') {
      headers['Authorization'] = 'Basic ' + btoa(tokens[++i] || '')
    } else if (!t.startsWith('-') && !url) {
      url = t
    }
  }
  if (!url) throw new Error('No URL found in curl command')
  const headersBlock = Object.keys(headers).length ? JSON.stringify(headers, null, 2).replace(/\n/g, '\n  ') : '{}'
  const fetchCode = `fetch(${JSON.stringify(url)}, {\n  method: ${JSON.stringify(method)},\n  headers: ${headersBlock},${body ? `\n  body: ${JSON.stringify(body)},` : ''}\n})`
  return `// Parsed\nMethod: ${method}\nURL: ${url}\nHeaders: ${JSON.stringify(headers, null, 2)}${body ? `\nBody: ${body}` : ''}\n\n// fetch() equivalent\n${fetchCode}`
}

// ---- SQL formatter ---------------------------------------------------

const SQL_BREAK_KEYWORDS = ['SELECT', 'FROM', 'WHERE', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'OUTER JOIN', 'JOIN', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET', 'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'UNION ALL', 'UNION']

// Best-effort keyword-based beautifier (not a real SQL parser) — puts
// major clauses on their own line and indents AND/OR continuations, which
// covers the common case of "one long line" queries well enough to read.
function formatSQL(sql: string): string {
  let formatted = sql.replace(/\s+/g, ' ').trim()
  for (const kw of SQL_BREAK_KEYWORDS) {
    const re = new RegExp(`\\b${kw.replace(/ /g, '\\s+')}\\b`, 'gi')
    formatted = formatted.replace(re, `\n${kw}`)
  }
  formatted = formatted.replace(/\bAND\b/gi, '\n  AND').replace(/\bOR\b/gi, '\n  OR')
  return formatted.split('\n').map(l => l.trim()).filter(Boolean).join('\n')
}

// ---- Text diff (LCS-based line diff) ----------------------------------

function diffText(a: string, b: string): string {
  const linesA = a.split('\n')
  const linesB = b.split('\n')
  const n = linesA.length
  const m = linesB.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = linesA[i] === linesB[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const result: string[] = []
  let i = 0, j = 0
  while (i < n && j < m) {
    if (linesA[i] === linesB[j]) { result.push('  ' + linesA[i]); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { result.push('- ' + linesA[i]); i++ }
    else { result.push('+ ' + linesB[j]); j++ }
  }
  while (i < n) { result.push('- ' + linesA[i]); i++ }
  while (j < m) { result.push('+ ' + linesB[j]); j++ }
  return result.length ? result.join('\n') : 'Identical.'
}

// Colorizes diffText's plain "+ /- /  " prefixed lines the same way the
// app's own commit/PR diff viewer does, so an unrelated wall of monospace
// text isn't the only way to tell what changed.
function renderDiffHTML(diffOutput: string): string {
  return diffOutput.split('\n').map(line => {
    const cls = line.startsWith('+') ? ' diff-add' : line.startsWith('-') ? ' diff-del' : ''
    return `<span class="diff-line${cls}">${escapeHTML(line) || '&nbsp;'}</span>`
  }).join('')
}

// ---- Case converter ------------------------------------------------------

function splitWords(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(w => w.toLowerCase())
}

function toCaseVariants(s: string): string {
  const words = splitWords(s)
  if (!words.length) return ''
  const cap = (w: string) => w[0].toUpperCase() + w.slice(1)
  const camel = words[0] + words.slice(1).map(cap).join('')
  const pascal = words.map(cap).join('')
  const snake = words.join('_')
  const kebab = words.join('-')
  const constant = words.join('_').toUpperCase()
  const title = words.map(cap).join(' ')
  const sentence = cap(words.join(' '))
  return [
    `camelCase:     ${camel}`,
    `PascalCase:    ${pascal}`,
    `snake_case:    ${snake}`,
    `kebab-case:    ${kebab}`,
    `CONSTANT_CASE: ${constant}`,
    `Title Case:    ${title}`,
    `Sentence case: ${sentence}`,
  ].join('\n')
}

// ---- JSON compare ------------------------------------------------------

function diffJSON(aText: string, bText: string): string {
  const a = JSON.parse(aText)
  const b = JSON.parse(bText)
  const lines: string[] = []
  const walk = (path: string, x: unknown, y: unknown) => {
    if (JSON.stringify(x) === JSON.stringify(y)) return
    const isPlainObj = (v: unknown) => v !== null && typeof v === 'object' && !Array.isArray(v)
    if (isPlainObj(x) && isPlainObj(y)) {
      const xo = x as Record<string, unknown>
      const yo = y as Record<string, unknown>
      const keys = new Set([...Object.keys(xo), ...Object.keys(yo)])
      for (const k of keys) {
        const p = path ? `${path}.${k}` : k
        const has1 = Object.prototype.hasOwnProperty.call(xo, k)
        const has2 = Object.prototype.hasOwnProperty.call(yo, k)
        if (!has2) lines.push(`- ${p}: ${JSON.stringify(xo[k])}`)
        else if (!has1) lines.push(`+ ${p}: ${JSON.stringify(yo[k])}`)
        else walk(p, xo[k], yo[k])
      }
    } else {
      lines.push(`~ ${path || '(root)'}: ${JSON.stringify(x)} -> ${JSON.stringify(y)}`)
    }
  }
  walk('', a, b)
  return lines.length ? lines.join('\n') : 'No differences.'
}

// ---- Cron parser -----------------------------------------------------

// Best-effort: supports lists (1,2,3), ranges (1-5), steps (*/5, 1-10/2),
// and * — enough for the vast majority of real crontab entries, though not
// every exotic vixie-cron extension.
function cronFieldMatches(value: number, field: string): boolean {
  for (const part of field.split(',')) {
    let step = 1
    let range = part
    if (part.includes('/')) {
      const [r, s] = part.split('/')
      range = r
      step = Number(s)
    }
    let lo: number, hi: number
    if (range === '*') { lo = -Infinity; hi = Infinity }
    else if (range.includes('-')) { const [a, b] = range.split('-').map(Number); lo = a; hi = b }
    else { lo = hi = Number(range) }
    if (value >= lo && value <= hi && (range === '*' ? value % step === 0 : (value - lo) % step === 0)) return true
  }
  return false
}

function cronNextRuns(fields: string[], count: number): string[] {
  const [minF, hourF, dayF, monthF, weekdayF] = fields
  const results: string[] = []
  const d = new Date()
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() + 1)
  let guard = 0
  while (results.length < count && guard < 2_000_000) {
    guard++
    if (
      cronFieldMatches(d.getMinutes(), minF) &&
      cronFieldMatches(d.getHours(), hourF) &&
      cronFieldMatches(d.getDate(), dayF) &&
      cronFieldMatches(d.getMonth() + 1, monthF) &&
      cronFieldMatches(d.getDay(), weekdayF)
    ) {
      results.push(d.toString())
    }
    d.setMinutes(d.getMinutes() + 1)
  }
  return results
}

function describeCron(expr: string): string {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) throw new Error('Expected 5 fields: minute hour day-of-month month day-of-week')
  const [min, hour, day, month, weekday] = fields
  const desc = `minute=${min}  hour=${hour}  day-of-month=${day}  month=${month}  day-of-week=${weekday}`
  const next = cronNextRuns(fields, 5)
  return `${desc}\n\nNext run${next.length === 1 ? '' : 's'}:\n${next.length ? next.join('\n') : '(none found in the next ~4 years)'}`
}

// ---- JWT decode/verify ---------------------------------------------------

function base64UrlDecode(s: string): Uint8Array {
  const normalized = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(s.length + ((4 - (s.length % 4)) % 4), '=')
  return Uint8Array.from(atob(normalized), c => c.charCodeAt(0))
}

function decodeJWT(token: string): { header: unknown; payload: unknown } {
  const parts = token.trim().split('.')
  if (parts.length < 2) throw new Error('Not a JWT (expected header.payload.signature)')
  const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0])))
  const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1])))
  return { header, payload }
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const base64 = pem.replace(/-----BEGIN [^-]+-----/, '').replace(/-----END [^-]+-----/, '').replace(/\s+/g, '')
  return Uint8Array.from(atob(base64), c => c.charCodeAt(0)).buffer
}

async function verifyJWT(token: string, key: string): Promise<string> {
  const parts = token.trim().split('.')
  if (parts.length !== 3) throw new Error('Not a JWT (expected header.payload.signature)')
  const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0])))
  const alg = header.alg
  const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  const signature = base64UrlDecode(parts[2])

  // Uint8Array.from()'s TS type doesn't quite satisfy BufferSource's
  // generic ArrayBuffer constraint under strict lib.dom typings — these are
  // concrete, non-shared buffers at runtime, so the cast is safe.
  const signatureBuf = signature.buffer as ArrayBuffer
  const signingInputBuf = signingInput.buffer as ArrayBuffer

  let valid: boolean
  if (alg === 'HS256') {
    const cryptoKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
    valid = await crypto.subtle.verify('HMAC', cryptoKey, signatureBuf, signingInputBuf)
  } else if (alg === 'RS256') {
    const cryptoKey = await crypto.subtle.importKey('spki', pemToArrayBuffer(key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
    valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, signatureBuf, signingInputBuf)
  } else {
    throw new Error(`Unsupported alg "${alg}" — only HS256 and RS256 are supported`)
  }
  return valid ? '✓ Signature valid' : '✗ Signature INVALID'
}

// ---- CIDR / subnet calculator ---------------------------------------------

function calculateCIDR(input: string): string {
  const m = input.trim().match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/)
  if (!m) throw new Error('Expected an IPv4 CIDR like 192.168.1.10/24')
  const octets = [m[1], m[2], m[3], m[4]].map(Number)
  if (octets.some(o => o > 255)) throw new Error('Octet out of range (0-255)')
  const prefix = Number(m[5])
  if (prefix < 0 || prefix > 32) throw new Error('Prefix must be between 0 and 32')

  const ipNum = ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0
  // A shift amount of 32 is a no-op in JS (treated mod 32), so /0 needs its
  // own case rather than falling out of the general formula.
  const maskNum = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  const networkNum = (ipNum & maskNum) >>> 0
  const wildcardNum = (~maskNum) >>> 0
  const broadcastNum = (networkNum | wildcardNum) >>> 0
  const toIP = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')
  const totalAddresses = Math.pow(2, 32 - prefix)

  let usable: string, firstHost: string, lastHost: string
  if (prefix >= 31) {
    usable = prefix === 32 ? '1 (host route)' : '2 (point-to-point, RFC 3021)'
    firstHost = toIP(networkNum)
    lastHost = toIP(broadcastNum)
  } else {
    usable = String(totalAddresses - 2)
    firstHost = toIP(networkNum + 1)
    lastHost = toIP(broadcastNum - 1)
  }

  return [
    `Network Address: ${toIP(networkNum)}`,
    `Broadcast Address: ${toIP(broadcastNum)}`,
    `Subnet Mask: ${toIP(maskNum)}`,
    `Wildcard Mask: ${toIP(wildcardNum)}`,
    `Prefix Length: /${prefix}`,
    `Total Addresses: ${totalAddresses}`,
    `Usable Hosts: ${usable}`,
    `First Usable Host: ${firstHost}`,
    `Last Usable Host: ${lastHost}`,
  ].join('\n')
}

// ---- .env compare (auto-masks secret-looking values) ----------------------

function parseEnvFile(text: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    map.set(key, value)
  }
  return map
}

const ENV_SECRET_KEY_PATTERN = /SECRET|TOKEN|PASSWORD|PASSWD|PWD|PASS|KEY|CREDENTIAL|PRIVATE/i

function diffEnv(a: string, b: string): string {
  const envA = parseEnvFile(a)
  const envB = parseEnvFile(b)
  const keys = [...new Set([...envA.keys(), ...envB.keys()])].sort()
  const lines: string[] = []
  for (const key of keys) {
    const inA = envA.has(key)
    const inB = envB.has(key)
    if (inA && !inB) {
      lines.push(`- ${key} (only in A)`)
    } else if (!inA && inB) {
      lines.push(`+ ${key} (only in B)`)
    } else if (envA.get(key) !== envB.get(key)) {
      lines.push(ENV_SECRET_KEY_PATTERN.test(key)
        ? `~ ${key} (value differs — hidden, looks like a secret)`
        : `~ ${key}: ${envA.get(key)}  →  ${envB.get(key)}`)
    }
  }
  return lines.length ? lines.join('\n') : 'No differences — every key present in both is identical.'
}

// ---- Certificate / CSR inspector (minimal hand-rolled ASN.1 DER reader) ---
// X.509 certs and PKCS#10 CSRs are both plain ASN.1 DER structures under the
// PEM wrapping — rather than pull in a parsing library, this walks the
// tag-length-value structure directly and reads just the handful of fields
// people actually check (subject/issuer/validity/serial/algorithms).
// Extensions (SAN, key usage, etc.) are deliberately out of scope: they're
// nested OCTET STRING-wrapped ASN.1 of their own, and a half-parsed
// extension list would be worse than none.

interface Asn1Node {
  tagClass: number
  constructed: boolean
  tagNumber: number
  content: Uint8Array
  children: Asn1Node[]
}

function parseAsn1(data: Uint8Array): Asn1Node[] {
  const nodes: Asn1Node[] = []
  let i = 0
  while (i < data.length) {
    const tagByte = data[i]
    const tagClass = tagByte >> 6
    const constructed = (tagByte & 0x20) !== 0
    let tagNumber = tagByte & 0x1f
    i++
    if (tagNumber === 0x1f) {
      tagNumber = 0
      while (data[i] & 0x80) { tagNumber = (tagNumber << 7) | (data[i] & 0x7f); i++ }
      tagNumber = (tagNumber << 7) | (data[i] & 0x7f)
      i++
    }
    let len = data[i]
    i++
    if (len & 0x80) {
      const numBytes = len & 0x7f
      len = 0
      for (let b = 0; b < numBytes; b++) { len = len * 256 + data[i]; i++ }
    }
    const content = data.slice(i, i + len)
    nodes.push({ tagClass, constructed, tagNumber, content, children: constructed ? parseAsn1(content) : [] })
    i += len
  }
  return nodes
}

const OID_NAMES: Record<string, string> = {
  '2.5.4.3': 'CN', '2.5.4.6': 'C', '2.5.4.7': 'L', '2.5.4.8': 'ST', '2.5.4.10': 'O', '2.5.4.11': 'OU',
  '1.2.840.113549.1.9.1': 'emailAddress',
  '1.2.840.113549.1.1.1': 'RSA', '1.2.840.10045.2.1': 'EC',
  '1.2.840.113549.1.1.5': 'SHA-1 with RSA', '1.2.840.113549.1.1.11': 'SHA-256 with RSA',
  '1.2.840.113549.1.1.12': 'SHA-384 with RSA', '1.2.840.113549.1.1.13': 'SHA-512 with RSA',
  '1.2.840.10045.4.3.2': 'ECDSA with SHA-256', '1.2.840.10045.4.3.3': 'ECDSA with SHA-384',
}

function decodeOID(bytes: Uint8Array): string {
  if (bytes.length === 0) return ''
  const parts: number[] = [Math.floor(bytes[0] / 40), bytes[0] % 40]
  let value = 0
  for (let i = 1; i < bytes.length; i++) {
    value = value * 128 + (bytes[i] & 0x7f)
    if (!(bytes[i] & 0x80)) { parts.push(value); value = 0 }
  }
  return parts.join('.')
}

function oidName(oid: string): string {
  return OID_NAMES[oid] || oid
}

function decodeName(seq: Asn1Node): string {
  // Name ::= RDNSequence ::= SEQUENCE OF RelativeDistinguishedName (itself
  // a SET OF AttributeTypeAndValue, though almost always one per RDN).
  const parts: string[] = []
  for (const rdn of seq.children) {
    for (const atv of rdn.children) {
      const [oidNode, valueNode] = atv.children
      if (!oidNode || !valueNode) continue
      parts.push(`${oidName(decodeOID(oidNode.content))}=${new TextDecoder().decode(valueNode.content)}`)
    }
  }
  return parts.join(', ')
}

function decodeAsn1Time(node: Asn1Node): string {
  const text = new TextDecoder().decode(node.content)
  const isUTC = node.tagNumber === 23 // UTCTime (2-digit year) vs GeneralizedTime (24, 4-digit year)
  const m = isUTC
    ? text.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/)
    : text.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/)
  if (!m) return text
  const year = isUTC ? (Number(m[1]) >= 50 ? 1900 : 2000) + Number(m[1]) : Number(m[1])
  return new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]))).toISOString()
}

async function sha256Fingerprint(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer)
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join(':').toUpperCase()
}

async function inspectCertOrCSR(pem: string): Promise<string> {
  const trimmed = pem.trim()
  const isCSR = /BEGIN CERTIFICATE REQUEST/.test(trimmed)
  const isCert = /BEGIN CERTIFICATE-----/.test(trimmed) && !isCSR
  if (!isCert && !isCSR) {
    throw new Error('Paste a PEM certificate (-----BEGIN CERTIFICATE-----) or CSR (-----BEGIN CERTIFICATE REQUEST-----)')
  }
  const der = new Uint8Array(pemToArrayBuffer(trimmed))
  const [top] = parseAsn1(der)
  if (!top || !top.children.length) throw new Error('Could not parse ASN.1 structure')

  if (isCSR) {
    const [reqInfo, sigAlgNode] = top.children
    const version = reqInfo.children[0].content[0] + 1
    const subject = decodeName(reqInfo.children[1])
    const pkOid = decodeOID(reqInfo.children[2].children[0].children[0].content)
    const sigOid = decodeOID(sigAlgNode.children[0].content)
    return [
      `Type: PKCS#10 Certificate Signing Request (v${version})`,
      `Subject: ${subject || '(none)'}`,
      `Public Key Algorithm: ${oidName(pkOid)}`,
      `Signature Algorithm: ${oidName(sigOid)}`,
    ].join('\n')
  }

  const tbs = top.children[0]
  let idx = 0
  let version = 1
  if (tbs.children[idx].tagClass === 2 && tbs.children[idx].tagNumber === 0) {
    version = tbs.children[idx].children[0].content[0] + 1
    idx++
  }
  const serial = Array.from(tbs.children[idx].content).map(b => b.toString(16).padStart(2, '0')).join(':')
  idx++
  const sigOid = decodeOID(tbs.children[idx].children[0].content)
  idx++
  const issuer = decodeName(tbs.children[idx])
  idx++
  const validity = tbs.children[idx]
  idx++
  const notBefore = decodeAsn1Time(validity.children[0])
  const notAfter = decodeAsn1Time(validity.children[1])
  const subject = decodeName(tbs.children[idx])
  idx++
  const pkOid = decodeOID(tbs.children[idx].children[0].children[0].content)
  const expired = new Date(notAfter) < new Date()
  const fingerprint = await sha256Fingerprint(der)

  return [
    `Type: X.509 Certificate (v${version})`,
    `Subject: ${subject || '(none)'}`,
    `Issuer: ${issuer || '(none)'}`,
    `Serial Number: ${serial}`,
    `Valid From: ${notBefore}`,
    `Valid Until: ${notAfter}${expired ? '  ⚠ EXPIRED' : ''}`,
    `Signature Algorithm: ${oidName(sigOid)}`,
    `Public Key Algorithm: ${oidName(pkOid)}`,
    `SHA-256 Fingerprint: ${fingerprint}`,
  ].join('\n')
}

// ---- Tool registry -------------------------------------------------------

const tools: UtilityTool[] = [
  { id: 'uuid-v4', name: 'UUID Generator (v4)', category: 'Generators', mount: c => buildGeneratorPanel(c, 'UUID v4', () => crypto.randomUUID()) },
  { id: 'uuid-v7', name: 'UUID Generator (v7)', category: 'Generators', mount: c => buildGeneratorPanel(c, 'UUID v7', uuidV7) },
  { id: 'ulid', name: 'ULID Generator', category: 'Generators', mount: c => buildGeneratorPanel(c, 'ULID', ulid) },
  { id: 'nanoid', name: 'NanoID Generator', category: 'Generators', mount: c => buildGeneratorPanel(c, 'NanoID', () => nanoid()) },
  { id: 'fake-data', name: 'Fake Data Generator', category: 'Generators', mount: c => {
    buildIOPanel(c, { inputLabel: 'Count (1-100)', outputLabel: 'Fake records (JSON)', actionLabel: 'Generate', placeholder: '5', transform: s => generateFakeData(Number(s.trim() || '5')) })
  } },
  { id: 'qr-code', name: 'QR Code Generator', category: 'Generators', mount: c => {
    const wrap = document.createElement('div')
    wrap.className = 'utility-io-panel'
    wrap.innerHTML = `
      <label class="utility-field"><span>Text / URL</span><textarea class="utility-textarea" placeholder="https://example.com"></textarea></label>
      <div class="security-toolbar"><button class="btn-primary utility-run-btn">Generate QR code</button></div>
      <div class="utility-qr-output"><div class="empty compact">No QR code yet.</div></div>
      <p class="resource-detail tool-action-failed utility-error" style="display:none"></p>`
    c.appendChild(wrap)
    const input = wrap.querySelector<HTMLTextAreaElement>('.utility-textarea')!
    const output = wrap.querySelector<HTMLElement>('.utility-qr-output')!
    const errorEl = wrap.querySelector<HTMLElement>('.utility-error')!
    wrap.querySelector('.utility-run-btn')!.addEventListener('click', () => {
      const text = input.value.trim() || ' '
      QRCode.toDataURL(text, { width: 240, margin: 1 }).then(dataUrl => {
        output.innerHTML = `<img src="${dataUrl}" alt="QR code" class="utility-qr-image">`
        errorEl.style.display = 'none'
      }).catch(error => {
        errorEl.textContent = String(error instanceof Error ? error.message : error)
        errorEl.style.display = 'block'
      })
    })
  } },

  { id: 'base64', name: 'Base64 Encode/Decode', category: 'Encoding', mount: c => buildBidirectionalPanel(c, {
    leftLabel: 'Text', rightLabel: 'Base64', toRightLabel: 'Encode', toLeftLabel: 'Decode',
    toRight: base64Encode, toLeft: base64Decode,
  }) },
  { id: 'url-encode', name: 'URL Encode/Decode', category: 'Encoding', mount: c => buildBidirectionalPanel(c, {
    leftLabel: 'Text', rightLabel: 'URL-encoded', toRightLabel: 'Encode', toLeftLabel: 'Decode',
    toRight: encodeURIComponent, toLeft: decodeURIComponent,
  }) },
  { id: 'html-encode', name: 'HTML Encode/Decode', category: 'Encoding', mount: c => buildBidirectionalPanel(c, {
    leftLabel: 'Text', rightLabel: 'HTML-encoded', toRightLabel: 'Encode', toLeftLabel: 'Decode',
    toRight: htmlEncode, toLeft: htmlDecode,
  }) },
  { id: 'unicode-escape', name: 'Unicode Escape', category: 'Encoding', mount: c => buildBidirectionalPanel(c, {
    leftLabel: 'Text', rightLabel: 'Escaped (\\uXXXX)', toRightLabel: 'Escape', toLeftLabel: 'Unescape',
    toRight: unicodeEscape, toLeft: unicodeUnescape,
  }) },
  { id: 'ascii-unicode', name: 'ASCII ↔ Unicode', category: 'Encoding', mount: c => buildBidirectionalPanel(c, {
    leftLabel: 'Text', rightLabel: 'Code points (one per line: char U+HEX dec)',
    toRightLabel: 'To code points', toLeftLabel: 'From code points',
    toRight: s => [...s].map(ch => `${ch}\tU+${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}\t${ch.codePointAt(0)}`).join('\n'),
    toLeft: s => s.split(/[\s,]+/).filter(Boolean).map(tok => {
      const code = tok.toUpperCase().startsWith('U+') ? parseInt(tok.slice(2), 16) : parseInt(tok, 10)
      if (Number.isNaN(code)) throw new Error(`"${tok}" is not a valid code point`)
      return String.fromCodePoint(code)
    }).join(''),
  }) },

  { id: 'json-format', name: 'JSON Formatter & Validator', category: 'Data formats', mount: c => {
    buildIOPanel(c, { inputLabel: 'JSON', outputLabel: 'Formatted', actionLabel: 'Format', transform: s => JSON.stringify(JSON.parse(s), null, 2) })
  } },
  { id: 'json-compare', name: 'JSON Compare', category: 'Data formats', mount: c => {
    buildTwoInputPanel(c, { labelA: 'JSON A', labelB: 'JSON B', outputLabel: 'Differences', actionLabel: 'Compare', transform: diffJSON })
  } },
  { id: 'xml-format', name: 'XML Format', category: 'Data formats', mount: c => {
    buildIOPanel(c, { inputLabel: 'XML', outputLabel: 'Formatted', actionLabel: 'Format', transform: formatXML })
  } },
  { id: 'sql-format', name: 'SQL Formatter', category: 'Data formats', mount: c => {
    buildIOPanel(c, { inputLabel: 'SQL', outputLabel: 'Formatted', actionLabel: 'Format', transform: formatSQL })
  } },
  { id: 'csv-json', name: 'CSV ↔ JSON', category: 'Data formats', mount: c => buildBidirectionalPanel(c, {
    leftLabel: 'CSV (first row = headers)', rightLabel: 'JSON (array of objects)',
    toRightLabel: 'To JSON', toLeftLabel: 'To CSV',
    toRight: csvToJSON, toLeft: jsonToCSV,
  }) },
  { id: 'query-string', name: 'Query String Parser', category: 'Data formats', mount: c => {
    buildIOPanel(c, {
      inputLabel: 'Query string (with or without leading ?)', outputLabel: 'Parsed (JSON)', actionLabel: 'Parse',
      transform: s => JSON.stringify(Object.fromEntries(new URLSearchParams(s.replace(/^\?/, ''))), null, 2), liveUpdate: true,
    })
  } },

  { id: 'text-diff', name: 'Text Diff', category: 'Text tools', mount: c => {
    buildTwoInputPanel(c, { labelA: 'Text A', labelB: 'Text B', outputLabel: 'Diff (- removed / + added)', actionLabel: 'Compare', transform: diffText, renderOutput: renderDiffHTML })
  } },
  { id: 'case-converter', name: 'Case Converter', category: 'Text tools', mount: c => {
    buildIOPanel(c, { inputLabel: 'Text', outputLabel: 'All case variants', actionLabel: 'Convert', transform: toCaseVariants, liveUpdate: true })
  } },
  { id: 'markdown-preview', name: 'Markdown Preview', category: 'Text tools', mount: c => {
    ensureMermaidInitialized()
    buildIOPanel(c, {
      inputLabel: 'Markdown', outputLabel: 'Rendered preview', actionLabel: 'Render',
      placeholder: '# Hello\n\nSome **bold** and *italic* text, a [link](https://example.com), and:\n\n- one\n- two\n\n```mermaid\nflowchart LR\n  A[Start] --> B{Ready?}\n  B -- Yes --> C[Ship it]\n  B -- No --> A\n```',
      transform: markdownToHTML, renderOutput: html => html, liveUpdate: true,
      afterRender: el => {
        const diagrams = el.querySelectorAll<HTMLElement>('.mermaid')
        if (diagrams.length) void mermaid.run({ nodes: Array.from(diagrams) }).catch(() => { /* mermaid already renders its own error node on bad syntax */ })
      },
    })
  } },
  { id: 'regex-tester', name: 'Regex Tester', category: 'Text tools', mount: c => {
    const wrap = document.createElement('div')
    wrap.className = 'utility-io-panel'
    wrap.innerHTML = `
      <label class="utility-field"><span>Pattern</span><input class="search-input utility-regex-pattern" placeholder="e.g. \\d+"></label>
      <label class="utility-field"><span>Flags</span><input class="search-input utility-regex-flags" value="g"></label>
      <label class="utility-field"><span>Test text</span><textarea class="utility-textarea utility-regex-text"></textarea></label>
      <div class="security-toolbar"><button class="btn-primary utility-run-btn">Test</button></div>
      <label class="utility-field"><span>Matches</span><textarea class="utility-textarea" readonly></textarea></label>
      <p class="resource-detail tool-action-failed utility-error" style="display:none"></p>`
    c.appendChild(wrap)
    const pattern = wrap.querySelector<HTMLInputElement>('.utility-regex-pattern')!
    const flags = wrap.querySelector<HTMLInputElement>('.utility-regex-flags')!
    const text = wrap.querySelector<HTMLTextAreaElement>('.utility-regex-text')!
    const output = wrap.querySelectorAll<HTMLTextAreaElement>('.utility-textarea')[1]
    const errorEl = wrap.querySelector<HTMLElement>('.utility-error')!
    const run = () => {
      try {
        output.value = testRegex(pattern.value, flags.value, text.value)
        errorEl.style.display = 'none'
      } catch (error) {
        output.value = ''
        errorEl.textContent = String(error instanceof Error ? error.message : error)
        errorEl.style.display = 'block'
      }
    }
    wrap.querySelector('.utility-run-btn')!.addEventListener('click', run)
  } },

  { id: 'curl-converter', name: 'Curl Converter', category: 'Dev tools', mount: c => {
    buildIOPanel(c, { inputLabel: 'curl command', outputLabel: 'Parsed + fetch() equivalent', actionLabel: 'Convert', transform: convertCurl })
  } },
  { id: 'timestamp', name: 'Timestamp Converter', category: 'Dev tools', mount: c => buildBidirectionalPanel(c, {
    leftLabel: 'Unix timestamp (seconds or ms)', rightLabel: 'Date',
    toRightLabel: 'To date', toLeftLabel: 'To timestamp',
    toRight: timestampToDate, toLeft: dateToTimestamp,
  }) },
  { id: 'cron-parser', name: 'Cron Parser', category: 'Dev tools', mount: c => {
    buildIOPanel(c, { inputLabel: 'Cron expression (5 fields)', outputLabel: 'Description + next runs', actionLabel: 'Parse', placeholder: '*/15 9-17 * * 1-5', transform: describeCron })
  } },
  { id: 'hash-generator', name: 'Hash Generator', category: 'Dev tools', mount: c => {
    buildIOPanel(c, { inputLabel: 'Text', outputLabel: 'Hashes (MD5, SHA-1/256/384/512)', actionLabel: 'Hash', transform: hashText })
  } },

  { id: 'jwt', name: 'JWT Decode/Verify', category: 'Auth', mount: c => {
    const decodePanel = buildIOPanel(c, {
      inputLabel: 'JWT', outputLabel: 'Decoded header + payload', actionLabel: 'Decode',
      transform: s => { const { header, payload } = decodeJWT(s); return `// header\n${JSON.stringify(header, null, 2)}\n\n// payload\n${JSON.stringify(payload, null, 2)}` },
      liveUpdate: true,
    })

    const verifyWrap = document.createElement('div')
    verifyWrap.className = 'utility-io-panel'
    verifyWrap.innerHTML = `
      <p class="resource-detail muted">Only HS256 (shared secret) and RS256 (PEM public key) are supported.</p>
      <label class="utility-field">
        <span>Secret (HS256) or public key PEM (RS256)</span>
        <textarea class="utility-textarea utility-jwt-key" placeholder="my-secret, or -----BEGIN PUBLIC KEY-----..."></textarea>
      </label>
      <div class="security-toolbar"><button class="btn-primary utility-jwt-verify-btn">Verify signature</button></div>
      <p class="resource-detail utility-jwt-result"></p>`
    c.appendChild(verifyWrap)
    const keyInput = verifyWrap.querySelector<HTMLTextAreaElement>('.utility-jwt-key')!
    const resultEl = verifyWrap.querySelector<HTMLElement>('.utility-jwt-result')!
    verifyWrap.querySelector('.utility-jwt-verify-btn')!.addEventListener('click', () => {
      void verifyJWT(decodePanel.input.value, keyInput.value)
        .then(msg => { resultEl.textContent = msg; resultEl.className = `resource-detail ${msg.startsWith('✓') ? '' : 'tool-action-failed'}` })
        .catch(error => { resultEl.textContent = String(error instanceof Error ? error.message : error); resultEl.className = 'resource-detail tool-action-failed' })
    })
  } },
  { id: 'cert-inspector', name: 'Certificate/CSR Inspector', category: 'Auth', mount: c => {
    buildIOPanel(c, {
      inputLabel: 'PEM certificate or CSR', outputLabel: 'Parsed fields', actionLabel: 'Inspect',
      placeholder: '-----BEGIN CERTIFICATE-----\n...', transform: inspectCertOrCSR,
    })
  } },

  { id: 'cidr-calculator', name: 'CIDR/Subnet Calculator', category: 'Network', mount: c => {
    buildIOPanel(c, {
      inputLabel: 'IPv4 CIDR', outputLabel: 'Network details', actionLabel: 'Calculate',
      placeholder: '192.168.1.10/24', transform: calculateCIDR, liveUpdate: true,
    })
  } },

  { id: 'env-compare', name: '.env Compare', category: 'Data formats', mount: c => {
    buildTwoInputPanel(c, {
      labelA: '.env A', labelB: '.env B', outputLabel: 'Differences (secret-looking keys are masked)',
      actionLabel: 'Compare', transform: diffEnv,
    })
  } },
]
