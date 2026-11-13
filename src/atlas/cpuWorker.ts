/**
 * One short-lived worker per bake: termination also cancels a synchronous EDT. The canvas's
 * RGBA pixels are transferred, so the caller no longer owns them; the worker takes their alpha.
 */
export function encodeInWorker(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  pxRange: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./cpuSdf.worker.js', import.meta.url), { type: 'module' })
    let settled = false
    const finish = (error?: unknown, result?: Uint8Array): void => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', abort)
      worker.terminate()
      if (result) resolve(result)
      // AbortSignal.reason is caller-owned and can be any value.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      else reject(error)
    }
    const abort = (): void => finish(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true })
    worker.onmessage = (event: MessageEvent<unknown>) => {
      const result = event.data
      if (!(result instanceof Uint8Array) || result.length !== width * height) {
        finish(new Error('Invalid CPU SDF worker result'))
      } else finish(undefined, result)
    }
    worker.onerror = (event) => {
      event.preventDefault()
      finish(new Error(event.message || 'CPU SDF worker failed'))
    }
    worker.onmessageerror = () => finish(new Error('CPU SDF worker transfer failed'))
    try {
      worker.postMessage({ rgba, width, height, pxRange }, [rgba.buffer as ArrayBuffer])
    } catch (error) {
      finish(error)
    }
  })
}
