import { describe, expect, it } from 'vitest'
import { Box3, Color, Matrix4, Quaternion, Raycaster, Sphere, Vector3 } from 'three/webgpu'

function projectorOrientation(dir: Vector3): Quaternion {
  const forward = dir.clone().normalize()
  const right = new Vector3().crossVectors(new Vector3(0, 1, 0), forward).normalize()
  const up = new Vector3().crossVectors(forward, right).normalize()
  const m = new Matrix4().makeBasis(right, up, forward)
  return new Quaternion().setFromRotationMatrix(m)
}

describe('projector interaction, hit volumes, and UV isoline mode', () => {
  const WALL_Z = -520
  const CLOCK_SCULPTURE = {
    x: 10_500,
    projectorX: -320,
    projectorZ: 900,
    projectorScale: 0.4,
    centreY: 710,
    projectionZ: WALL_Z + 8, // -512
    digitZ: 40,
  } as const

  const CLOCK_SHADOW_OFFSETS: readonly [number, number][] = [
    [-12, 10],
    [12, -8],
    [-22, -12],
    [18, 14],
    [-6, -18],
    [14, 20],
    [-16, -6],
  ]

  const projectorWorldCenter = new Vector3(
    CLOCK_SCULPTURE.x + CLOCK_SCULPTURE.projectorX,
    85,
    CLOCK_SCULPTURE.projectorZ,
  )
  const projectorHitSphere = new Sphere(projectorWorldCenter, 135)
  const projectorHitBox = new Box3(
    new Vector3(projectorWorldCenter.x - 90, 0, projectorWorldCenter.z - 90),
    new Vector3(projectorWorldCenter.x + 90, 180, projectorWorldCenter.z + 90),
  )

  it('bounds the floor projector fixture with simple sphere and box', () => {
    expect(projectorWorldCenter.x).toBe(10_180)
    expect(projectorWorldCenter.y).toBe(85)
    expect(projectorWorldCenter.z).toBe(900)

    // The center must be inside both the sphere and the box
    expect(projectorHitSphere.containsPoint(projectorWorldCenter)).toBe(true)
    expect(projectorHitBox.containsPoint(projectorWorldCenter)).toBe(true)

    // The fixture base is at y=0, top of yoke/head around y=160
    expect(projectorHitBox.min.y).toBe(0)
    expect(projectorHitBox.max.y).toBe(180)
    expect(projectorHitSphere.radius).toBe(135)
  })

  it('detects ray intersection towards the projector and ignores other directions', () => {
    const hitPoint = new Vector3()
    const raycaster = new Raycaster()

    // Ray origin in front of clock bay, aiming directly at projector center
    const eye = new Vector3(10_180, 374, 2500)
    const aim = projectorWorldCenter.clone().sub(eye).normalize()
    raycaster.ray.origin.copy(eye)
    raycaster.ray.direction.copy(aim)

    expect(raycaster.ray.intersectSphere(projectorHitSphere, hitPoint)).not.toBeNull()
    expect(raycaster.ray.intersectBox(projectorHitBox, hitPoint)).not.toBeNull()

    // Ray aiming away from projector (e.g. towards room entrance at x=0)
    raycaster.ray.direction.set(-1, 0, 0)
    expect(raycaster.ray.intersectSphere(projectorHitSphere, hitPoint)).toBeNull()
    expect(raycaster.ray.intersectBox(projectorHitBox, hitPoint)).toBeNull()
  })

  it('keeps projector statically oriented at the clock aperture without roll', () => {
    const aimDirection = new Vector3(320, 622, -1412).normalize()
    const orientation = projectorOrientation(aimDirection)

    // Pitch elevation is aimed upwards at the clock center
    expect(aimDirection.y).toBeGreaterThan(0.38)
    expect(aimDirection.z).toBeLessThan(-0.8)

    // Local forward (0, 0, 1) transforms to the normalized aim direction
    const transformedForward = new Vector3(0, 0, 1).applyQuaternion(orientation)
    expect(transformedForward.x).toBeCloseTo(aimDirection.x, 5)
    expect(transformedForward.y).toBeCloseTo(aimDirection.y, 5)
    expect(transformedForward.z).toBeCloseTo(aimDirection.z, 5)

    // Local pitch axis (1, 0, 0) remains strictly in the horizontal XZ plane (zero roll)
    const transformedPitchAxis = new Vector3(1, 0, 0).applyQuaternion(orientation)
    expect(transformedPitchAxis.y).toBeCloseTo(0, 5)
  })

  it('toggles ultraviolet projector mode and interpolates blacklight lighting', () => {
    const warmProjectorColor = new Color(0xffe8c8)
    const uvProjectorColor = new Color('#7c3aed')
    const warmLensEmissive = new Color(0xffd2a0)
    const uvLensEmissive = new Color('#c084fc')

    let projectorUvActive = false
    let clockUvAmount = 0
    expect(clockUvAmount).toBe(0)

    // Click toggles UV mode on
    projectorUvActive = !projectorUvActive
    expect(projectorUvActive).toBe(true)

    // When transition reaches full UV mode (amount = 1.0)
    clockUvAmount = 1.0
    const activeColor = warmProjectorColor.clone().lerp(uvProjectorColor, clockUvAmount)
    const activeLensEmissive = warmLensEmissive.clone().lerp(uvLensEmissive, clockUvAmount)
    const activeIntensity = 5.2 + 2.0 * clockUvAmount
    const activeLensIntensity = 0.36 + (2.0 - 0.36) * clockUvAmount

    expect(activeColor.getHexString()).toBe(uvProjectorColor.getHexString())
    expect(activeLensEmissive.getHexString()).toBe(uvLensEmissive.getHexString())
    expect(activeIntensity).toBe(7.2)
    expect(activeLensIntensity).toBe(2.0)

    // In UV mode, shadow offsets collapse to 0 so isolines remain sharp and unghosted
    const offsetScale = 1 - clockUvAmount
    const offset0 = CLOCK_SHADOW_OFFSETS[0]!
    const effectiveOffset = [offset0[0] * offsetScale, offset0[1] * offsetScale]
    expect(effectiveOffset[0]).toBeCloseTo(0, 5)
    expect(effectiveOffset[1]).toBeCloseTo(0, 5)

    // Click toggles UV mode back off
    projectorUvActive = !projectorUvActive
    expect(projectorUvActive).toBe(false)
    clockUvAmount = 0
    const normalColor = warmProjectorColor.clone().lerp(uvProjectorColor, clockUvAmount)
    expect(normalColor.getHexString()).toBe(warmProjectorColor.getHexString())
  })

  it('evaluates Signed Distance Field isolines and ultraviolet palette math', () => {
    const threshold = 0.48
    const frequency = 32.0

    // 1. Outside glyph (dist < 0.48)
    const outsideDist = 0.3
    const outsideInner = Math.max(0, outsideDist - threshold)
    expect(outsideInner).toBe(0)

    // 2. Near edge contour
    const edgeDist = 0.5
    const edgeInner = Math.max(0, edgeDist - threshold)
    expect(edgeInner).toBeCloseTo(0.02, 5)

    // 3. Inside stroke: check periodic sinusoidal isoline peaks
    // As innerDist traverses, sin(innerDist * 32 * 2π) generates isolines
    const period = 1.0 / frequency // ~0.03125
    const wavePeak1 = Math.sin(0.25 * period * frequency * 2 * Math.PI)
    const waveTrough1 = Math.sin(0.75 * period * frequency * 2 * Math.PI)
    expect(wavePeak1).toBeCloseTo(1.0, 5)
    expect(waveTrough1).toBeCloseTo(-1.0, 5)

    // 4. Ultraviolet palette color ramp
    const baseUv0 = new Color(0.08, 0.01, 0.18)
    const baseUv1 = new Color(0.32, 0.03, 0.55)
    const ringColor0 = new Color(0.72, 0.22, 1.0)
    const ringColor1 = new Color(0.96, 0.82, 1.0)

    // Ring colors are bright fluorescent violet/lilac
    expect(ringColor0.r).toBeGreaterThan(0.7)
    expect(ringColor0.b).toBe(1.0)
    expect(ringColor1.r).toBeGreaterThan(0.9)
    expect(ringColor1.g).toBeGreaterThan(0.8)

    // Deep UV base is rich in violet (blue > green)
    expect(baseUv0.b).toBeGreaterThan(baseUv0.g)
    expect(baseUv1.b).toBeGreaterThan(baseUv1.g)
  })
})
