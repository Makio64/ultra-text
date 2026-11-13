import { alphaOfRgba, encodeSdfFromAlpha } from './cpuSdf.js'

const scope = globalThis as unknown as {
  onmessage: (
    event: MessageEvent<{
      rgba: Uint8ClampedArray
      width: number
      height: number
      pxRange: number
    }>,
  ) => void
  postMessage: (value: Uint8Array, transfer: ArrayBuffer[]) => void
}

// The page reads the canvas and sends the RGBA pixels: the alpha loop runs here.
scope.onmessage = ({ data }) => {
  const alpha = alphaOfRgba(data.rgba, data.width * data.height)
  const result = encodeSdfFromAlpha(alpha, data.width, data.height, data.pxRange)
  scope.postMessage(result, [result.buffer as ArrayBuffer])
}
