/**
 * Shared-element "book opens" transition.
 *
 * Market-standard behaviour (WeRead, Apple Books, Kindle): tapping a cover
 * makes *that* cover grow into the reader instead of cutting to a new screen.
 *
 * Performance notes from measuring on a mid-range Android device
 * (`ro.hardware.egl=emulation`, i.e. software raster): animating
 * `box-shadow` + `border-radius` on a scaled clone re-rasterised a full-screen
 * layer every frame — 200ms frames. The rules that keep it smooth:
 *
 *  1. animate **transform only**. `opacity` on a second element is fine;
 *     shadow/radius/width/height are not.
 *  2. promote the clone to its own compositor layer *before* the first paint,
 *     so scaling never invalidates the page underneath.
 *  3. never scale a node that paints text at large size: the raster is taken at
 *     the starting size and then blown up, which both looks blurry and forces
 *     expensive re-raster when the browser decides to sharpen it. The clone here
 *     is a flat colour card, not a text block.
 *  4. keep the stage free of backdrop filters and shadows.
 */

export interface SharedElementHandle {
  /** Resolve once the cover has reached its expanded state. */
  done: Promise<void>
  /** Cancel and clean up without finishing the animation. */
  cancel: () => void
}

interface Rect {
  top: number
  left: number
  width: number
  height: number
}

function toRect(r: DOMRect): Rect {
  return { top: r.top, left: r.left, width: r.width, height: r.height }
}

export function prefersReducedMotion(): boolean {
  return !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

/**
 * Fly a visual copy of `source` to a page-sized sheet.
 * Returns `null` when it cannot animate (reduced motion / missing node), and
 * the caller then simply navigates.
 */
export function openBookTransition(
  source: HTMLElement | null,
  options: {
    duration?: number
    background?: string
    /**
     * Called once the flying card covers most of the viewport. Navigating here
     * instead of at t=0 keeps the router swap out of the animation's first
     * frames: on a software-raster device the two competing for the compositor
     * was the difference between 33ms and 50ms frames.
     */
    onCovered?: () => void
  } = {}
): SharedElementHandle | null {
  if (!source) return null
  if (prefersReducedMotion()) return null

  const duration = options.duration ?? 320
  const start = toRect(source.getBoundingClientRect())
  if (!start.width || !start.height) return null

  const background = options.background || 'var(--bg-page)'

  const stage = document.createElement('div')
  stage.setAttribute('data-shared-element-stage', '')
  stage.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:2000',
    'pointer-events:none',
    'contain:strict',
    `background:${background}`,
  ].join(';')

  // Backdrop that fades in behind the flying card, giving the destination a
  // surface to land on. Opacity-only, so it stays on the compositor.
  const sheet = document.createElement('div')
  sheet.style.cssText = [
    'position:absolute',
    'inset:0',
    `background:${background}`,
    'opacity:0',
    'will-change:opacity',
  ].join(';')

  /*
   * The flying card is a *reconstruction*, not a clone.
   *
   * Cloning the cover subtree brings its text and image layers into a scaled
   * composite layer, which the rasteriser then re-generates at the new scale
   * mid-animation. Painting the card with the same gradient and letting the
   * scale do the work keeps the raster fixed at its starting size.
   */
  const clone = document.createElement('div')
  const srcStyle = getComputedStyle(source)
  clone.style.cssText = [
    'position:absolute',
    `top:${start.top}px`,
    `left:${start.left}px`,
    `width:${start.width}px`,
    `height:${start.height}px`,
    `background:${srcStyle.backgroundImage !== 'none' ? srcStyle.backgroundImage : srcStyle.backgroundColor}`,
    `border-radius:${srcStyle.borderRadius || '4px'}`,
    'transform-origin:top left',
    'will-change:transform',
    'backface-visibility:hidden',
  ].join(';')

  // Preserve the cover image when there is one (a single <img>, cheap to hold).
  const srcImg = source.querySelector('img') as HTMLImageElement | null
  if (srcImg) {
    const img = document.createElement('img')
    img.src = srcImg.src
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block'
    clone.appendChild(img)
  }

  stage.appendChild(sheet)
  stage.appendChild(clone)
  document.body.appendChild(stage)

  const viewportW = window.innerWidth
  const viewportH = window.innerHeight

  const targetH = Math.min(viewportH * 0.58, viewportW * 1.2)
  const scale = viewportW / start.width
  const scaleY = targetH / start.height
  const targetTop = (viewportH - targetH) / 2
  const dy = targetTop - start.top

  const easing = 'cubic-bezier(0.22, 0.61, 0.36, 1)'

  // Prime the layer before animating: one paint at the start rect.
  clone.getBoundingClientRect()

  sheet.animate([{ opacity: 0 }, { opacity: 1 }], {
    duration: duration * 0.7,
    easing: 'ease-out',
    fill: 'forwards',
  })

  const flyAnim = clone.animate(
    [
      { transform: 'translate3d(0,0,0) scale(1,1)' },
      { transform: `translate3d(0, ${dy}px, 0) scale(${scale}, ${scaleY})` },
    ],
    { duration, easing, fill: 'forwards' }
  )

  let finished = false
  let cleaned = false
  let navigated = false

  const cleanup = () => {
    if (cleaned) return
    cleaned = true
    stage.remove()
  }

  // Fire the reveal at ~55% of the flight: by then the card covers the screen
  // and the reader can mount underneath without being seen mid-swap.
  const coverTimer = setTimeout(() => {
    if (finished || navigated) return
    navigated = true
    options.onCovered?.()
  }, Math.round(duration * 0.55))

  const done = new Promise<void>((resolve) => {
    flyAnim.onfinish = () => {
      if (!navigated) {
        navigated = true
        options.onCovered?.()
      }
      if (finished) return
      finished = true
      const fade = stage.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: 120,
        easing: 'ease-in',
        fill: 'forwards',
      })
      fade.onfinish = () => { cleanup(); resolve() }
      setTimeout(() => { cleanup(); resolve() }, 260)
    }
  })

  const cancel = () => {
    finished = true
    clearTimeout(coverTimer)
    flyAnim.cancel()
    cleanup()
  }

  return { done, cancel }
}
