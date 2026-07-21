// In-app markup editor for image captures, opened from the Captures view's
// Edit button instead of shelling out to Preview.app. Fully client-side
// (canvas 2D) — Go only reads/writes the raw file bytes (LoadCaptureImage /
// SaveEditedCapture[As]).
//
// Drawn marks (pen/rect/ellipse/arrow/highlight/text) are kept as editable
// "shape" objects and re-rendered on an overlay canvas every frame, rather
// than flattened into the image immediately — that's what lets the Select
// tool move/resize/restyle/delete a shape after it's drawn. Blur and Crop
// stay as direct raster operations on the base canvas (redaction should be
// irreversible-looking, and crop resizes the canvas itself).
import { api } from '../api'
import { escapeHTML, showError } from '../dom'

type Tool = 'select' | 'pen' | 'rect' | 'ellipse' | 'arrow' | 'text' | 'highlight' | 'blur' | 'crop'

type ShapeBase = { id: string; color: string }
type RectLike = ShapeBase & { kind: 'rect' | 'ellipse' | 'highlight'; x: number; y: number; w: number; h: number; strokeWidth: number }
type ArrowShape = ShapeBase & { kind: 'arrow'; x0: number; y0: number; x1: number; y1: number; strokeWidth: number }
type PenShape = ShapeBase & { kind: 'pen'; points: { x: number; y: number }[]; strokeWidth: number }
type TextShape = ShapeBase & { kind: 'text'; x: number; y: number; text: string; fontSize: number }
type Shape = RectLike | ArrowShape | PenShape | TextShape

type Bounds = { x: number; y: number; w: number; h: number }
type DragMode = 'move' | 'resize-nw' | 'resize-ne' | 'resize-sw' | 'resize-se' | 'arrow-a' | 'arrow-b'
type HistoryEntry = { shapes: Shape[]; baseImageData?: ImageData }

const COLORS = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#0a84ff', '#af52de', '#ffffff', '#1c1c1e']
const FONT_FAMILY = '-apple-system, BlinkMacSystemFont, sans-serif'
const HANDLE_RADIUS = 5
const HANDLE_HIT_RADIUS = 9

function splitName(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? { stem: name.slice(0, dot), ext: name.slice(dot) } : { stem: name, ext: '' }
}

function cloneShape(shape: Shape): Shape {
  return shape.kind === 'pen' ? { ...shape, points: shape.points.map(p => ({ ...p })) } : { ...shape }
}

function normalizeRect(x0: number, y0: number, x1: number, y1: number): Bounds {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) }
}

function rectsIntersect(a: Bounds, b: Bounds): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

function distanceToSegment(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const dx = x1 - x0, dy = y1 - y0
  const lenSq = dx * dx + dy * dy
  let t = lenSq ? ((px - x0) * dx + (py - y0) * dy) / lenSq : 0
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (x0 + t * dx), py - (y0 + t * dy))
}

export function openCaptureEditor(path: string, name: string): void {
  const backdrop = document.createElement('div')
  backdrop.className = 'markdown-modal-backdrop capture-editor-backdrop'
  document.body.appendChild(backdrop)

  const workspace = document.createElement('div')
  workspace.className = 'capture-editor-workspace'
  workspace.innerHTML = `
    <header class="markdown-modal-header">
      <div class="markdown-modal-identity">
        <span class="markdown-file-icon">IMG</span>
        <div><strong>${escapeHTML(name)}</strong><span>Edit capture</span></div>
      </div>
      <div class="markdown-modal-actions capture-editor-actions">
        <button class="btn-icon" data-editor-undo title="Undo" disabled>↶</button>
        <button class="btn-icon" data-editor-redo title="Redo" disabled>↷</button>
        <button class="btn-secondary" data-editor-save-as type="button">Save As…</button>
        <button class="btn-primary" data-editor-save type="button">Save</button>
        <button class="markdown-toolbar-btn markdown-close" data-editor-close type="button" title="Close (Esc)"></button>
      </div>
    </header>
    <div class="capture-editor-body">
      <div class="capture-editor-toolbar" role="toolbar" aria-label="Markup tools">
        <div class="capture-editor-section">
          <h3>Draw</h3>
          <div class="capture-editor-tool-grid">
            <button class="capture-editor-tool active" data-tool="select" type="button" title="Select &amp; move"><span class="capture-editor-tool-icon">↖</span><span class="capture-editor-tool-label">Select</span></button>
            <button class="capture-editor-tool" data-tool="pen" type="button" title="Pen"><span class="capture-editor-tool-icon">✎</span><span class="capture-editor-tool-label">Pen</span></button>
            <button class="capture-editor-tool" data-tool="rect" type="button" title="Rectangle"><span class="capture-editor-tool-icon">▭</span><span class="capture-editor-tool-label">Rectangle</span></button>
            <button class="capture-editor-tool" data-tool="ellipse" type="button" title="Ellipse"><span class="capture-editor-tool-icon">◯</span><span class="capture-editor-tool-label">Ellipse</span></button>
            <button class="capture-editor-tool" data-tool="arrow" type="button" title="Arrow"><span class="capture-editor-tool-icon">↗</span><span class="capture-editor-tool-label">Arrow</span></button>
            <button class="capture-editor-tool" data-tool="highlight" type="button" title="Highlight"><span class="capture-editor-tool-icon">▨</span><span class="capture-editor-tool-label">Highlight</span></button>
          </div>
        </div>
        <div class="capture-editor-section">
          <h3>Adjust</h3>
          <div class="capture-editor-tool-grid">
            <button class="capture-editor-tool" data-tool="text" type="button" title="Text"><span class="capture-editor-tool-icon">T</span><span class="capture-editor-tool-label">Text</span></button>
            <button class="capture-editor-tool" data-tool="blur" type="button" title="Blur / redact"><span class="capture-editor-tool-icon">▦</span><span class="capture-editor-tool-label">Blur</span></button>
            <button class="capture-editor-tool" data-tool="crop" type="button" title="Crop"><span class="capture-editor-tool-icon">⛶</span><span class="capture-editor-tool-label">Crop</span></button>
          </div>
        </div>
        <div class="capture-editor-section">
          <h3>Style</h3>
          <div class="capture-editor-colors">
            ${COLORS.map((color, i) => `<button class="capture-editor-color${i === 0 ? ' active' : ''}" data-color="${color}" type="button" style="background:${color}" title="${color}"></button>`).join('')}
            <label class="capture-editor-custom-color" title="Custom color"><input type="color" data-custom-color value="${COLORS[0]}"></label>
          </div>
          <label class="capture-editor-range-row"><span>Stroke width</span><input type="range" min="2" max="16" value="4" data-stroke></label>
          <label class="capture-editor-range-row"><span>Font size</span><input type="range" min="12" max="64" value="20" data-font-size></label>
        </div>
        <button class="btn-secondary capture-editor-delete" data-editor-delete type="button" disabled>Delete shape</button>
        <button class="btn-secondary capture-editor-apply-crop" data-editor-apply-crop type="button" hidden>Apply crop</button>
      </div>
      <div class="capture-editor-canvas-wrap">
        <div class="capture-editor-stage">
          <canvas class="capture-editor-canvas"></canvas>
          <canvas class="capture-editor-overlay"></canvas>
        </div>
      </div>
    </div>`
  document.body.appendChild(workspace)

  const canvas = workspace.querySelector<HTMLCanvasElement>('.capture-editor-canvas')!
  const overlay = workspace.querySelector<HTMLCanvasElement>('.capture-editor-overlay')!
  const stage = workspace.querySelector<HTMLElement>('.capture-editor-stage')!
  const canvasWrap = workspace.querySelector<HTMLElement>('.capture-editor-canvas-wrap')!
  const ctx = canvas.getContext('2d')!
  const overlayCtx = overlay.getContext('2d')!
  const undoButton = workspace.querySelector<HTMLButtonElement>('[data-editor-undo]')!
  const redoButton = workspace.querySelector<HTMLButtonElement>('[data-editor-redo]')!
  const deleteButton = workspace.querySelector<HTMLButtonElement>('[data-editor-delete]')!
  const applyCropButton = workspace.querySelector<HTMLButtonElement>('[data-editor-apply-crop]')!
  const strokeInput = workspace.querySelector<HTMLInputElement>('[data-stroke]')!
  const fontSizeInput = workspace.querySelector<HTMLInputElement>('[data-font-size]')!
  const customColorInput = workspace.querySelector<HTMLInputElement>('[data-custom-color]')!

  let tool: Tool = 'select'
  let color = COLORS[0]
  let shapes: Shape[] = []
  let selectedIds: string[] = []
  let previewShape: Shape | null = null
  let pendingSelectionPreview: Bounds | null = null
  let nextId = 1
  const makeId = () => `shape-${nextId++}`

  let undoStack: HistoryEntry[] = []
  let redoStack: HistoryEntry[] = []
  let scale = 1
  let drawing = false
  let startX = 0
  let startY = 0
  let pendingCrop: Bounds | null = null
  let textInput: HTMLInputElement | null = null

  let dragMode: DragMode | null = null
  let dragOrigin = { x: 0, y: 0 }
  let dragOrigShape: Shape | null = null
  let dragGroupOrig: Shape[] | null = null
  let marqueeOrigin: { x: number; y: number } | null = null
  let strokeDragPushed = false
  let fontDragPushed = false

  const selectedShape = (): Shape | undefined => selectedIds.length === 1 ? shapes.find(s => s.id === selectedIds[0]) : undefined
  const isDirty = () => undoStack.length > 0

  const syncHistoryButtons = () => {
    undoButton.disabled = undoStack.length === 0
    redoButton.disabled = redoStack.length === 0
    deleteButton.disabled = !selectedIds.length
  }

  const pushHistory = (includeRaster: boolean) => {
    const entry: HistoryEntry = { shapes: shapes.map(cloneShape) }
    if (includeRaster) entry.baseImageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
    undoStack.push(entry)
    if (undoStack.length > 20) undoStack.shift()
    redoStack = []
    syncHistoryButtons()
  }

  const fitToViewport = () => {
    const maxWidth = canvasWrap.clientWidth - 32
    const maxHeight = canvasWrap.clientHeight - 32
    scale = Math.min(1, maxWidth / canvas.width, maxHeight / canvas.height) || 1
    const displayWidth = Math.round(canvas.width * scale)
    const displayHeight = Math.round(canvas.height * scale)
    stage.style.width = `${displayWidth}px`
    stage.style.height = `${displayHeight}px`
    canvas.style.width = `${displayWidth}px`
    canvas.style.height = `${displayHeight}px`
    overlay.style.width = `${displayWidth}px`
    overlay.style.height = `${displayHeight}px`
  }

  const toCanvasPoint = (event: PointerEvent): { x: number; y: number } => {
    const rect = overlay.getBoundingClientRect()
    return {
      x: Math.round((event.clientX - rect.left) / scale),
      y: Math.round((event.clientY - rect.top) / scale),
    }
  }

  const shapeBounds = (shape: Shape): Bounds => {
    if (shape.kind === 'rect' || shape.kind === 'ellipse' || shape.kind === 'highlight') {
      return { x: shape.x, y: shape.y, w: shape.w, h: shape.h }
    }
    if (shape.kind === 'arrow') return normalizeRect(shape.x0, shape.y0, shape.x1, shape.y1)
    if (shape.kind === 'text') {
      overlayCtx.font = `${shape.fontSize}px ${FONT_FAMILY}`
      return { x: shape.x, y: shape.y, w: overlayCtx.measureText(shape.text).width, h: shape.fontSize * 1.2 }
    }
    const pen = shape as PenShape
    const xs = pen.points.map(p => p.x)
    const ys = pen.points.map(p => p.y)
    const x0 = Math.min(...xs), y0 = Math.min(...ys)
    return { x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 }
  }

  const renderShape = (targetCtx: CanvasRenderingContext2D, shape: Shape) => {
    targetCtx.save()
    targetCtx.strokeStyle = shape.color
    targetCtx.fillStyle = shape.color
    targetCtx.lineCap = 'round'
    targetCtx.lineJoin = 'round'
    if (shape.kind === 'rect') {
      targetCtx.lineWidth = shape.strokeWidth
      targetCtx.strokeRect(shape.x, shape.y, shape.w, shape.h)
    } else if (shape.kind === 'ellipse') {
      targetCtx.lineWidth = shape.strokeWidth
      targetCtx.beginPath()
      targetCtx.ellipse(shape.x + shape.w / 2, shape.y + shape.h / 2, Math.abs(shape.w) / 2, Math.abs(shape.h) / 2, 0, 0, Math.PI * 2)
      targetCtx.stroke()
    } else if (shape.kind === 'highlight') {
      targetCtx.globalAlpha = 0.35
      targetCtx.fillRect(shape.x, shape.y, shape.w, shape.h)
    } else if (shape.kind === 'arrow') {
      targetCtx.lineWidth = shape.strokeWidth
      const angle = Math.atan2(shape.y1 - shape.y0, shape.x1 - shape.x0)
      const headLength = Math.max(12, shape.strokeWidth * 3)
      targetCtx.beginPath()
      targetCtx.moveTo(shape.x0, shape.y0)
      targetCtx.lineTo(shape.x1, shape.y1)
      targetCtx.moveTo(shape.x1, shape.y1)
      targetCtx.lineTo(shape.x1 - headLength * Math.cos(angle - Math.PI / 6), shape.y1 - headLength * Math.sin(angle - Math.PI / 6))
      targetCtx.moveTo(shape.x1, shape.y1)
      targetCtx.lineTo(shape.x1 - headLength * Math.cos(angle + Math.PI / 6), shape.y1 - headLength * Math.sin(angle + Math.PI / 6))
      targetCtx.stroke()
    } else if (shape.kind === 'pen') {
      targetCtx.lineWidth = shape.strokeWidth
      targetCtx.beginPath()
      shape.points.forEach((p, i) => (i === 0 ? targetCtx.moveTo(p.x, p.y) : targetCtx.lineTo(p.x, p.y)))
      targetCtx.stroke()
    } else if (shape.kind === 'text') {
      targetCtx.font = `${shape.fontSize}px ${FONT_FAMILY}`
      targetCtx.textBaseline = 'top'
      targetCtx.fillText(shape.text, shape.x, shape.y)
    }
    targetCtx.restore()
  }

  const handlePositions = (shape: Shape): { name: DragMode; x: number; y: number }[] => {
    if (shape.kind === 'arrow') return [{ name: 'arrow-a', x: shape.x0, y: shape.y0 }, { name: 'arrow-b', x: shape.x1, y: shape.y1 }]
    if (shape.kind === 'text' || shape.kind === 'pen') return []
    const b = shapeBounds(shape)
    return [
      { name: 'resize-nw', x: b.x, y: b.y },
      { name: 'resize-ne', x: b.x + b.w, y: b.y },
      { name: 'resize-sw', x: b.x, y: b.y + b.h },
      { name: 'resize-se', x: b.x + b.w, y: b.y + b.h },
    ]
  }

  const handleAt = (px: number, py: number, shape: Shape): DragMode | null => {
    const hit = handlePositions(shape).find(h => Math.hypot(px - h.x, py - h.y) <= HANDLE_HIT_RADIUS)
    return hit ? hit.name : null
  }

  const hitTest = (px: number, py: number): Shape | null => {
    for (let i = shapes.length - 1; i >= 0; i--) {
      const shape = shapes[i]
      if (shape.kind === 'arrow') {
        if (distanceToSegment(px, py, shape.x0, shape.y0, shape.x1, shape.y1) <= Math.max(8, shape.strokeWidth)) return shape
        continue
      }
      const b = shapeBounds(shape)
      const pad = 4
      if (px >= b.x - pad && px <= b.x + b.w + pad && py >= b.y - pad && py <= b.y + b.h + pad) return shape
    }
    return null
  }

  const renderOverlay = () => {
    overlayCtx.clearRect(0, 0, overlay.width, overlay.height)
    for (const shape of shapes) renderShape(overlayCtx, shape)
    if (previewShape) renderShape(overlayCtx, previewShape)
    if (pendingSelectionPreview) {
      overlayCtx.save()
      overlayCtx.strokeStyle = color
      overlayCtx.setLineDash([6, 4])
      overlayCtx.strokeRect(pendingSelectionPreview.x, pendingSelectionPreview.y, pendingSelectionPreview.w, pendingSelectionPreview.h)
      overlayCtx.restore()
    }
    const selectedShapes = shapes.filter(s => selectedIds.includes(s.id))
    for (const shape of selectedShapes) {
      const b = shapeBounds(shape)
      overlayCtx.save()
      overlayCtx.strokeStyle = '#0a84ff'
      overlayCtx.lineWidth = 1.5
      overlayCtx.setLineDash([5, 4])
      overlayCtx.strokeRect(b.x - 4, b.y - 4, b.w + 8, b.h + 8)
      overlayCtx.restore()
    }
    if (selectedShapes.length === 1) {
      overlayCtx.save()
      overlayCtx.fillStyle = '#0a84ff'
      for (const handle of handlePositions(selectedShapes[0])) {
        overlayCtx.beginPath()
        overlayCtx.arc(handle.x, handle.y, HANDLE_RADIUS, 0, Math.PI * 2)
        overlayCtx.fill()
      }
      overlayCtx.restore()
    }
    syncHistoryButtons()
  }

  const applyTranslate = (shape: Shape, orig: Shape, dx: number, dy: number) => {
    if (shape.kind === 'pen' && orig.kind === 'pen') { shape.points = orig.points.map(p => ({ x: p.x + dx, y: p.y + dy })); return }
    if (shape.kind === 'arrow' && orig.kind === 'arrow') {
      shape.x0 = orig.x0 + dx; shape.y0 = orig.y0 + dy
      shape.x1 = orig.x1 + dx; shape.y1 = orig.y1 + dy
      return
    }
    if ((shape.kind === 'rect' || shape.kind === 'ellipse' || shape.kind === 'highlight') && orig.kind === shape.kind) {
      shape.x = orig.x + dx; shape.y = orig.y + dy
      return
    }
    if (shape.kind === 'text' && orig.kind === 'text') { shape.x = orig.x + dx; shape.y = orig.y + dy }
  }

  const applyResize = (shape: RectLike, orig: RectLike, corner: 'nw' | 'ne' | 'sw' | 'se', dx: number, dy: number) => {
    let x0 = orig.x, y0 = orig.y, x1 = orig.x + orig.w, y1 = orig.y + orig.h
    if (corner.includes('n')) y0 = orig.y + dy; else y1 = orig.y + orig.h + dy
    if (corner.includes('w')) x0 = orig.x + dx; else x1 = orig.x + orig.w + dx
    const r = normalizeRect(x0, y0, x1, y1)
    shape.x = r.x; shape.y = r.y; shape.w = r.w; shape.h = r.h
  }

  const startDrag = (mode: DragMode, shape: Shape, origin: { x: number; y: number }) => {
    pushHistory(false)
    dragMode = mode
    dragOrigin = origin
    dragOrigShape = cloneShape(shape)
  }

  const startGroupDrag = (group: Shape[], origin: { x: number; y: number }) => {
    pushHistory(false)
    dragMode = 'move'
    dragOrigin = origin
    dragGroupOrig = group.map(cloneShape)
  }

  const deleteSelected = () => {
    if (!selectedIds.length) return
    pushHistory(false)
    shapes = shapes.filter(s => !selectedIds.includes(s.id))
    selectedIds = []
    renderOverlay()
  }

  const mimeType = () => {
    const ext = splitName(name).ext.toLowerCase()
    return ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png'
  }

  const composite = (): HTMLCanvasElement => {
    const out = document.createElement('canvas')
    out.width = canvas.width
    out.height = canvas.height
    const outCtx = out.getContext('2d')!
    outCtx.drawImage(canvas, 0, 0)
    for (const shape of shapes) renderShape(outCtx, shape)
    return out
  }

  const canvasToDataURI = (): Promise<string> => new Promise((resolve, reject) => {
    composite().toBlob(blob => {
      if (!blob) { reject(new Error('could not encode the edited image')); return }
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result))
      reader.onerror = () => reject(new Error('could not read the encoded image'))
      reader.readAsDataURL(blob)
    }, mimeType())
  })

  const pixelate = (x: number, y: number, w: number, h: number) => {
    const block = 12
    if (w < 1 || h < 1) return
    const image = ctx.getImageData(x, y, w, h)
    const data = image.data
    for (let by = 0; by < h; by += block) {
      for (let bx = 0; bx < w; bx += block) {
        const bw = Math.min(block, w - bx)
        const bh = Math.min(block, h - by)
        let r = 0, g = 0, b = 0, a = 0, count = 0
        for (let dy = 0; dy < bh; dy++) {
          for (let dx = 0; dx < bw; dx++) {
            const i = ((by + dy) * w + (bx + dx)) * 4
            r += data[i]; g += data[i + 1]; b += data[i + 2]; a += data[i + 3]
            count++
          }
        }
        r = Math.round(r / count); g = Math.round(g / count); b = Math.round(b / count); a = Math.round(a / count)
        for (let dy = 0; dy < bh; dy++) {
          for (let dx = 0; dx < bw; dx++) {
            const i = ((by + dy) * w + (bx + dx)) * 4
            data[i] = r; data[i + 1] = g; data[i + 2] = b; data[i + 3] = a
          }
        }
      }
    }
    ctx.putImageData(image, x, y)
  }

  const commitText = (input: HTMLInputElement, x: number, y: number) => {
    if (textInput !== input) return
    const value = input.value.trim()
    textInput = null
    input.remove()
    if (!value) return
    pushHistory(false)
    const shape: TextShape = { id: makeId(), kind: 'text', color, x, y, text: value, fontSize: Number(fontSizeInput.value) }
    shapes.push(shape)
    selectedIds = [shape.id]
    renderOverlay()
  }

  const openTextInput = (x: number, y: number) => {
    if (textInput) commitText(textInput, startX, startY)
    selectedIds = []
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'capture-editor-text-input'
    input.style.left = `${x * scale}px`
    input.style.top = `${y * scale}px`
    input.style.color = color
    input.style.fontSize = `${Number(fontSizeInput.value) * scale}px`
    stage.appendChild(input)
    textInput = input
    startX = x
    startY = y
    input.focus()
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); commitText(input, x, y) }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); textInput = null; input.remove() }
    })
    input.addEventListener('blur', () => { if (textInput === input) commitText(input, x, y) })
  }

  overlay.addEventListener('pointerdown', event => {
    const pt = toCanvasPoint(event)

    if (tool === 'select') {
      const selected = selectedShape()
      if (selected) {
        const handle = handleAt(pt.x, pt.y, selected)
        if (handle) { overlay.setPointerCapture(event.pointerId); startDrag(handle, selected, pt); return }
      }
      const hit = hitTest(pt.x, pt.y)
      if (hit) {
        if (!selectedIds.includes(hit.id)) selectedIds = [hit.id]
        overlay.setPointerCapture(event.pointerId)
        startGroupDrag(shapes.filter(s => selectedIds.includes(s.id)), pt)
        renderOverlay()
        return
      }
      selectedIds = []
      marqueeOrigin = pt
      overlay.setPointerCapture(event.pointerId)
      renderOverlay()
      return
    }

    if (tool === 'text') { event.preventDefault(); openTextInput(pt.x, pt.y); return }

    selectedIds = []
    drawing = true
    overlay.setPointerCapture(event.pointerId)
    startX = pt.x
    startY = pt.y

    if (tool === 'pen') {
      pushHistory(false)
      const shape: PenShape = { id: makeId(), kind: 'pen', color, strokeWidth: Number(strokeInput.value), points: [pt] }
      shapes.push(shape)
      previewShape = null
      selectedIds = [shape.id]
    }
    renderOverlay()
  })

  overlay.addEventListener('pointermove', event => {
    const pt = toCanvasPoint(event)

    if (dragMode === 'move' && dragGroupOrig) {
      const dx = pt.x - dragOrigin.x
      const dy = pt.y - dragOrigin.y
      for (const orig of dragGroupOrig) {
        const live = shapes.find(s => s.id === orig.id)
        if (live) applyTranslate(live, orig, dx, dy)
      }
      renderOverlay()
      return
    }

    if (dragMode && dragOrigShape) {
      const dx = pt.x - dragOrigin.x
      const dy = pt.y - dragOrigin.y
      const live = selectedShape()
      if (!live) return
      if (dragMode === 'arrow-a' && live.kind === 'arrow' && dragOrigShape.kind === 'arrow') { live.x0 = dragOrigShape.x0 + dx; live.y0 = dragOrigShape.y0 + dy }
      else if (dragMode === 'arrow-b' && live.kind === 'arrow' && dragOrigShape.kind === 'arrow') { live.x1 = dragOrigShape.x1 + dx; live.y1 = dragOrigShape.y1 + dy }
      else if (dragMode.startsWith('resize-') && (live.kind === 'rect' || live.kind === 'ellipse' || live.kind === 'highlight') && dragOrigShape.kind === live.kind) {
        applyResize(live, dragOrigShape, dragMode.slice('resize-'.length) as 'nw' | 'ne' | 'sw' | 'se', dx, dy)
      }
      renderOverlay()
      return
    }

    if (marqueeOrigin) {
      pendingSelectionPreview = normalizeRect(marqueeOrigin.x, marqueeOrigin.y, pt.x, pt.y)
      renderOverlay()
      return
    }

    if (!drawing) return

    if (tool === 'pen') {
      const active = shapes[shapes.length - 1] as PenShape
      active.points.push(pt)
      renderOverlay()
      return
    }

    if (tool === 'crop' || tool === 'blur') {
      pendingSelectionPreview = normalizeRect(startX, startY, pt.x, pt.y)
      renderOverlay()
      return
    }

    if (tool === 'rect' || tool === 'ellipse' || tool === 'highlight') {
      const r = normalizeRect(startX, startY, pt.x, pt.y)
      previewShape = { id: '__preview__', kind: tool, color, strokeWidth: Number(strokeInput.value), ...r }
    } else if (tool === 'arrow') {
      previewShape = { id: '__preview__', kind: 'arrow', color, strokeWidth: Number(strokeInput.value), x0: startX, y0: startY, x1: pt.x, y1: pt.y }
    }
    renderOverlay()
  })

  overlay.addEventListener('pointerup', event => {
    if (dragMode === 'move' && dragGroupOrig) { dragMode = null; dragGroupOrig = null; renderOverlay(); return }
    if (dragMode) { dragMode = null; dragOrigShape = null; renderOverlay(); return }

    if (marqueeOrigin) {
      const pt = toCanvasPoint(event)
      const r = normalizeRect(marqueeOrigin.x, marqueeOrigin.y, pt.x, pt.y)
      marqueeOrigin = null
      pendingSelectionPreview = null
      if (r.w >= 3 || r.h >= 3) selectedIds = shapes.filter(s => rectsIntersect(shapeBounds(s), r)).map(s => s.id)
      renderOverlay()
      return
    }

    if (!drawing) return
    drawing = false
    const pt = toCanvasPoint(event)

    if (tool === 'pen') { renderOverlay(); return }

    if (tool === 'crop') {
      const r = normalizeRect(startX, startY, pt.x, pt.y)
      pendingSelectionPreview = null
      pendingCrop = r.w >= 4 && r.h >= 4 ? r : null
      applyCropButton.hidden = !pendingCrop
      if (pendingCrop) {
        overlayCtx.save()
        overlayCtx.strokeStyle = color
        overlayCtx.setLineDash([6, 4])
        overlayCtx.strokeRect(pendingCrop.x, pendingCrop.y, pendingCrop.w, pendingCrop.h)
        overlayCtx.restore()
      }
      renderOverlay()
      return
    }

    if (tool === 'blur') {
      pendingSelectionPreview = null
      const r = normalizeRect(startX, startY, pt.x, pt.y)
      if (r.w >= 2 && r.h >= 2) { pushHistory(true); pixelate(r.x, r.y, r.w, r.h) }
      renderOverlay()
      return
    }

    previewShape = null
    if (tool === 'rect' || tool === 'ellipse' || tool === 'highlight' || tool === 'arrow') {
      const strokeWidth = Number(strokeInput.value)
      const shape: Shape = tool === 'arrow'
        ? { id: makeId(), kind: 'arrow', color, strokeWidth, x0: startX, y0: startY, x1: pt.x, y1: pt.y }
        : { id: makeId(), kind: tool, color, strokeWidth, ...normalizeRect(startX, startY, pt.x, pt.y) }
      const b = shapeBounds(shape)
      if (tool === 'arrow' || b.w >= 2 || b.h >= 2) {
        pushHistory(false)
        shapes.push(shape)
        selectedIds = [shape.id]
      }
    }
    renderOverlay()
  })

  const selectTool = (next: Tool) => {
    tool = next
    workspace.querySelectorAll<HTMLButtonElement>('.capture-editor-tool').forEach(button => button.classList.toggle('active', button.dataset.tool === next))
    applyCropButton.hidden = true
    pendingCrop = null
    pendingSelectionPreview = null
    renderOverlay()
  }

  workspace.querySelectorAll<HTMLButtonElement>('.capture-editor-tool').forEach(button => {
    button.addEventListener('click', () => selectTool(button.dataset.tool as Tool))
  })

  const applyColor = (next: string) => {
    color = next
    customColorInput.value = next
    workspace.querySelectorAll<HTMLButtonElement>('.capture-editor-color').forEach(b => b.classList.toggle('active', b.dataset.color === next))
    const shape = selectedShape()
    if (shape) { pushHistory(false); shape.color = next; renderOverlay() }
  }
  workspace.querySelectorAll<HTMLButtonElement>('.capture-editor-color').forEach(button => {
    button.addEventListener('click', () => applyColor(button.dataset.color!))
  })
  customColorInput.addEventListener('change', () => applyColor(customColorInput.value))

  strokeInput.addEventListener('pointerdown', () => { strokeDragPushed = false })
  strokeInput.addEventListener('input', () => {
    const shape = selectedShape()
    if (shape && shape.kind !== 'text') {
      if (!strokeDragPushed) { pushHistory(false); strokeDragPushed = true }
      shape.strokeWidth = Number(strokeInput.value)
      renderOverlay()
    }
  })

  fontSizeInput.addEventListener('pointerdown', () => { fontDragPushed = false })
  fontSizeInput.addEventListener('input', () => {
    const shape = selectedShape()
    if (shape && shape.kind === 'text') {
      if (!fontDragPushed) { pushHistory(false); fontDragPushed = true }
      shape.fontSize = Number(fontSizeInput.value)
      renderOverlay()
    }
  })

  deleteButton.addEventListener('click', deleteSelected)

  applyCropButton.addEventListener('click', () => {
    if (!pendingCrop) return
    const { x, y, w, h } = pendingCrop
    pushHistory(true)
    const cropped = document.createElement('canvas')
    cropped.width = w
    cropped.height = h
    cropped.getContext('2d')!.drawImage(canvas, x, y, w, h, 0, 0, w, h)
    canvas.width = w
    canvas.height = h
    overlay.width = w
    overlay.height = h
    ctx.drawImage(cropped, 0, 0)
    for (const shape of shapes) applyTranslate(shape, shape, -x, -y)
    pendingCrop = null
    applyCropButton.hidden = true
    fitToViewport()
    renderOverlay()
  })

  const restore = (from: HistoryEntry[], to: HistoryEntry[]) => {
    if (!from.length) return
    const includeRaster = from[from.length - 1].baseImageData !== undefined
    const toEntry: HistoryEntry = { shapes: shapes.map(cloneShape) }
    if (includeRaster) toEntry.baseImageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
    to.push(toEntry)
    const entry = from.pop()!
    shapes = entry.shapes.map(cloneShape)
    selectedIds = []
    if (entry.baseImageData) {
      const data = entry.baseImageData
      if (data.width !== canvas.width || data.height !== canvas.height) {
        canvas.width = data.width
        canvas.height = data.height
        overlay.width = data.width
        overlay.height = data.height
        fitToViewport()
      }
      ctx.putImageData(data, 0, 0)
    }
    renderOverlay()
  }
  undoButton.addEventListener('click', () => restore(undoStack, redoStack))
  redoButton.addEventListener('click', () => restore(redoStack, undoStack))

  const close = async () => {
    if (isDirty() && !(await api.confirmDialog('Discard changes', `Discard your edits to ${name}?`))) return
    window.removeEventListener('keydown', onKeydown)
    window.removeEventListener('resize', fitToViewport)
    backdrop.remove()
    workspace.remove()
  }

  const save = async () => {
    if (!(await api.confirmDialog('Save changes', `Overwrite ${name} with your edits? This can't be undone.`))) return
    try {
      await api.saveEditedCapture(path, await canvasToDataURI())
      undoStack = []
      redoStack = []
      syncHistoryButtons()
      await close()
    } catch (error) {
      showError(String(error))
    }
  }

  const saveAs = async () => {
    const { stem, ext } = splitName(name)
    try {
      await api.saveEditedCaptureAs(path, await canvasToDataURI(), `${stem} edited${ext}`)
    } catch (error) {
      showError(String(error))
    }
  }

  workspace.querySelector('[data-editor-close]')!.addEventListener('click', () => void close())
  workspace.querySelector('[data-editor-save]')!.addEventListener('click', () => void save())
  workspace.querySelector('[data-editor-save-as]')!.addEventListener('click', () => void saveAs())
  backdrop.addEventListener('click', () => void close())

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !textInput) { event.preventDefault(); void close(); return }
    if ((event.key === 'Delete' || event.key === 'Backspace') && selectedIds.length && !textInput && !(document.activeElement instanceof HTMLInputElement)) {
      event.preventDefault()
      deleteSelected()
    }
  }
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('resize', fitToViewport)

  api.loadCaptureImage(path).then(dataURI => {
    const image = new Image()
    image.onload = () => {
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      overlay.width = image.naturalWidth
      overlay.height = image.naturalHeight
      ctx.drawImage(image, 0, 0)
      fitToViewport()
      renderOverlay()
    }
    image.onerror = () => showError(`Could not load ${name} into the editor.`)
    image.src = dataURI
  }).catch(error => {
    showError(String(error))
    void close()
  })
}
