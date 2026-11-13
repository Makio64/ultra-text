import {
  ACESFilmicToneMapping,
  BoxGeometry,
  Color,
  Mesh,
  MeshBasicNodeMaterial,
  Scene,
  Sprite,
  SpriteNodeMaterial,
  type BufferGeometry,
  type Camera,
  type Material,
  type Object3D,
  type Renderer,
  type RenderTarget,
  type Vector2,
} from 'three/webgpu'
import { vec4 } from 'three/tsl'

/** One mesh a pass drew: its own material, and the scene's override when it was drawn. */
export interface DrawnObject {
  name: string
  material: Material
  override: Material | null
}

/** What the scene and the renderer held for one render call. */
export interface RecordedPass {
  /** The scene rendered, or the full-screen quad (any other object). */
  subject: Object3D
  override: Material | null
  autoClear: boolean
  toneMapping: number
  background: unknown
  clear: string
  target: RenderTarget | null
  mrt: unknown
  /** Names of the visible objects, in traversal order; empty for a quad. */
  shown: string[]
  /** Each visible mesh as the render-object function drew it. */
  drawn: DrawnObject[]
}

type RenderObjectFunction = Parameters<Renderer['setRenderObjectFunction']>[0]

/**
 * A stand-in renderer for drawings that records every render call instead of drawing. A
 * scene's visible meshes go through the render-object function, as three's do, so a hook
 * that swaps the override per object is recorded too. `fail` throws from the first render.
 */
export function recordingRenderer(
  options: { fail?: boolean; buffer?: [number, number]; pixelRatio?: number } = {},
) {
  const passes: RecordedPass[] = []
  const clearColor = new Color(0x102030)
  let clearAlpha = 0
  let target: RenderTarget | null = null
  let mrt: unknown = null
  let hook: RenderObjectFunction = null
  const [bufferWidth, bufferHeight] = options.buffer ?? [800, 600]
  let drawn: DrawnObject[] = []
  const renderer = {
    autoClear: true,
    toneMapping: ACESFilmicToneMapping,
    getClearColor: (into: Color) => into.copy(clearColor),
    getClearAlpha: () => clearAlpha,
    setClearColor(color: Color | number, alpha: number) {
      clearColor.set(color)
      clearAlpha = alpha
    },
    getRenderTarget: () => target,
    setRenderTarget(next: RenderTarget | null) {
      target = next
    },
    getMRT: () => mrt,
    setMRT(next: unknown) {
      mrt = next
    },
    getRenderObjectFunction: () => hook,
    setRenderObjectFunction(next: RenderObjectFunction) {
      hook = next
    },
    getDrawingBufferSize: (into: Vector2) => into.set(bufferWidth, bufferHeight),
    getPixelRatio: () => options.pixelRatio ?? 1,
    renderObject: (
      object: Object3D,
      scene: Scene,
      _camera: Camera,
      _geometry: BufferGeometry,
      material: Material,
    ) => {
      drawn.push({ name: object.name, material, override: scene.overrideMaterial })
    },
    render(subject: Object3D, camera: Camera) {
      drawn = []
      const scene = subject as Scene
      const shown: string[] = []
      if (scene.isScene) {
        scene.traverseVisible((object) => {
          if (object.name) shown.push(object.name)
          const mesh = object as Partial<Mesh>
          if (!mesh.isMesh) return
          const draw = (hook ?? renderer.renderObject) as (...args: unknown[]) => void
          draw(object, scene, camera, mesh.geometry, mesh.material, null, null, null, null)
        })
      }
      passes.push({
        subject,
        override: scene.isScene ? scene.overrideMaterial : null,
        autoClear: renderer.autoClear,
        toneMapping: renderer.toneMapping,
        background: scene.isScene ? (scene.background ?? scene.backgroundNode) : null,
        clear: `${clearColor.getHexString()}/${String(clearAlpha)}`,
        target,
        mrt,
        shown,
        drawn,
      })
      if (options.fail) throw new Error('device lost')
    },
  }
  return { renderer, passes, clearColor, clearAlpha: () => clearAlpha }
}

/** The stand-in, as the drawings' parameter type. */
export function asRenderer(recording: ReturnType<typeof recordingRenderer>): Renderer {
  return recording.renderer as unknown as Renderer
}

/** A room with one mesh the drawings draw, and everything they must leave as it is. */
export function drawingRoom() {
  const scene = new Scene()
  scene.background = new Color(0x000000)
  const box = new BoxGeometry()
  const wall = new Mesh(box, new MeshBasicNodeMaterial())
  wall.name = 'wall'
  const sky = new Mesh(box, new MeshBasicNodeMaterial())
  sky.name = 'sky'
  sky.material.vertexNode = vec4(0, 0, 0, 1)
  const own = new Mesh(box, new MeshBasicNodeMaterial())
  own.name = 'own'
  own.material.allowOverride = false
  const critters = new Mesh(box, new MeshBasicNodeMaterial())
  critters.name = 'critters'
  critters.userData['wireframe'] = false
  const sprite = new Sprite(new SpriteNodeMaterial())
  sprite.name = 'sprite'
  const off = new Mesh(box, new MeshBasicNodeMaterial())
  off.name = 'off'
  off.visible = false
  scene.add(wall, sky, own, critters, sprite, off)
  return { scene, objects: [wall, sky, own, critters, sprite, off] }
}
