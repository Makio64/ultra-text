import { describe, expect, it } from 'vitest'
import { parsePathData } from '../src/windfoil/svg/pathData.js'

describe('SVG path grammar', () => {
  it('reads compact decimals, signs, exponents, implicit lines and relative commands', () => {
    const result = parsePathData('M1.5.5 1e1-20m-.5-.5h5v10l-1 2z m2 3L0 0')
    expect(result.error).toBeUndefined()
    expect(result.segments.slice(0, 3)).toEqual([
      { type: 'move', x: 1.5, y: 0.5 },
      { type: 'line', x: 10, y: -20 },
      { type: 'move', x: 9.5, y: -20.5 },
    ])
    expect(result.segments.at(-2)).toEqual({ type: 'move', x: 11.5, y: -17.5 })
  })
  it('reflects only matching preceding curve controls', () => {
    const result = parsePathData('M0 0Q1 2 3 4T5 6L7 8T9 10C1 2 3 4 5 6S7 8 9 10L0 0S1 2 3 4')
    expect(result.error).toBeUndefined()
    expect(result.segments[2]).toEqual({ type: 'quad', x1: 5, y1: 6, x: 5, y: 6 })
    expect(result.segments[4]).toEqual({ type: 'quad', x1: 7, y1: 8, x: 9, y: 10 })
    expect(result.segments[6]).toEqual({ type: 'cubic', x1: 7, y1: 8, x2: 7, y2: 8, x: 9, y: 10 })
    expect(result.segments[8]).toEqual({ type: 'cubic', x1: 0, y1: 0, x2: 1, y2: 2, x: 3, y: 4 })
  })
  it('accepts compact and separated arc flags', () => {
    expect(parsePathData('M0 0a1 1 0 00 1 1a1,1,0,1,1,5,5').error).toBeUndefined()
    expect(parsePathData('M0 0A1 1 0 2 0 1 1').error).toBeDefined()
  })
  it.each(['M0 0L1e 2', 'M0 0L2', 'M0 0L,1,,2', 'M0 0R1 2', 'L0 0', 'M0 0z1 2', 'M0 0L1e999 2'])(
    'keeps a valid prefix for %s',
    (d) => {
      const result = parsePathData(d)
      expect(result.error).toBeDefined()
      expect(result.segments.every((s) => s.type === 'move' || s.type === 'close')).toBe(true)
    },
  )
  it('resumes at the subpath start after close', () => {
    expect(parsePathData('M2 3l2 3z l4 5').segments.at(-1)).toEqual({ type: 'line', x: 6, y: 8 })
  })
})
