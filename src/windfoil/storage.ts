import { StorageBufferAttribute, type BufferAttribute, type WebGPURenderer } from 'three/webgpu'
import { storage } from 'three/tsl'
import type { DomSdfOptions } from '../types.js'
import type { WindfoilStorage } from './WindfoilMaterial.js'
/** The text effects of `DomSdfOptions` that an SDF underlay draws for analytic text. */
export type TextEffects = Pick<DomSdfOptions, 'outline' | 'dropShadow'>
/**
 * The effects that draw anything, or null: an outline unless its width is zero or its opacity
 * at most zero, a drop shadow unless its opacity is at most zero. Values the SDF material
 * rejects, such as a negative width or a NaN, stay for it to reject.
 */
export function drawnEffects({ outline, dropShadow }: TextEffects): TextEffects | null {
  const drawn: TextEffects = {}
  if (outline && outline.width !== 0 && !((outline.opacity ?? 1) <= 0)) drawn.outline = outline
  if (dropShadow && !((dropShadow.opacity ?? 0.5) <= 0)) drawn.dropShadow = dropShadow
  return (drawn.outline ?? drawn.dropShadow) ? drawn : null
}
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted)
    throw signal.reason ?? new DOMException('The Windfoil build was aborted', 'AbortError')
}
export function abortable<T>(promise: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  throwIfAborted(signal)
  if (!signal) return Promise.resolve(promise)
  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', abort)
    const abort = (): void => {
      cleanup()
      // Caller-defined AbortSignal reasons propagate verbatim.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      reject(signal.reason ?? new DOMException('The Windfoil build was aborted', 'AbortError'))
    }
    signal.addEventListener('abort', abort, { once: true })
    void Promise.resolve(promise).then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        reject(error)
      },
    )
  })
}
export function disposeWindfoilStorage(renderer: WebGPURenderer, attribute: BufferAttribute): void {
  attribute.dispose()
  const backend = renderer.backend as unknown as {
    has(object: object): boolean
    destroyAttribute(attribute: BufferAttribute): void
  }
  if (backend.has(attribute)) {
    backend.destroyAttribute(attribute)
    renderer.info.destroyAttribute(attribute)
  }
}
export function createWindfoilStorage(
  renderer: WebGPURenderer,
  data: { curves: Float32Array; rows: Uint32Array },
): WindfoilStorage & { storageBytes: number; dispose(): void } {
  const attributes: StorageBufferAttribute[] = []
  let disposed = false
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    for (const attribute of attributes) disposeWindfoilStorage(renderer, attribute)
  }
  try {
    const curveAttribute = new StorageBufferAttribute(
      data.curves.length ? data.curves : new Float32Array(2),
      2,
    )
    attributes.push(curveAttribute)
    const rowAttribute = new StorageBufferAttribute(
      data.rows.length ? data.rows : new Uint32Array(1),
      1,
    )
    attributes.push(rowAttribute)
    return {
      storageBytes: data.curves.byteLength + data.rows.byteLength,
      curves: storage(curveAttribute, 'vec2', curveAttribute.count)
        .toReadOnly()
        .setName('ultraWindfoilCurves'),
      rows: storage(rowAttribute, 'uint', rowAttribute.count)
        .toReadOnly()
        .setName('ultraWindfoilRows'),
      dispose,
    }
  } catch (error) {
    dispose()
    throw error
  }
}
