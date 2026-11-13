// @vitest-environment node
/// <reference types="node" />
import { readFileSync } from 'node:fs'

import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import * as api from '../src/index.js'

// These two lists are the public API surface documented in the README. When a
// failure brings you here, update the list and the README together,
// deliberately — renames and removals are breaking changes for consumers.
const runtimeExports = [
  'DomSdf',
  'DomText',
  'SdfTextMaterial',
  'Text',
  'buildSdfAtlas',
  'collectDomSnapshot',
  'createGlyphGeometry',
  'createRectGeometry',
  'createRectMaterial',
  'createSvgEmojiOutlineProvider',
  'createWindfoilShapes',
  'rasterizeGlyphAtlas',
  'reflowSnapshot',
  'svgToWindfoilOutlines',
  'windfoilOutlineFromSvgPaths',
]

const typeExports = [
  'BuildSdfAtlasOptions',
  'ColorGlyphMode',
  'DomLayoutSnapshot',
  'DomSdfOptions',
  'DomSdfRebuildOptions',
  'DomSdfStats',
  'DomSvgOptions',
  'DomTextBackend',
  'DomTextLayoutEngine',
  'DomTextOptions',
  'DomTextRebuildOptions',
  'DomTextStats',
  'FontStyleSnapshot',
  'GlyphBreak',
  'GlyphLayout',
  'GlyphRequest',
  'GlyphShape',
  'GlyphShapePath',
  'GlyphShapeStroke',
  'GlyphSlot',
  'RasterAtlas',
  'RasterColorBand',
  'RasterizeOptions',
  'RectLayout',
  'SdfAnimationMode',
  'SdfAtlas',
  'SdfAtlasMode',
  'SdfColorLayer',
  'SdfDropShadowOptions',
  'SdfMotionOptions',
  'SdfOutlineOptions',
  'SdfTextMaterialOptions',
  'SdfTextQuality',
  'SlugOptions',
  'SvgEmojiOutlineProviderOptions',
  'SvgToWindfoilOptions',
  'TextBlockLayout',
  'TextClass',
  'TextCss',
  'TextDecorationLayout',
  'TextFill',
  'TextFillContext',
  'TextOptions',
  'TextToneModel',
  'TextToneOptions',
  'TextVertex',
  'TextVertexContext',
  'WindfoilAffine',
  'WindfoilBoundingBox',
  'WindfoilColorStop',
  'WindfoilEmBox',
  'WindfoilExtendMode',
  'WindfoilForegroundPaint',
  'WindfoilGlyphOutline',
  'WindfoilGradientBase',
  'WindfoilGradientPaint',
  'WindfoilLinearGradientPaint',
  'WindfoilOptions',
  'WindfoilOutlineLayer',
  'WindfoilOutlineProvider',
  'WindfoilPaint',
  'WindfoilQuadratic',
  'WindfoilRadialGradientPaint',
  'WindfoilShapeInstance',
  'WindfoilShapePathLike',
  'WindfoilShapes',
  'WindfoilShapesOptions',
  'WindfoilShapesStats',
  'WindfoilSolidPaint',
  'WindfoilSvgLayer',
  'WindfoilSvgPaint',
  'WindfoilSvgPath',
  'WindfoilSvgResult',
  'WindfoilSvgSource',
  'WindfoilSvgWarning',
  'WindfoilSvgWarningCode',
  'WindfoilSweepGradientPaint',
]

describe('public API surface', () => {
  it('keeps every documented runtime export reachable from src/index.ts', () => {
    expect(Object.keys(api).sort()).toEqual(runtimeExports)
  })

  it('keeps every documented type export listed in src/index.ts', () => {
    // Type-only exports are erased at runtime, so read the entry module as
    // text and collect the names inside its `export type { ... }` blocks.
    const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')
    const exportedTypes = [...source.matchAll(/export type \{([^}]+)\}/g)]
      .flatMap((match) => (match[1] ?? '').split(','))
      .map((name) => name.trim())
      .filter((name) => name.length > 0)
    expect(exportedTypes.sort()).toEqual(typeExports)
  })

  it('keeps the effects underlay’s material hooks out of the published declarations', () => {
    // The package's declarations leave out what is tagged @internal, as tsconfig.build.json
    // says. SdfTextMaterial is exported, so its base class's protected members are published:
    // the hooks the Windfoil and Slug underlay takes from them are not.
    const build = ts.parseConfigFileTextToJson(
      'tsconfig.build.json',
      readFileSync(new URL('../tsconfig.build.json', import.meta.url), 'utf8'),
    ).config as { compilerOptions: ts.CompilerOptions }
    const declarations = (path: string): string =>
      ts.transpileDeclaration(readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8'), {
        fileName: path,
        compilerOptions: { stripInternal: build.compilerOptions.stripInternal === true },
      }).outputText
    const glyph = declarations('text/GlyphTextMaterial.ts')
    expect(glyph).toContain('protected applyCoverage(')
    expect(glyph).not.toMatch(/\binkAlpha\b/)
    const sdf = declarations('text/SdfTextMaterial.ts')
    expect(sdf).toContain('interface SdfTextMaterialOptions')
    expect(sdf).not.toMatch(/\bunderlay\b/)
  })
})
