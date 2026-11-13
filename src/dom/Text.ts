import type { TextClass, TextCss, TextOptions } from '../types.js'
import { DomSdf, type DomSdfRebuildOptions } from './DomSdf.js'

const UNITLESS = new Set(
  'animation-iteration-count aspect-ratio column-count fill-opacity flex flex-grow flex-shrink font-size-adjust font-weight initial-letter line-clamp line-height math-depth opacity order orphans scale stop-opacity stroke-miterlimit stroke-opacity tab-size widows z-index zoom'.split(
    ' ',
  ),
)
const UNITLESS_RE = /^(?:border-image-|grid-(?:column|row))/

function cssDeclarations(document: Document, css: TextCss): string {
  if (typeof css === 'string') return css
  const style = document.createElement('div').style
  for (const [key, value] of Object.entries(css)) {
    if (value === null || value === undefined) continue
    const property = key.startsWith('--')
      ? key
      : key === 'cssFloat'
        ? 'float'
        : key
            .replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)
            .replace(/^(webkit|moz|ms|o)-/, '-$1-')
    const unprefixed = property.replace(/^-(webkit|moz|ms|o)-/, '')
    if (typeof value === 'number' && !Number.isFinite(value))
      throw new TypeError(`Text: CSS ${key} must be finite`)
    style.setProperty(
      property,
      typeof value === 'number' &&
        !key.startsWith('--') &&
        !UNITLESS.has(unprefixed) &&
        !UNITLESS_RE.test(unprefixed)
        ? `${value}px`
        : String(value),
    )
  }
  return style.cssText
}

function classNames(cssClass: TextClass): string {
  const names =
    typeof cssClass === 'string'
      ? cssClass
      : Array.isArray(cssClass)
        ? cssClass.join(' ')
        : Object.keys(cssClass)
            .filter((k) => (cssClass as Readonly<Record<string, boolean | undefined>>)[k])
            .join(' ')
  return [...new Set(names.trim().split(/\s+/).filter(Boolean))].join(' ')
}

function copyOptions(options: TextOptions): TextOptions {
  const { css, cssClass } = options
  return {
    ...options,
    ...(typeof css === 'object' ? { css: Object.freeze({ ...css }) } : {}),
    ...(typeof cssClass === 'object'
      ? {
          cssClass: Object.freeze(
            Array.isArray(cssClass)
              ? [...(cssClass as readonly string[])]
              : { ...(cssClass as object) },
          ),
        }
      : {}),
  }
}

function createSource(
  message: string,
  options: TextOptions,
): readonly [HTMLElement, HTMLElement, HTMLElement] {
  const parent =
    options.parent ??
    (typeof globalThis.document === 'undefined' ? undefined : globalThis.document.body)
  if (!parent?.isConnected)
    throw new Error('Text: parent must be connected; create text after document.body is available')
  const document = parent.ownerDocument
  const host = document.createElement('div')
  host.setAttribute('data-ultra-text-host', '')
  host.style.cssText =
    'position:fixed;left:0;top:0;display:grid;width:max-content;max-width:100%;min-width:1px;min-height:1px;margin:0;padding:0;border:0;clip-path:inset(100%);pointer-events:none;z-index:-2147483648;'.replaceAll(
      ';',
      '!important;',
    ) + 'white-space:pre-wrap;'
  const source = document.createElement('div')
  source.setAttribute('data-sdf-block', '')
  source.textContent = message
  if (options.css !== undefined) source.style.cssText = cssDeclarations(document, options.css)
  if (options.cssClass !== undefined) source.className = classNames(options.cssClass)
  host.append(source)
  return [parent, host, source]
}

function waitForFonts(document: Document, signals: readonly AbortSignal[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      for (const s of signals) s.removeEventListener('abort', aborted)
    }
    const aborted = () => {
      cleanup()
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      reject(
        signals.find((s) => s.aborted)?.reason ??
          new DOMException('Text initialization was aborted', 'AbortError'),
      )
    }
    if (signals.some((s) => s.aborted)) {
      aborted()
      return
    }
    for (const s of signals) s.addEventListener('abort', aborted, { once: true })
    void Promise.resolve((document.fonts as FontFaceSet | undefined)?.ready)
      .finally(cleanup)
      .then(() => {
        resolve()
      }, reject)
  })
}

export class Text extends DomSdf {
  declare readonly options: Readonly<TextOptions>
  readonly ready: Promise<this>
  protected override readonly pageBackdrop = false
  #h: HTMLElement
  #a = new AbortController()
  #d = false
  #r = 0
  #i = false

  constructor(message: string, options: TextOptions) {
    const input = copyOptions(options)
    const [parent, host, source] = createSource(message, input)
    super(input.renderer, source, input)
    this.name = 'ultra-text string text'
    this.#h = host
    try {
      parent.append(host)
    } catch (error) {
      this.dispose()
      throw error
    }
    this.ready = this.#p()
  }

  async #p(): Promise<this> {
    try {
      let revision = await this.#wf()
      this.#i = true
      const initial = this.initialize()
      this.#i = false
      await initial
      while (revision !== this.#r) {
        revision = await this.#wf()
        await super.rebuild()
      }
      this.#a.signal.throwIfAborted()
      this.options.signal?.throwIfAborted()
      return this
    } catch (error) {
      this.dispose()
      throw error
    }
  }

  async #wf(): Promise<number> {
    let revision: number
    do {
      revision = this.#r
      this.source.getBoundingClientRect()
      await waitForFonts(this.source.ownerDocument, [
        this.#a.signal,
        ...(this.options.signal ? [this.options.signal] : []),
      ])
    } while (revision !== this.#r)
    return revision
  }

  get text(): string {
    return this.source.textContent
  }

  set text(message: string) {
    this.#l()
    this.source.textContent = message
  }

  setCss(css: TextCss): this {
    this.#l()
    this.source.style.cssText = cssDeclarations(this.source.ownerDocument, css)
    return this
  }

  setClass(cssClass: TextClass): this {
    this.#l()
    this.source.className = classNames(cssClass)
    if (this.options.selectable) this.source.classList.add('sdf-selectable')
    return this
  }

  override async rebuild(options: DomSdfRebuildOptions = {}): Promise<void> {
    if (!this.#i) await this.ready
    await super.rebuild(options)
  }

  #l(): void {
    if (this.#d) throw new Error('Text: this instance is disposed')
    this.#r++
  }

  override dispose(): void {
    if (this.#d) return
    this.#d = true
    this.#a.abort(new DOMException('The Text instance was disposed', 'AbortError'))
    super.dispose()
    this.#h.remove()
  }
}
