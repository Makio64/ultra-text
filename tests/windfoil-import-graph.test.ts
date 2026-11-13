// @vitest-environment node
/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { expect, it } from 'vitest'
it('keeps SVG conversion and standalone shapes out of the static DomSdf import graph', () => {
  const visited = new Set<string>()
  const visit = (path: string): void => {
    if (visited.has(path)) return
    visited.add(path)
    expect(path).not.toMatch(/windfoil\/(?:svg\/|shapes\.ts|shapeGeometry\.ts)/)
    const source = readFileSync(path, 'utf8')
    for (const match of source.matchAll(
      /(?:import|export)\s+(?!type\b)[\s\S]*?from\s*['"]([^'"]+)['"]/g,
    )) {
      const target = match[1]!
      if (target.startsWith('.')) visit(resolve(dirname(path), target.replace(/\.js$/, '.ts')))
    }
  }
  visit(resolve('src/dom/DomSdf.ts'))
})
it('loads the Windfoil size switch only through a dynamic import from the runtime', () => {
  const staticGraph = (entry: string): Set<string> => {
    const visited = new Set<string>()
    const visit = (path: string): void => {
      if (visited.has(path)) return
      visited.add(path)
      const source = readFileSync(path, 'utf8')
      for (const match of source.matchAll(
        /(?:import|export)\s+(?!type\b)[\s\S]*?from\s*['"]([^'"]+)['"]/g,
      )) {
        const target = match[1]!
        if (target.startsWith('.')) visit(resolve(dirname(path), target.replace(/\.js$/, '.ts')))
      }
    }
    visit(resolve(entry))
    return visited
  }
  const sizeSwitch = resolve('src/windfoil/sizeSwitch.ts')
  // The walk does follow the runtime's own static imports.
  expect(staticGraph('src/windfoil/runtime.ts').has(resolve('src/windfoil/geometry.ts'))).toBe(true)
  for (const entry of ['src/dom/DomSdf.ts', 'src/windfoil/runtime.ts', 'src/windfoil/mixed.ts'])
    expect(staticGraph(entry).has(sizeSwitch), entry).toBe(false)
  expect(readFileSync('src/windfoil/runtime.ts', 'utf8')).toMatch(
    /import\(\s*'\.\/sizeSwitch\.js'\s*\)/,
  )
})
it('loads the outline tracer only through a dynamic import from DomSdf', () => {
  // The public entry's size limit ignores the tracer's chunk: only this walk sees a static import.
  const visited = new Set<string>()
  const visit = (path: string): void => {
    if (visited.has(path)) return
    visited.add(path)
    expect(path).not.toMatch(/windfoil\/(?:tracedOutlines\.ts|trace\/)/)
    const source = readFileSync(path, 'utf8')
    for (const match of source.matchAll(
      /(?:import|export)\s+(?!type\b)[\s\S]*?from\s*['"]([^'"]+)['"]/g,
    )) {
      const target = match[1]!
      if (target.startsWith('.')) visit(resolve(dirname(path), target.replace(/\.js$/, '.ts')))
    }
  }
  for (const entry of ['src/index.ts', 'src/vanilla.ts']) visit(resolve(entry))
  expect(visited.has(resolve('src/dom/DomSdf.ts'))).toBe(true)
  expect(readFileSync('src/dom/DomSdf.ts', 'utf8')).toMatch(
    /import\(\s*'\.\.\/windfoil\/tracedOutlines\.js'\s*\)/,
  )
})
