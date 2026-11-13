import { WebGPUBackend, type BufferAttribute, type WebGPURenderer } from 'three/webgpu'
import type * as ThreeTsl from 'three/tsl'
import { describe, expect, it, vi } from 'vitest'
const failures = vi.hoisted(() => ({ after: Infinity, calls: 0 }))
vi.mock('three/tsl', async (importOriginal) => {
  const actual = await importOriginal<typeof ThreeTsl>()
  const storage: typeof actual.storage = (...args: Parameters<typeof actual.storage>) => {
    if (++failures.calls === failures.after) throw new Error('storage failure')
    return actual.storage(...args)
  }
  return { ...actual, storage }
})
import { abortable, createWindfoilStorage } from '../src/windfoil/storage.js'
describe('Windfoil storage transactions', () => {
  it('releases partial storage when node creation fails', () => {
    const destroyAttribute = vi.fn<(attribute: BufferAttribute) => void>(),
      renderer = {
        backend: Object.assign(Object.create(WebGPUBackend.prototype) as object, {
          has: () => true,
          destroyAttribute,
        }),
        info: { destroyAttribute: vi.fn() },
      } as unknown as WebGPURenderer
    failures.calls = 0
    failures.after = 2
    expect(() =>
      createWindfoilStorage(renderer, { curves: new Float32Array(2), rows: new Uint32Array(1) }),
    ).toThrow('storage failure')
    expect(destroyAttribute).toHaveBeenCalledTimes(2)
    failures.after = Infinity
  })
  it('preserves rejection reasons and abort listeners are removed on completion', async () => {
    const controller = new AbortController(),
      remove = vi.spyOn(controller.signal, 'removeEventListener')
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    await expect(abortable(Promise.reject('provider failure'), controller.signal)).rejects.toBe(
      'provider failure',
    )
    expect(remove).toHaveBeenCalledOnce()
    await expect(abortable(Promise.resolve(42), controller.signal)).resolves.toBe(42)
    expect(remove).toHaveBeenCalledTimes(2)
    const abort = new AbortController(),
      promise = abortable(new Promise(() => undefined), abort.signal)
    abort.abort()
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
  })
})
