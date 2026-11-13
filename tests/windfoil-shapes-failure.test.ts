import {
  InstancedBufferGeometry,
  StorageBufferAttribute,
  WebGPUBackend,
  type WebGPURenderer,
} from 'three/webgpu'
import { expect, it, vi } from 'vitest'
vi.mock('../src/windfoil/WindfoilMaterial.js', () => ({
  // A failing constructor is the failure boundary under test.
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  WindfoilMaterial: class {
    constructor() {
      throw new Error('material construction failed')
    }
  },
}))
import { buildWindfoilShapes } from '../src/windfoil/shapes.js'
import { windfoilOutlineFromSvgPaths } from '../src/windfoil/svg/pathConverter.js'
it('releases geometry and both storage attributes if material construction fails', async () => {
  const geometry = vi.spyOn(InstancedBufferGeometry.prototype, 'dispose')
  const storage = vi.spyOn(StorageBufferAttribute.prototype, 'dispose')
  const renderer = {
    init: () => Promise.resolve(),
    backend: Object.assign(Object.create(WebGPUBackend.prototype) as object, { has: () => false }),
  } as unknown as WebGPURenderer
  const outline = windfoilOutlineFromSvgPaths({ d: 'M0 0H1V1H0Z' }).outline
  await expect(
    buildWindfoilShapes(renderer, { box: outline }, [{ shape: 'box', x: 0, y: 0, size: 10 }]),
  ).rejects.toThrow('material construction failed')
  expect(geometry).toHaveBeenCalledOnce()
  expect(storage).toHaveBeenCalledTimes(2)
})
