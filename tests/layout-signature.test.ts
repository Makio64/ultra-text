import { describe, expect, it } from 'vitest'

import { layoutSignatureOf } from '../src/dom/layoutSignature.js'
import type { DomLayoutSnapshot } from '../src/types.js'

const snapshot: DomLayoutSnapshot = {
  width: 240,
  height: 120,
  glyphs: [
    {
      glyphKey: 'face\u0000A',
      fontSize: 16,
      originX: 12,
      lineBottom: 80,
      advance: 8,
      block: 0,
      breakBefore: 'none',
      clip: [0, 0, 240, 120],
      color: [0.5, 0.5, 0.5, 1],
      sequence: 0,
      z: 1,
    },
  ],
  rects: [{ rect: [0, 0, 240, 120], color: [1, 1, 1, 1], radius: 8, z: -1, receiveShadow: true }],
  blocks: [{ left: 12, firstBaseline: 80, linePitch: 20, width: 216, clip: [0, 0, 240, 120] }],
  requests: [],
  atlasSignature: 'face\u0000A',
  lineCount: 1,
}

// Exercise every scalar in the public capture contract, including tuple entries
// and reflow-only fields that do not affect the currently rendered geometry.
function mutations(value: unknown): unknown[] {
  if (typeof value === 'number') return [value + 0.125]
  if (typeof value === 'string') return [`${value}\u0000`]
  if (typeof value === 'boolean') return [!value]
  if (Array.isArray(value)) {
    return value.flatMap((item: unknown, index: number) =>
      mutations(item).map((changed) => {
        const copy = [...(value as unknown[])]
        copy[index] = changed
        return copy
      }),
    )
  }
  const record = value as Record<string, unknown>
  return Object.entries(record).flatMap(([key, item]) =>
    mutations(item).map((changed) => ({ ...record, [key]: changed })),
  )
}

describe('layoutSignatureOf', () => {
  it('distinguishes repeated string patterns and refreshes its dictionary on every call', () => {
    const capture = (keys: string[]): DomLayoutSnapshot => ({
      ...snapshot,
      glyphs: keys.map((glyphKey) => ({ ...snapshot.glyphs[0]!, glyphKey })),
    })
    const captures = [
      ['ab', 'ab', 'c', 'ab'],
      ['ab', 'c', 'ab', 'ab'],
      ['a', 'a', 'bc', 'a'],
      ['ab', 'ab', 'c', ''],
      ['', '', 'c', ''],
    ].map(capture)
    const signatures = captures.map(layoutSignatureOf)
    expect(new Set(signatures).size).toBe(captures.length)
    for (let index = captures.length - 1; index >= 0; index--) {
      expect(layoutSignatureOf(structuredClone(captures[index]!))).toBe(signatures[index])
    }
  })

  it('invalidates optional shaping, decoration and reflow fields', () => {
    const extended: DomLayoutSnapshot = {
      ...snapshot,
      textShaping: 'browser',
      glyphs: [
        {
          ...snapshot.glyphs[0]!,
          baselineOffset: 2,
          motionOrigin: [10, 20, 0],
          gapBefore: 0,
          decorationWidth: 8,
          decorations: [{ line: 'underline', color: [1, 0, 0, 1], thickness: 1, offset: 2 }],
        },
      ],
      blocks: [{ ...snapshot.blocks[0]!, direction: 'rtl' }],
    }
    const signature = layoutSignatureOf(extended)
    for (const changed of mutations(extended)) {
      expect(layoutSignatureOf(changed as DomLayoutSnapshot)).not.toBe(signature)
    }
  })

  it('recognizes identical separately allocated captures and normalizes signed zero', () => {
    const copy = structuredClone(snapshot)
    Object.setPrototypeOf(copy.glyphs[0]!, { unrelated: 42 })
    expect(layoutSignatureOf(copy)).toBe(layoutSignatureOf(snapshot))
    expect(layoutSignatureOf({ ...snapshot, width: -0 })).toBe(
      layoutSignatureOf({ ...snapshot, width: 0 }),
    )
  })

  it('invalidates every glyph, rectangle, block and capture field', () => {
    const signature = layoutSignatureOf(snapshot)
    for (const changed of mutations(snapshot)) {
      expect(layoutSignatureOf(changed as DomLayoutSnapshot)).not.toBe(signature)
    }
  })

  it('preserves double precision, glyph order and string boundaries', () => {
    expect(layoutSignatureOf({ ...snapshot, width: 240 + 1e-10 })).not.toBe(
      layoutSignatureOf(snapshot),
    )
    const glyph = snapshot.glyphs[0]!
    const capture = (keys: string[]): DomLayoutSnapshot => ({
      ...snapshot,
      glyphs: keys.map((glyphKey) => ({ ...glyph, glyphKey })),
    })
    const signatures = [
      capture(['ab', 'c']),
      capture(['a', 'bc']),
      capture(['c', 'ab']),
      capture(['abc']),
      { ...snapshot, glyphs: [] },
      snapshot,
    ].map(layoutSignatureOf)
    expect(new Set(signatures).size).toBe(signatures.length)
  })
})
