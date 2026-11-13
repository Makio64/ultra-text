import type { Node } from 'three/webgpu'

/**
 * Walks the nodes one kind of pass builds from a text material's graph. Its colour graph
 * holds both what a beauty pass shows and what the pass three derives for a shadow map shows
 * instead (`outsideShadowPass`); `Node.traverse()` visits both sides. Each node is visited
 * once, in the order a depth-first walk first meets it, however many nodes share it.
 */
export function traversePass(
  graph: Node,
  pass: 'beauty' | 'shadow',
  visit: (node: Node) => void,
  seen = new Set<Node>(),
): void {
  if (seen.has(graph)) return
  seen.add(graph)
  visit(graph)
  const sides = graph as { type?: string; beautyNode?: Node; shadowNode?: Node }
  const other =
    sides.type === 'UltraTextPassNode'
      ? pass === 'beauty'
        ? sides.shadowNode
        : sides.beautyNode
      : undefined
  for (const child of graph.getChildren())
    if (child !== other) traversePass(child, pass, visit, seen)
}
