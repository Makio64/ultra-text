import {
  FrontSide,
  LightingModel,
  MeshBasicNodeMaterial,
  NodeMaterial,
  type LightingModelDirectInput,
  type Node,
  type NodeBuilder,
  type UniformNode,
} from 'three/webgpu'
import {
  Fn,
  abs,
  attribute,
  diffuseColor,
  float,
  fwidth,
  length,
  max,
  min,
  mix,
  positionGeometry,
  smoothstep,
  uniform,
  varyingProperty,
  vec3,
  vec4,
} from 'three/tsl'

import { srgbAttributeToWorking } from './GlyphTextMaterial.js'

class CssShadowLightingModel extends LightingModel {
  readonly v = float(1).toVar('ultraSdfShadowVisibility')

  constructor(readonly f: Node<'float'>) {
    super()
  }

  override direct({ lightNode }: LightingModelDirectInput): void {
    const shadowNode = (
      lightNode as unknown as {
        readonly shadowNode: Node<'float'> | null
      }
    ).shadowNode
    if (shadowNode) this.v.mulAssign(shadowNode)
  }

  override finish(builder: NodeBuilder): void {
    const { outgoingLight } = builder.context as {
      readonly outgoingLight: Node<'vec3'>
    }
    outgoingLight.assign(diffuseColor.rgb.mul(mix(this.f, float(1), this.v)))
  }
}

class CssShadowNodeMaterial extends NodeMaterial {
  readonly shadowFloor: UniformNode<'float', number>

  // Defaulted so `Material.clone()` — which constructs with no arguments before copying —
  // gets a real number instead of clamping `undefined` into NaN.
  constructor(shadowFloor = 0.24) {
    super()
    this.lights = true
    this.shadowFloor = uniform(Math.min(1, Math.max(0, shadowFloor)))
  }

  // The uniform is this class's own state; the base copy only knows node properties.
  override copy(source: this): this {
    super.copy(source)
    this.shadowFloor.value = source.shadowFloor.value
    return this
  }

  override setupOutgoingLight(): Node<'vec3'> {
    return diffuseColor.rgb
  }

  override setupLightingModel(): LightingModel {
    return new CssShadowLightingModel(this.shadowFloor)
  }
}

/**
 * Instanced rounded-rectangle material for copied DOM backgrounds. `lit`
 * receivers darken to `shadowFloor` where the shadow map covers them; unlit
 * rectangles reproduce their CSS colour exactly.
 */
export function createRectMaterial(lit: boolean, shadowFloor = 0.24): NodeMaterial {
  const material = lit ? new CssShadowNodeMaterial(shadowFloor) : new MeshBasicNodeMaterial()
  material.name = lit ? 'ultra-text TSL rounded shadow receiver' : 'ultra-text TSL rounded DOM rect'
  // Unlit rects keep their CSS colour, so the scene's lights stay out of their shader.
  material.lights = lit
  material.transparent = true
  material.depthWrite = true
  material.depthTest = true
  material.side = FrontSide
  // A flat rect shows one face at a time: set DoubleSide, it draws once without culling
  // instead of a back pass and a front pass.
  material.forceSinglePass = true
  material.toneMapped = false

  const rect = attribute<'vec4'>('sdfRect', 'vec4')
  const color = attribute<'vec4'>('sdfColor', 'vec4')
  const radius = attribute<'float'>('sdfRadius', 'float')
  const z = attribute<'float'>('sdfZ', 'float')
  const localUv = varyingProperty('vec2', 'vUltraRectUv')
  const sizeVarying = varyingProperty('vec2', 'vUltraRectSize')
  const colorVarying = varyingProperty('vec4', 'vUltraRectColor')
  const radiusVarying = varyingProperty('float', 'vUltraRectRadius')

  material.positionNode = Fn<Node<'vec3'>>((): Node<'vec3'> => {
    const quad = positionGeometry.xy
    const size = rect.zw.sub(rect.xy).toConst()
    const halfSize = size.mul(0.5).toConst()
    const linearRgb = srgbAttributeToWorking(vec3(color.rgb)).toConst()
    const clampedRadius = min(radius, min(halfSize.x, halfSize.y)).toConst()
    localUv.assign(quad.sub(0.5).mul(size))
    sizeVarying.assign(halfSize.sub(clampedRadius))
    colorVarying.assign(vec4(linearRgb, color.a))
    radiusVarying.assign(clampedRadius)
    const transformed = rect.xy.add(size.mul(quad))
    return vec3(transformed, z)
  })()

  const point = abs(localUv).sub(sizeVarying).toConst()
  const outside = length(point.max(0))
  const inside = min(max(point.x, point.y), 0)
  const distance = outside.add(inside).sub(radiusVarying).toConst()
  const antialias = max(fwidth(distance), 1e-4).toConst()
  const coverage = smoothstep(antialias, antialias.negate(), distance)
  const alpha = colorVarying.a.mul(coverage)
  material.colorNode = vec4(colorVarying.rgb, alpha)
  material.maskNode = alpha.greaterThan(0.001)
  material.maskShadowNode = coverage.greaterThan(0.5).and(colorVarying.a.greaterThan(0.5))

  return material
}
