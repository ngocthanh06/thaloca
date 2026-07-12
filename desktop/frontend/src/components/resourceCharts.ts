// Resource history sparklines (Resources tab). Each metric is an
// independent single-series trend-over-time line — per the dataviz method,
// that's a plain line chart in one hue per card, no legend needed (a
// single series needs none), with a hover crosshair + tooltip (an
// HTML/SVG chart is interactive by default, not an upgrade).
import type { ResourceSample } from '../api'
import { escapeHTML, formatBytes } from '../dom'

export type HistoryWindow = '15m' | '1h' | '24h'

interface SparkSpec {
  id: string
  label: string
  color: string
  value: (s: ResourceSample) => number
  max: number | ((samples: ResourceSample[]) => number)
  format: (v: number) => string
}

const SPARK_SPECS: SparkSpec[] = [
  { id: 'cpu', label: 'CPU', color: 'var(--accent)', value: s => s.cpu_percent, max: 100, format: v => `${v.toFixed(0)}%` },
  { id: 'mem', label: 'Memory', color: 'var(--info)', value: s => s.mem_percent, max: 100, format: v => `${v.toFixed(0)}%` },
  { id: 'disk', label: 'Disk', color: 'var(--purple)', value: s => s.disk_percent, max: 100, format: v => `${v.toFixed(0)}%` },
  {
    id: 'net',
    label: 'Network',
    color: 'var(--warning)',
    value: s => s.net_rx_bytes_per_sec + s.net_tx_bytes_per_sec,
    max: samples => Math.max(1, ...samples.map(s => s.net_rx_bytes_per_sec + s.net_tx_bytes_per_sec)),
    format: v => `${formatBytes(v)}/s`,
  },
]

const CHART_W = 280
const CHART_H = 64

export function renderResourceHistory(samples: ResourceSample[], activeWindow: HistoryWindow): string {
  const windows: HistoryWindow[] = ['15m', '1h', '24h']
  return `
    <div class="history-toolbar">
      ${windows.map(w => `<button class="btn-secondary ${w === activeWindow ? 'active' : ''}" data-history-window="${w}">${w}</button>`).join('')}
    </div>
    <div class="history-grid">
      ${SPARK_SPECS.map(spec => renderSparkCard(spec, samples)).join('')}
    </div>`
}

function resolveMax(spec: SparkSpec, samples: ResourceSample[]): number {
  return typeof spec.max === 'function' ? spec.max(samples) : spec.max
}

function renderSparkCard(spec: SparkSpec, samples: ResourceSample[]): string {
  const current = samples.length ? spec.value(samples[samples.length - 1]) : 0
  if (samples.length < 2) {
    return `
      <div class="spark-card">
        <div class="spark-card-header"><strong>${escapeHTML(spec.label)}</strong><span>${escapeHTML(spec.format(current))}</span></div>
        <div class="empty compact">Not enough history yet.</div>
      </div>`
  }
  const max = resolveMax(spec, samples)
  const stepX = CHART_W / (samples.length - 1)
  const points = samples.map((s, i) => {
    const v = Math.max(0, spec.value(s))
    const y = CHART_H - (Math.min(max, v) / max) * CHART_H
    return { x: i * stepX, y }
  })
  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')
  const areaPath = `${linePath} L ${points[points.length - 1].x.toFixed(1)} ${CHART_H} L 0 ${CHART_H} Z`
  const lastPoint = points[points.length - 1]

  return `
    <div class="spark-card">
      <div class="spark-card-header"><strong>${escapeHTML(spec.label)}</strong><span>${escapeHTML(spec.format(current))}</span></div>
      <div class="spark-svg-wrap">
        <svg viewBox="0 0 ${CHART_W} ${CHART_H}" preserveAspectRatio="none" class="spark-svg" data-spark-id="${spec.id}">
          <path d="${areaPath}" fill="${spec.color}" opacity="0.1" stroke="none"></path>
          <path d="${linePath}" fill="none" stroke="${spec.color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
          <text x="${lastPoint.x.toFixed(1)}" y="${Math.max(10, lastPoint.y - 6).toFixed(1)}" text-anchor="end" class="spark-end-label">${escapeHTML(spec.format(current))}</text>
          <line data-spark-crosshair x1="0" y1="0" x2="0" y2="${CHART_H}" class="spark-crosshair" style="display:none"></line>
          <circle data-spark-dot r="4" fill="${spec.color}" stroke="var(--bg-card)" stroke-width="2" style="display:none"></circle>
        </svg>
        <div class="spark-tooltip" data-spark-tooltip style="display:none"></div>
      </div>
    </div>`
}

// Wires the hover crosshair + tooltip on every spark card after the
// container's innerHTML has been (re)stamped — a plain re-render each time
// (like the rest of this app), not a persistent component, so listeners
// are reattached fresh on every call.
export function wireResourceHistoryHover(container: HTMLElement, samples: ResourceSample[]): void {
  if (samples.length < 2) return
  const stepX = CHART_W / (samples.length - 1)

  for (const spec of SPARK_SPECS) {
    const svg = container.querySelector<SVGSVGElement>(`svg[data-spark-id="${spec.id}"]`)
    if (!svg) continue
    const crosshair = svg.querySelector<SVGLineElement>('[data-spark-crosshair]')
    const dot = svg.querySelector<SVGCircleElement>('[data-spark-dot]')
    const tooltip = svg.parentElement?.querySelector<HTMLElement>('[data-spark-tooltip]')
    if (!crosshair || !dot || !tooltip) continue
    const max = resolveMax(spec, samples)

    const showAt = (index: number, clientX: number, clientY: number) => {
      const sample = samples[index]
      const value = Math.max(0, spec.value(sample))
      const x = index * stepX
      const y = CHART_H - (Math.min(max, value) / max) * CHART_H
      crosshair.setAttribute('x1', String(x))
      crosshair.setAttribute('x2', String(x))
      crosshair.style.display = ''
      dot.setAttribute('cx', String(x))
      dot.setAttribute('cy', String(y))
      dot.style.display = ''
      tooltip.textContent = `${formatSampleTime(sample.at)} — ${spec.format(value)}`
      tooltip.style.display = ''
      const wrapRect = svg.parentElement!.getBoundingClientRect()
      tooltip.style.left = `${clientX - wrapRect.left + 8}px`
      tooltip.style.top = `${clientY - wrapRect.top - 24}px`
    }
    const hide = () => {
      crosshair.style.display = 'none'
      dot.style.display = 'none'
      tooltip.style.display = 'none'
    }

    svg.addEventListener('pointermove', event => {
      const rect = svg.getBoundingClientRect()
      const relX = ((event.clientX - rect.left) / rect.width) * CHART_W
      const index = Math.max(0, Math.min(samples.length - 1, Math.round(relX / stepX)))
      showAt(index, event.clientX, event.clientY)
    })
    svg.addEventListener('pointerleave', hide)
  }
}

function formatSampleTime(at: string): string {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return at
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
