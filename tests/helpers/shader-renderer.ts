import type { Renderer } from 'three/webgpu'

/** Three's bind-group manager; the package root does not export it. */
const bindingsModule = 'three/src/renderers/common/Bindings.js'
const { default: Bindings } = (await import(/* @vite-ignore */ bindingsModule)) as {
  default: new (
    backend: { renderer: Renderer },
    nodes: null,
    textures: null,
    attributes: null,
    pipelines: object,
    info: Renderer['info'],
  ) => object
}

/**
 * Readies a renderer that never ran `init()` for WGSL/GLSL generation through a node builder.
 *
 * three r187 (mrdoob/three.js#34707) moved the shared bind-group cache into the renderer's
 * `Bindings`, which only `init()` creates: the constructor leaves `renderer._bindings` null, and
 * `NodeBuilder._getBindGroup` dereferences it for every shared uniform group (`renderGroup`,
 * `frameGroup`), so building on an uninitialised renderer throws. This gives the renderer the
 * `Bindings` that `init()` would, wired to the renderer instead of a device, so the builder runs
 * three's own shared-group path: it sorts each group's uniforms by node id, which fixes their
 * order in the generated struct, as in a running app. Only bind-group bookkeeping is involved,
 * so nothing here can draw; `init()` would replace it, and `dispose()` skips it.
 */
export function readyForShaderGeneration<T extends Renderer>(renderer: T): T {
  const internals = renderer as unknown as { _bindings: object | null }
  internals._bindings ??= new Bindings({ renderer }, null, null, null, {}, renderer.info)
  return renderer
}
