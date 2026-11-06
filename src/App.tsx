import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AnimationEvent, CSSProperties, DragEvent, ReactNode } from 'react'
import { Check, Code, Copy, Pause, Play, RotateCcw, Upload } from 'lucide-react'

const EASINGS = ['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out'] as const

type Easing = (typeof EASINGS)[number]
type ExportTab = 'css' | 'motion'

type PathItem = {
  id: string
  d: string
  length: number
}

type SvgDocument = {
  name: string
  viewBox: string | null
  paths: PathItem[]
}

type CssVars = CSSProperties & Record<`--${string}`, string>

const DEFAULT_DURATION = 2
const DEFAULT_STROKE = 2.5
const DEFAULT_COLOR = '#c4b5fd'
const DEFAULT_EASING: Easing = 'ease-in-out'

const SAMPLE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 480">
  <path d="M96 48H384A48 48 0 0 1 432 96V384A48 48 0 0 1 384 432H96A48 48 0 0 1 48 384V96A48 48 0 0 1 96 48Z"/>
  <path d="M240 148C290.8 148 332 189.2 332 240C332 290.8 290.8 332 240 332C189.2 332 148 290.8 148 240C148 189.2 189.2 148 240 148Z"/>
  <path d="M186 248C206 270 220 286 234 292C258 250 280 214 304 196"/>
</svg>`

const MOTION_EASE: Record<Easing, string> = {
  linear: '"linear"',
  ease: '[0.25, 0.1, 0.25, 1]',
  'ease-in': '"easeIn"',
  'ease-out': '"easeOut"',
  'ease-in-out': '"easeInOut"',
}

const EASING_LABEL: Record<Easing, string> = {
  linear: 'Linear',
  ease: 'Ease',
  'ease-in': 'Ease in',
  'ease-out': 'Ease out',
  'ease-in-out': 'Ease in out',
}

const measureTries = new WeakMap<SVGPathElement, number>()

function cx(...parts: Array<string | false | null | undefined>) {
  return parts.filter(Boolean).join(' ')
}

function roundLen(value: number) {
  return Math.round(value * 100) / 100
}

function roundStep(value: number, min: number, max: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback
  const clamped = Math.min(max, Math.max(min, value))
  return Math.round(clamped * 10) / 10
}

function isEasing(value: string): value is Easing {
  return (EASINGS as readonly string[]).includes(value)
}

function readViewBox(svg: Element) {
  const raw = svg.getAttribute('viewBox')
  if (raw) {
    const parts = raw.trim().replace(/,/g, ' ').split(/\s+/).map(Number)
    if (parts.length === 4 && parts.every((part) => Number.isFinite(part)) && parts[2] > 0 && parts[3] > 0) {
      return parts.join(' ')
    }
  }
  const width = Number.parseFloat(svg.getAttribute('width') ?? '')
  const height = Number.parseFloat(svg.getAttribute('height') ?? '')
  if (width > 0 && height > 0) return `0 0 ${width} ${height}`
  return null
}

function createDocument(name: string, raw: string): SvgDocument | null {
  const parsed = new DOMParser().parseFromString(raw, 'image/svg+xml')
  if (parsed.querySelector('parsererror')) return null
  const svg = parsed.querySelector('svg')
  if (!svg) return null
  const nodes = Array.from(svg.querySelectorAll('path')).filter((node) => {
    if (node.closest('defs, clipPath, mask, symbol, pattern')) return false
    return Boolean(node.getAttribute('d')?.trim())
  })
  if (nodes.length === 0) return null
  return {
    name,
    viewBox: readViewBox(svg),
    paths: nodes.map((node, index) => ({
      id: `path-${index + 1}`,
      d: (node.getAttribute('d') ?? '').replace(/\s+/g, ' ').trim(),
      length: 0,
    })),
  }
}

function viewBoxFromSvg(svg: SVGSVGElement) {
  try {
    const box = svg.getBBox()
    if (box.width <= 0 && box.height <= 0) return null
    const pad = Math.max(box.width, box.height, 1) * 0.08
    return [box.x - pad, box.y - pad, box.width + pad * 2, box.height + pad * 2].map(roundLen).join(' ')
  } catch {
    return null
  }
}

function measurePaths(
  node: SVGPathElement | null,
  commit: (measured: number[], viewBox: string | null) => void,
) {
  if (!node?.ownerSVGElement) return
  const svg = node.ownerSVGElement
  const elements = Array.from(svg.querySelectorAll<SVGPathElement>('[data-draw-path]'))
  if (elements.length === 0) return
  const measured = elements.map((element) => roundLen(element.getTotalLength()))
  const drawing = elements.some((element) => /[LlHhVvCcSsQqTtAa]/.test(element.getAttribute('d') ?? ''))
  if (drawing && measured.every((length) => length === 0)) {
    const tries = measureTries.get(node) ?? 0
    if (tries < 4) {
      measureTries.set(node, tries + 1)
      requestAnimationFrame(() => {
        if (node.isConnected) measurePaths(node, commit)
      })
      return
    }
  }
  commit(measured, viewBoxFromSvg(svg))
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function escapeJsString(value: string) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
    .replace(/</g, '\\u003c')
}

function cssColor(value: string) {
  return /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : DEFAULT_COLOR
}

function formatStep(value: number) {
  return value.toFixed(1)
}

function buildCss(doc: SvgDocument, duration: number, easing: Easing, color: string, strokeWidth: number) {
  const viewBox = doc.viewBox ?? '0 0 100 100'
  const stroke = cssColor(color)
  const paths = doc.paths
    .map((path) => `  <path style="--path-length: ${path.length}" d="${escapeHtml(path.d)}" />`)
    .join('\n')

  return `<svg class="svg-path-draw" viewBox="${escapeHtml(viewBox)}" fill="none" xmlns="http://www.w3.org/2000/svg" style="--duration: ${formatStep(duration)}s; --easing: ${easing}; --stroke: ${stroke}; --stroke-width: ${formatStep(strokeWidth)}">
${paths}
</svg>

<style>
  .svg-path-draw path {
    fill: none;
    stroke: var(--stroke);
    stroke-width: var(--stroke-width);
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-dasharray: var(--path-length);
    stroke-dashoffset: var(--path-length);
    animation: svg-draw var(--duration) var(--easing) forwards;
  }

  @keyframes svg-draw {
    from {
      stroke-dashoffset: var(--path-length);
    }
    to {
      stroke-dashoffset: 0;
    }
  }
</style>`
}

function buildMotion(doc: SvgDocument, duration: number, easing: Easing, color: string, strokeWidth: number) {
  const viewBox = doc.viewBox ?? '0 0 100 100'
  const stroke = cssColor(color)
  const pathLines = doc.paths
    .map((path) => `  { d: "${escapeJsString(path.d)}", length: ${path.length} },`)
    .join('\n')

  return `import { motion } from "framer-motion";

const paths = [
${pathLines}
];

export function AnimatedPaths() {
  return (
    <svg viewBox="${escapeHtml(viewBox)}" fill="none" xmlns="http://www.w3.org/2000/svg">
      {paths.map((path, index) => (
        <motion.path
          key={index}
          d={path.d}
          fill="none"
          stroke="${stroke}"
          strokeWidth={${formatStep(strokeWidth)}}
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={{ strokeDasharray: path.length, strokeDashoffset: path.length }}
          animate={{ strokeDasharray: path.length, strokeDashoffset: 0 }}
          transition={{ duration: ${formatStep(duration)}, ease: ${MOTION_EASE[easing]} }}
        />
      ))}
    </svg>
  );
}`
}

function isSvgFile(file: File) {
  const name = file.name.toLowerCase()
  return name.endsWith('.svg') || file.type === 'image/svg+xml' || file.type === 'image/svg'
}

async function copyText(text: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return
    }
  } catch {
    // Fall through when the async clipboard is unavailable.
  }
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.left = '-9999px'
  document.body.append(area)
  area.select()
  const ok = document.execCommand('copy')
  area.remove()
  if (!ok) throw new Error('copy failed')
}

function rangeBackground(value: number, min: number, max: number) {
  const pct = ((value - min) / (max - min)) * 100
  return `linear-gradient(to right, #818cf8 ${pct}%, #3f3f46 ${pct}%)`
}

function Field({ label, value, children }: { label: string; value?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-2 flex items-center justify-between gap-3 text-[11px] font-medium tracking-[0.14em] text-zinc-500 uppercase">
        {label}
        {value ? <span className="font-mono text-xs tracking-normal text-zinc-200 normal-case">{value}</span> : null}
      </span>
      {children}
    </label>
  )
}

function ControlButton({
  label,
  active = false,
  pressed,
  disabled = false,
  onClick,
  children,
}: {
  label: string
  active?: boolean
  pressed?: boolean
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pressed}
      disabled={disabled}
      className={cx(
        'flex flex-col items-center gap-1.5 rounded-2xl border px-3 py-3 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/70 active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40',
        active
          ? 'border-transparent bg-indigo-500 text-white shadow-lg shadow-indigo-500/25'
          : 'border-white/10 bg-zinc-950 text-zinc-300 hover:border-white/20 hover:text-white',
      )}
    >
      {children}
      {label}
    </button>
  )
}

function App() {
  const [doc, setDoc] = useState<SvgDocument | null>(() => createDocument('sample.svg', SAMPLE_SVG))
  const [duration, setDuration] = useState(DEFAULT_DURATION)
  const [appliedDuration, setAppliedDuration] = useState(DEFAULT_DURATION)
  const [easing, setEasing] = useState<Easing>(DEFAULT_EASING)
  const [color, setColor] = useState(DEFAULT_COLOR)
  const [strokeWidth, setStrokeWidth] = useState(DEFAULT_STROKE)
  const [playing, setPlaying] = useState(true)
  const [finished, setFinished] = useState(false)
  const [animEpoch, setAnimEpoch] = useState(0)
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [tab, setTab] = useState<ExportTab>('css')
  const [toast, setToast] = useState<{ id: number; message: string; ok: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragOver, setDragOver] = useState(false)

  const fileRef = useRef<HTMLInputElement>(null)
  const durationRef = useRef(DEFAULT_DURATION)
  const appliedRef = useRef(DEFAULT_DURATION)
  const endedRef = useRef(0)
  const dragDepth = useRef(0)
  const toastTimer = useRef<number | null>(null)
  const durationUpRef = useRef<(() => void) | null>(null)

  const onPathRef = useCallback((node: SVGPathElement | null) => {
    measurePaths(node, (measured, box) => {
      setDoc((current) => {
        if (!current || current.paths.length !== measured.length) return current
        const viewBox = current.viewBox ?? box
        const sameLengths = current.paths.every((path, index) => Math.abs(path.length - measured[index]) < 0.001)
        if (sameLengths && viewBox === current.viewBox) return current
        return {
          ...current,
          viewBox,
          paths: current.paths.map((path, index) => ({ ...path, length: measured[index] ?? 0 })),
        }
      })
    })
  }, [])

  const restart = useCallback(() => {
    endedRef.current = 0
    setFinished(false)
    setPlaying(true)
    setAnimEpoch((epoch) => epoch + 1)
  }, [])

  const commitDuration = useCallback(() => {
    const next = durationRef.current
    if (appliedRef.current === next) return
    appliedRef.current = next
    setAppliedDuration(next)
    restart()
  }, [restart])

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setDrawerOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!drawerOpen) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
    }
  }, [drawerOpen])

  useEffect(() => {
    function preventNavigation(event: globalThis.DragEvent) {
      event.preventDefault()
    }
    window.addEventListener('dragover', preventNavigation)
    window.addEventListener('drop', preventNavigation)
    return () => {
      window.removeEventListener('dragover', preventNavigation)
      window.removeEventListener('drop', preventNavigation)
      if (toastTimer.current) window.clearTimeout(toastTimer.current)
      if (durationUpRef.current) window.removeEventListener('pointerup', durationUpRef.current)
    }
  }, [])

  const cssSnippet = useMemo(
    () => (doc ? buildCss(doc, duration, easing, color, strokeWidth) : ''),
    [doc, duration, easing, color, strokeWidth],
  )
  const motionSnippet = useMemo(
    () => (doc ? buildMotion(doc, duration, easing, color, strokeWidth) : ''),
    [doc, duration, easing, color, strokeWidth],
  )
  const activeSnippet = tab === 'css' ? cssSnippet : motionSnippet
  const copied = toast?.ok === true && toast.message === 'Copied!'
  const ready = Boolean(doc?.paths.some((path) => path.length > 0))
  const totalLength = doc?.paths.reduce((sum, path) => sum + path.length, 0) ?? 0

  function flash(message: string, ok: boolean) {
    setToast({ id: Date.now(), message, ok })
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 1800)
  }

  function loadDocument(next: SvgDocument) {
    setError(null)
    setDoc(next)
    restart()
  }

  async function ingest(file: File) {
    if (!isSvgFile(file)) {
      setError('Upload an .svg file.')
      return
    }
    try {
      const raw = (await file.text()).replace(/^\uFEFF/, '')
      const next = createDocument(file.name, raw)
      if (!next) {
        setError('No drawable <path> elements were found in that SVG.')
        return
      }
      loadDocument(next)
    } catch {
      setError('That file could not be read.')
    }
  }

  function browse() {
    fileRef.current?.click()
  }

  function play() {
    if (finished) {
      restart()
      return
    }
    setPlaying(true)
  }

  function pause() {
    setPlaying(false)
  }

  function onEasingChange(value: string) {
    if (!isEasing(value) || value === easing) return
    setEasing(value)
    restart()
  }

  function armDurationCommit() {
    if (durationUpRef.current) window.removeEventListener('pointerup', durationUpRef.current)
    const onUp = () => {
      window.removeEventListener('pointerup', onUp)
      durationUpRef.current = null
      commitDuration()
    }
    durationUpRef.current = onUp
    window.addEventListener('pointerup', onUp)
  }

  function onDurationChange(event: { target: { value: string } }) {
    const next = roundStep(Number(event.target.value), 0.2, 5, DEFAULT_DURATION)
    durationRef.current = next
    setDuration(next)
  }

  async function copyCode() {
    if (!activeSnippet) return
    try {
      await copyText(activeSnippet)
      flash('Copied!', true)
    } catch {
      flash('Could not copy', false)
    }
  }

  function onDragEnter(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    dragDepth.current += 1
    setDragOver(true)
  }

  function onDragLeave(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragOver(false)
  }

  function onDragOver(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault()
    dragDepth.current = 0
    setDragOver(false)
    const file = event.dataTransfer.files?.[0]
    if (file) void ingest(file)
  }

  function onAnimationEnd(event: AnimationEvent<SVGSVGElement>) {
    if (event.animationName !== 'svg-draw') return
    if (event.currentTarget.dataset.epoch !== String(animEpoch)) return
    const total = event.currentTarget.querySelectorAll('[data-animated="true"]').length
    endedRef.current += 1
    if (total > 0 && endedRef.current === total) {
      setPlaying(false)
      setFinished(true)
    }
  }

  function pathStyle(path: PathItem): CssVars {
    const style: CssVars = {
      '--path-length': String(path.length),
      visibility: path.length > 0 ? 'visible' : 'hidden',
    }
    if (path.length <= 0) return style
    style.strokeDasharray = 'var(--path-length)'
    if (finished) {
      style.strokeDashoffset = '0'
      return style
    }
    style.strokeDashoffset = 'var(--path-length)'
    style.animationName = 'svg-draw'
    style.animationDuration = 'var(--duration)'
    style.animationTimingFunction = 'var(--easing)'
    style.animationFillMode = 'forwards'
    style.animationPlayState = playing ? 'running' : 'paused'
    return style
  }

  const svgVars = {
    '--duration': `${formatStep(appliedDuration)}s`,
    '--easing': easing,
    '--stroke': cssColor(color),
    '--stroke-width': formatStep(strokeWidth),
  } as CssVars

  return (
    <div
      className="relative min-h-screen bg-zinc-950 text-zinc-100"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ background: 'radial-gradient(ellipse at top, rgba(99,102,241,0.18), transparent 52%)' }}
      />
      <input
        ref={fileRef}
        type="file"
        accept=".svg,image/svg+xml"
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0]
          event.target.value = ''
          if (file) void ingest(file)
        }}
      />

      <div className="relative mx-auto flex min-h-screen w-full max-w-[1440px] flex-col px-4 py-5 sm:px-6 lg:h-screen">
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="grid size-11 place-items-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-500 shadow-lg shadow-indigo-500/30">
              <svg viewBox="0 0 24 24" className="size-5" fill="none" aria-hidden="true">
                <path d="M4 15.5c2.2-5.5 4.6-8 8-8s4.8 3.6 8 4" stroke="white" strokeWidth="1.8" strokeLinecap="round" />
                <path d="M5 19h7.5" stroke="white" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
            </div>
            <div>
              <h1 className="text-lg font-semibold tracking-tight text-white">SVG Animator</h1>
              <p className="text-sm text-zinc-400">Draw every path, then export the motion.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setDrawerOpen((open) => !open)}
            aria-expanded={drawerOpen}
            aria-controls="code-drawer"
            disabled={!doc}
            className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-indigo-500 to-violet-500 px-4 py-2.5 text-sm font-medium text-white shadow-lg shadow-indigo-500/25 transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Code className="size-4" />
            Export code
          </button>
        </header>

        <main className="mt-5 grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(0,1fr)_22.5rem]">
          <section
            data-dropzone
            className={cx(
              'flex min-h-[32rem] flex-col overflow-hidden rounded-3xl border bg-zinc-900 shadow-2xl shadow-black/40 transition-colors lg:min-h-0',
              dragOver ? 'border-indigo-400/80' : 'border-white/10',
            )}
          >
            <div className="relative min-h-0 flex-1">
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0"
                style={{
                  backgroundImage:
                    'linear-gradient(to right, rgba(255,255,255,0.045) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.045) 1px, transparent 1px)',
                  backgroundSize: '32px 32px',
                  maskImage: 'radial-gradient(ellipse at center, black 45%, transparent 80%)',
                  WebkitMaskImage: 'radial-gradient(ellipse at center, black 45%, transparent 80%)',
                }}
              />
              <div
                aria-hidden
                className="pointer-events-none absolute inset-0"
                style={{ background: 'radial-gradient(circle at 50% 42%, rgba(139,92,246,0.16), transparent 48%)' }}
              />
              <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/25 to-transparent" />

              {doc ? (
                <div className="absolute inset-0 grid place-items-center p-8 sm:p-12">
                  <svg
                    viewBox={doc.viewBox ?? undefined}
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                    preserveAspectRatio="xMidYMid meet"
                    role="img"
                    aria-label={`Animated preview of ${doc.name}`}
                    data-epoch={animEpoch}
                    onAnimationEnd={onAnimationEnd}
                    className={cx('h-full max-h-full w-full', !doc.viewBox && 'invisible')}
                    style={svgVars}
                  >
                    {doc.paths.map((path) => (
                      <path
                        key={`${path.id}-${animEpoch}`}
                        ref={onPathRef}
                        data-draw-path=""
                        data-animated={path.length > 0 ? 'true' : 'false'}
                        d={path.d}
                        fill="none"
                        stroke={color}
                        strokeWidth={strokeWidth}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        style={pathStyle(path)}
                      />
                    ))}
                  </svg>
                </div>
              ) : (
                <div className="absolute inset-0 grid place-items-center p-8">
                  <div className="flex max-w-sm flex-col items-center text-center">
                    <div className="mb-4 grid size-14 place-items-center rounded-2xl border border-dashed border-white/15 bg-white/5 text-indigo-200">
                      <Upload className="size-6" />
                    </div>
                    <p className="text-base font-medium text-white">Drop an SVG to animate its paths</p>
                    <p className="mt-1 text-sm text-zinc-400">Every path element is measured and drawn on.</p>
                    <button
                      type="button"
                      onClick={browse}
                      className="mt-5 inline-flex items-center gap-2 rounded-xl border border-white/10 bg-zinc-950 px-4 py-2 text-sm text-zinc-100 transition hover:border-white/20"
                    >
                      <Upload className="size-4" />
                      Browse files
                    </button>
                  </div>
                </div>
              )}

              {dragOver ? (
                <div className="absolute inset-0 z-20 grid place-items-center bg-zinc-950/75 backdrop-blur-[2px]">
                  <div className="flex flex-col items-center gap-2 text-indigo-100">
                    <Upload className="size-8" />
                    <p className="text-base font-medium">Drop SVG to animate</p>
                  </div>
                </div>
              ) : null}
            </div>

            <footer className="flex items-center justify-between gap-3 border-t border-white/10 px-4 py-3">
              <div className="flex min-w-0 items-center gap-2 text-sm text-zinc-400">
                <span
                  className={cx(
                    'size-1.5 shrink-0 rounded-full',
                    playing ? 'bg-indigo-400 shadow-[0_0_10px_rgba(129,140,248,0.95)]' : 'bg-zinc-600',
                  )}
                />
                <span className="truncate">{playing ? 'Playing' : finished ? 'Finished' : 'Paused'}</span>
                <span className="text-zinc-600">/</span>
                <span className="truncate text-zinc-500">{doc?.name ?? 'No file'}</span>
              </div>
              <span className="shrink-0 font-mono text-xs text-zinc-500">
                {doc ? `${doc.paths.length} path${doc.paths.length === 1 ? '' : 's'}` : '—'}
              </span>
            </footer>
          </section>

          <aside className="flex flex-col gap-5 overflow-y-auto rounded-3xl border border-white/10 bg-zinc-900 p-4 shadow-2xl shadow-black/30">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[11px] font-medium tracking-[0.14em] text-zinc-500 uppercase">Source</p>
                <p className="truncate text-sm text-zinc-100">{doc?.name ?? 'No SVG loaded'}</p>
              </div>
              <button
                type="button"
                onClick={browse}
                className="inline-flex shrink-0 items-center gap-2 rounded-xl border border-white/10 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 transition hover:border-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/70"
              >
                <Upload className="size-4" />
                Upload
              </button>
            </div>

            {error ? (
              <p role="alert" className="rounded-xl border border-rose-400/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-100">
                {error}
              </p>
            ) : null}

            <div className="grid grid-cols-3 gap-2">
              <ControlButton label="Play" active={!playing} pressed={!playing} disabled={!doc} onClick={play}>
                <Play className="size-4" />
              </ControlButton>
              <ControlButton label="Pause" active={playing} pressed={playing} disabled={!doc} onClick={pause}>
                <Pause className="size-4" />
              </ControlButton>
              <ControlButton label="Replay" disabled={!doc} onClick={restart}>
                <RotateCcw className="size-4" />
              </ControlButton>
            </div>

            <Field label="Duration" value={`${formatStep(duration)}s`}>
              <input
                type="range"
                min={0.2}
                max={5}
                step={0.1}
                value={duration}
                aria-label="Duration"
                onChange={onDurationChange}
                onPointerDown={armDurationCommit}
                onKeyUp={commitDuration}
                onBlur={commitDuration}
                style={{ background: rangeBackground(duration, 0.2, 5) }}
                className="w-full"
              />
              <span className="mt-2 flex justify-between font-mono text-[10px] text-zinc-600">
                <span>0.2s</span>
                <span>5.0s</span>
              </span>
            </Field>

            <Field label="Easing">
              <div className="relative">
                <select
                  value={easing}
                  aria-label="Easing"
                  onChange={(event) => onEasingChange(event.target.value)}
                  className="w-full appearance-none rounded-xl border border-white/10 bg-zinc-950 py-2.5 pr-10 pl-3 text-sm text-zinc-100 outline-none focus-visible:ring-2 focus-visible:ring-indigo-400/70"
                >
                  {EASINGS.map((option) => (
                    <option key={option} value={option}>
                      {EASING_LABEL[option]}
                    </option>
                  ))}
                </select>
                <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-zinc-500">
                  <svg viewBox="0 0 20 20" className="size-4" fill="none" aria-hidden="true">
                    <path d="M5 7.5 10 12.5 15 7.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                  </svg>
                </span>
              </div>
            </Field>

            <Field label="Stroke color" value={color.toUpperCase()}>
              <div className="flex items-center gap-3 rounded-xl border border-white/10 bg-zinc-950 px-3 py-2">
                <span className="size-6 rounded-md border border-white/10" style={{ background: color }} />
                <input
                  type="color"
                  value={cssColor(color)}
                  aria-label="Stroke color"
                  onChange={(event) => setColor(event.target.value)}
                  className="ml-auto size-8 cursor-pointer rounded-md border-0 bg-transparent p-0"
                />
              </div>
            </Field>

            <Field label="Stroke width" value={formatStep(strokeWidth)}>
              <input
                type="range"
                min={0.5}
                max={12}
                step={0.1}
                value={strokeWidth}
                aria-label="Stroke width"
                onChange={(event) => setStrokeWidth(roundStep(Number(event.target.value), 0.5, 12, DEFAULT_STROKE))}
                style={{ background: rangeBackground(strokeWidth, 0.5, 12) }}
                className="w-full"
              />
            </Field>

            <div className="border-t border-white/10 pt-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <p className="text-[11px] font-medium tracking-[0.14em] text-zinc-500 uppercase">Paths</p>
                <p className="font-mono text-[11px] text-zinc-500">{ready ? `Total ${totalLength.toFixed(1)}` : 'Measuring…'}</p>
              </div>
              <p className="mb-3 text-xs text-zinc-500">Lengths come from path.getTotalLength().</p>
              <ol className="max-h-52 space-y-1.5 overflow-auto pr-1">
                {doc?.paths.map((path, index) => (
                  <li key={path.id} className="rounded-xl border border-white/10 bg-zinc-950/70 px-3 py-2">
                    <div className="flex items-center justify-between gap-3 text-xs">
                      <span className="font-medium text-zinc-300">Path {index + 1}</span>
                      <span className="font-mono text-indigo-200">{path.length > 0 ? path.length.toFixed(1) : '—'}</span>
                    </div>
                    <p className="mt-1 truncate font-mono text-[11px] text-zinc-500">{path.d}</p>
                  </li>
                ))}
              </ol>
            </div>
          </aside>
        </main>
      </div>

      <button
        type="button"
        aria-label="Close code drawer"
        tabIndex={drawerOpen ? 0 : -1}
        onClick={() => setDrawerOpen(false)}
        className={cx(
          'fixed inset-0 z-30 bg-black/60 transition-opacity',
          drawerOpen ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      />

      <aside
        id="code-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Export animation code"
        aria-hidden={!drawerOpen}
        inert={!drawerOpen}
        className={cx(
          'fixed inset-y-0 right-0 z-40 flex w-full max-w-xl flex-col border-l border-white/10 bg-zinc-950/95 shadow-2xl shadow-black/50 backdrop-blur-xl transition-transform duration-300',
          drawerOpen ? 'translate-x-0' : 'translate-x-full',
        )}
      >
        <div className="flex items-start justify-between gap-3 border-b border-white/10 px-5 py-4">
          <div>
            <p className="text-[11px] font-medium tracking-[0.14em] text-zinc-500 uppercase">Exporter</p>
            <h2 className="mt-1 text-base font-semibold text-white">Animation code</h2>
          </div>
          <button
            type="button"
            onClick={() => setDrawerOpen(false)}
            className="rounded-lg px-2 py-1 text-sm text-zinc-400 transition hover:bg-white/5 hover:text-white"
          >
            Close
          </button>
        </div>

        <div className="px-5 pt-4">
          <div role="tablist" aria-label="Export format" className="grid grid-cols-2 gap-1 rounded-xl bg-zinc-900 p-1">
            {(
              [
                ['css', 'CSS keyframes'],
                ['motion', 'Framer Motion'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                id={`tab-${id}`}
                aria-selected={tab === id}
                aria-controls={`panel-${id}`}
                onClick={() => setTab(id)}
                className={cx(
                  'rounded-lg px-3 py-2 text-sm font-medium transition',
                  tab === id ? 'bg-zinc-800 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-300',
                )}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="mt-3 text-xs text-zinc-500">
            {tab === 'css'
              ? 'Inline custom properties on the SVG, one draw keyframe.'
              : 'React paths animated with stroke dash offset.'}
          </p>
        </div>

        <div
          role="tabpanel"
          id={`panel-${tab}`}
          aria-labelledby={`tab-${tab}`}
          className="mx-5 mt-4 mb-4 min-h-0 flex-1 overflow-auto rounded-2xl border border-white/10 bg-zinc-900"
        >
          <pre className="overflow-auto p-4 font-mono text-[12px] leading-6 break-words whitespace-pre-wrap text-zinc-300">
            <code>{activeSnippet}</code>
          </pre>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-white/10 px-5 py-4">
          <span className="font-mono text-[11px] text-zinc-500">
            {activeSnippet ? `${activeSnippet.split('\n').length} lines` : '—'}
          </span>
          <button
            type="button"
            onClick={() => void copyCode()}
            disabled={!activeSnippet || !ready}
            className="inline-flex items-center gap-2 rounded-xl bg-white px-4 py-2.5 text-sm font-medium text-zinc-950 transition hover:bg-zinc-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            {copied ? 'Copied!' : 'Copy code'}
          </button>
        </div>
      </aside>

      {toast ? (
        <div
          key={toast.id}
          role="status"
          className="toast-in pointer-events-none fixed top-5 left-1/2 z-[70] flex items-center gap-2 rounded-full border border-white/10 bg-zinc-900/95 px-4 py-2 text-sm text-zinc-100 shadow-2xl shadow-black/40"
        >
          {toast.ok ? <Check className="size-4 text-emerald-300" /> : null}
          {toast.message}
        </div>
      ) : null}
    </div>
  )
}

export default App
