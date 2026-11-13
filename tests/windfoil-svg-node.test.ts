// @vitest-environment node
import { expect, it } from 'vitest'
import { svgToWindfoilOutlines } from '../src/windfoil/svg/convert.js'
import { windfoilOutlineFromSvgPaths } from '../src/windfoil/svg/pathConverter.js'
import { preprocessWindfoilOutlines } from '../src/windfoil/preprocess.js'
it('converts path records with no DOM globals and rejects markup with a useful error', () => {
  expect(globalThis.DOMParser).toBeUndefined()
  const source = { d: 'M0 0H10V10H0Z', fill: '#f80' }
  const converted = windfoilOutlineFromSvgPaths(source)
  expect(svgToWindfoilOutlines(source)).toEqual(converted)
  expect(
    preprocessWindfoilOutlines([{ key: 'box', outline: converted.outline }]).stats.uniqueGlyphs,
  ).toBe(1)
  expect(() => svgToWindfoilOutlines('<svg/>')).toThrow('pass DOM-free path records')
})
