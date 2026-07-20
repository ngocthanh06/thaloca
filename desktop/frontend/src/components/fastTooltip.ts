let initialized = false
let hideTimer = 0

export function initFastTooltips(): void {
  if (initialized) return
  initialized = true
  const tip = document.createElement('div')
  tip.className = 'fast-tooltip'
  tip.setAttribute('role', 'tooltip')
  document.body.appendChild(tip)

  const hide = () => {
    window.clearTimeout(hideTimer)
    tip.classList.remove('visible')
  }
  const show = (target: HTMLElement) => {
    const value = target.dataset.fullTooltip || target.getAttribute('title') || ''
    if (!value) return
    target.dataset.fullTooltip = value
    target.removeAttribute('title')
    tip.textContent = value
    tip.classList.add('visible')
    const rect = target.getBoundingClientRect()
    const margin = 8
    const left = Math.min(Math.max(margin, rect.left), window.innerWidth - tip.offsetWidth - margin)
    const below = rect.bottom + margin
    const top = below + tip.offsetHeight <= window.innerHeight - margin
      ? below
      : Math.max(margin, rect.top - tip.offsetHeight - margin)
    tip.style.left = `${left}px`
    tip.style.top = `${top}px`
  }

  document.addEventListener('pointerover', event => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[title], [data-full-tooltip]')
    if (!target) return
    window.clearTimeout(hideTimer)
    show(target)
  })
  document.addEventListener('pointerout', event => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-full-tooltip]')
    if (!target || target.contains(event.relatedTarget as Node | null)) return
    hideTimer = window.setTimeout(hide, 40)
  })
  document.addEventListener('focusin', event => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[title], [data-full-tooltip]')
    if (target) show(target)
  })
  document.addEventListener('focusout', hide)
  window.addEventListener('scroll', hide, true)
}
