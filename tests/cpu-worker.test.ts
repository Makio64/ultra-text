import type { DataTexture } from 'three/webgpu'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildCpuSdfAtlas } from '../src/atlas/cpuAtlas.js'
import { alphaOfRgba, encodeSdfFromAlpha } from '../src/atlas/cpuSdf.js'
import { encodeInWorker } from '../src/atlas/cpuWorker.js'
import type { RasterAtlas } from '../src/types.js'

class FakeWorker {
  static latest: FakeWorker
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: (() => void) | null = null
  terminate = vi.fn()
  postMessage = vi.fn((data: unknown, transfer: Transferable[]) => {
    // Actually detach the input, so fallback tests exercise the browser's ownership rule.
    structuredClone(data, { transfer })
  })
  constructor() {
    FakeWorker.latest = this
  }
}

/** RGBA pixels whose alpha is `alpha`, as getImageData returns them. */
function pixels(alpha: readonly number[]): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(alpha.length * 4)
  for (const [index, value] of alpha.entries()) rgba.set([96, 96, 96, value], index * 4)
  return rgba
}

function raster(): RasterAtlas {
  const canvas = document.createElement('canvas')
  const data = pixels([0, 0, 255, 0, 0])
  vi.spyOn(canvas, 'getContext').mockReturnValue({
    // A fresh copy per read, as a browser returns.
    getImageData: () => ({ data: data.slice() }),
  } as unknown as CanvasRenderingContext2D)
  return { canvas, width: 5, height: 1, bakeSize: 32, pxRange: 4, glyphs: new Map() }
}

afterEach(() => vi.unstubAllGlobals())

describe('CPU worker baking', () => {
  it('transfers the pixels and terminates after a valid result', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const input = pixels([0, 255, 0])
    const expected = encodeSdfFromAlpha(new Uint8Array([0, 255, 0]), 3, 1, 4)
    const promise = encodeInWorker(input, 3, 1, 4)
    const worker = FakeWorker.latest
    expect(worker.postMessage.mock.calls[0]![0]).toMatchObject({ width: 3, height: 1, pxRange: 4 })
    expect(input.byteLength).toBe(0)
    worker.onmessage!(new MessageEvent('message', { data: expected }))
    await expect(promise).resolves.toEqual(expected)
    expect(worker.terminate).toHaveBeenCalledOnce()
  })

  it('terminates running work and preserves the exact abort reason', async () => {
    vi.stubGlobal('Worker', FakeWorker)
    const controller = new AbortController()
    const promise = encodeInWorker(pixels([0, 0, 0]), 3, 1, 4, controller.signal)
    const reason = new DOMException('superseded', 'AbortError')
    controller.abort(reason)
    await expect(promise).rejects.toBe(reason)
    expect(FakeWorker.latest.terminate).toHaveBeenCalledOnce()
    expect(() => encodeInWorker(pixels([0, 0, 0]), 3, 1, 4, controller.signal)).toThrow(reason)
  })

  it.each(['error', 'messageerror', 'invalid-result', 'postMessage'] as const)(
    'cleans up on %s',
    async (failure) => {
      vi.stubGlobal('Worker', FakeWorker)
      if (failure === 'postMessage') {
        vi.stubGlobal(
          'Worker',
          class extends FakeWorker {
            override postMessage = vi.fn(() => {
              throw new Error('transfer')
            })
          },
        )
      }
      const promise = encodeInWorker(pixels([0, 0, 0]), 3, 1, 4)
      const worker = FakeWorker.latest
      if (failure === 'error') worker.onerror!(new ErrorEvent('error', { message: 'load failed' }))
      if (failure === 'messageerror') worker.onmessageerror!()
      if (failure === 'invalid-result')
        worker.onmessage!(new MessageEvent('message', { data: new Uint8Array(1) }))
      await expect(promise).rejects.toBeInstanceOf(Error)
      expect(worker.terminate).toHaveBeenCalledOnce()
    },
  )

  it('recaptures detached pixels and falls back if the worker fails', async () => {
    vi.stubGlobal(
      'Worker',
      class extends FakeWorker {
        override postMessage = vi.fn((data: unknown, transfer: Transferable[]) => {
          structuredClone(data, { transfer })
          queueMicrotask(() => this.onerror!(new ErrorEvent('error', { message: 'blocked' })))
        })
      },
    )
    const source = raster()
    const atlas = await buildCpuSdfAtlas(source)
    expect([...((atlas.texture as DataTexture).image.data as Uint8Array)]).toEqual([
      ...encodeSdfFromAlpha(new Uint8Array([0, 0, 255, 0, 0]), 5, 1, 4),
    ])
    expect(vi.mocked(source.canvas).getContext.mock.calls).toHaveLength(2)
    expect(FakeWorker.latest.terminate).toHaveBeenCalledOnce()
    atlas.dispose()
  })

  it('reuses still-attached pixels when the worker cannot start', async () => {
    vi.stubGlobal(
      'Worker',
      vi.fn(function () {
        throw new Error('CSP')
      }),
    )
    const source = raster()
    const atlas = await buildCpuSdfAtlas(source)
    expect([...((atlas.texture as DataTexture).image.data as Uint8Array)]).toEqual([
      ...encodeSdfFromAlpha(new Uint8Array([0, 0, 255, 0, 0]), 5, 1, 4),
    ])
    expect(vi.mocked(source.canvas).getContext.mock.calls).toHaveLength(1)
    atlas.dispose()
  })

  it('can explicitly skip workers and survives a blocked worker constructor', async () => {
    const Worker = vi.fn(function () {
      throw new Error('CSP')
    })
    vi.stubGlobal('Worker', Worker)
    const first = await buildCpuSdfAtlas(raster(), { cpuWorker: false })
    expect(Worker).not.toHaveBeenCalled()
    const second = await buildCpuSdfAtlas(raster())
    expect(Worker).toHaveBeenCalledOnce()
    first.dispose()
    second.dispose()
  })

  it('does not fall back to synchronous work after cancellation', async () => {
    const controller = new AbortController()
    vi.stubGlobal(
      'Worker',
      class extends FakeWorker {
        override postMessage = vi.fn(() =>
          controller.abort(new DOMException('cancelled', 'AbortError')),
        )
      },
    )
    const source = raster()
    await expect(buildCpuSdfAtlas(source, { signal: controller.signal })).rejects.toThrow(
      'cancelled',
    )
    expect(vi.mocked(source.canvas).getContext.mock.calls).toHaveLength(1)
    expect(FakeWorker.latest.terminate).toHaveBeenCalledOnce()
  })
})

describe('the CPU SDF worker module', () => {
  it('encodes the alpha of the pixels it is sent, exactly as the page would', async () => {
    const posted: { value: Uint8Array; transfer: ArrayBuffer[] }[] = []
    vi.stubGlobal('onmessage', null)
    vi.stubGlobal('postMessage', (value: Uint8Array, transfer: ArrayBuffer[]) =>
      posted.push({ value, transfer }),
    )
    vi.resetModules()
    await import('../src/atlas/cpuSdf.worker.js')
    const handler = (globalThis as unknown as { onmessage: (event: object) => void }).onmessage
    // Antialiased coverage on every channel, so only alpha may count.
    let seed = 41
    const width = 37
    const height = 23
    const rgba = Uint8ClampedArray.from({ length: width * height * 4 }, () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed >>> 24
    })
    const expected = encodeSdfFromAlpha(alphaOfRgba(rgba, width * height), width, height, 6)
    handler({ data: { rgba, width, height, pxRange: 6 } })
    expect(posted).toHaveLength(1)
    expect([...posted[0]!.value]).toEqual([...expected])
    expect(posted[0]!.transfer).toEqual([posted[0]!.value.buffer])
  })
})
