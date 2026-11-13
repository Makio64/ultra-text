import type { WindfoilQuadratic } from '../../types.js'
import type { Point } from './curves.js'

export function flattenContour(contour: readonly WindfoilQuadratic[], tolerance: number): Point[] {
  const result: Point[] = []
  const tolSq16 = 16 * tolerance * tolerance
  const add = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    depth: number,
  ): void => {
    const dx = x0 - 2 * x1 + x2,
      dy = y0 - 2 * y1 + y2
    if (depth >= 16 || dx * dx + dy * dy <= tolSq16) {
      result.push([x2, y2])
      return
    }
    const ax = (x0 + x1) * 0.5,
      ay = (y0 + y1) * 0.5,
      bx = (x1 + x2) * 0.5,
      by = (y1 + y2) * 0.5,
      x = (ax + bx) * 0.5,
      y = (ay + by) * 0.5
    add(x0, y0, ax, ay, x, y, depth + 1)
    add(x, y, bx, by, x2, y2, depth + 1)
  }
  const len = contour.length
  if (len > 0) {
    const q0 = contour[0]!
    result.push([q0[0], q0[1]])
    for (let i = 0; i < len; i++) {
      const q = contour[i]!,
        x0 = q[0],
        y0 = q[1],
        x1 = q[2],
        y1 = q[3],
        x2 = q[4],
        y2 = q[5],
        dx = x0 - 2 * x1 + x2,
        dy = y0 - 2 * y1 + y2
      if (dx * dx + dy * dy <= tolSq16) {
        result.push([x2, y2])
      } else {
        const ax = (x0 + x1) * 0.5,
          ay = (y0 + y1) * 0.5,
          bx = (x1 + x2) * 0.5,
          by = (y1 + y2) * 0.5,
          x = (ax + bx) * 0.5,
          y = (ay + by) * 0.5
        add(x0, y0, ax, ay, x, y, 1)
        add(x, y, bx, by, x2, y2, 1)
      }
    }
  }
  return result
}
export function signedArea(points: readonly Point[]): number {
  let area = 0
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!,
      b = points[i]!
    area += a[0] * b[1] - b[0] * a[1]
  }
  return area / 2
}
export function windingAt(points: readonly Point[], point: Point): number {
  let winding = 0
  const px = point[0],
    py = point[1]
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!,
      b = points[i]!,
      ay = a[1],
      by = b[1]
    if (ay <= py) {
      if (by > py && (b[0] - a[0]) * (py - ay) - (px - a[0]) * (by - ay) > 0) winding++
    } else if (by <= py && (b[0] - a[0]) * (py - ay) - (px - a[0]) * (by - ay) < 0) {
      winding--
    }
  }
  return winding
}
let poolSegAx = new Float64Array(64),
  poolSegAy = new Float64Array(64),
  poolSegBx = new Float64Array(64),
  poolSegBy = new Float64Array(64),
  poolSegMinX = new Float64Array(64),
  poolSegMaxX = new Float64Array(64),
  poolSegMinY = new Float64Array(64),
  poolSegMaxY = new Float64Array(64),
  poolSegContour = new Int32Array(64),
  poolSegIndex = new Int32Array(64),
  poolSegLast = new Int32Array(64),
  poolSegOrder = new Int32Array(64),
  poolSegActive = new Int32Array(64)

function ensureSegPools(totalSegs: number): void {
  if (poolSegAx.length >= totalSegs) return
  const cap = Math.max(poolSegAx.length * 2, totalSegs)
  poolSegAx = new Float64Array(cap)
  poolSegAy = new Float64Array(cap)
  poolSegBx = new Float64Array(cap)
  poolSegBy = new Float64Array(cap)
  poolSegMinX = new Float64Array(cap)
  poolSegMaxX = new Float64Array(cap)
  poolSegMinY = new Float64Array(cap)
  poolSegMaxY = new Float64Array(cap)
  poolSegContour = new Int32Array(cap)
  poolSegIndex = new Int32Array(cap)
  poolSegLast = new Int32Array(cap)
  poolSegOrder = new Int32Array(cap)
  poolSegActive = new Int32Array(cap)
}

export function contoursIntersect(contours: readonly (readonly Point[])[]): boolean {
  let totalSegs = 0
  for (const contour of contours) {
    const len = contour.length
    if (len > 1) totalSegs += len - 1
  }
  if (totalSegs < 2) return false
  ensureSegPools(totalSegs)
  let segAx = poolSegAx,
    segAy = poolSegAy,
    segBx = poolSegBx,
    segBy = poolSegBy,
    segMinX = poolSegMinX,
    segMaxX = poolSegMaxX,
    segMinY = poolSegMinY,
    segMaxY = poolSegMaxY
  const segContour = poolSegContour,
    segIndex = poolSegIndex,
    segLast = poolSegLast,
    order = poolSegOrder,
    active = poolSegActive
  let segIdx = 0
  for (let contour = 0; contour < contours.length; contour++) {
    const points = contours[contour]!
    const last = points.length - 1
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1]!,
        b = points[i]!,
        ax = a[0],
        ay = a[1],
        bx = b[0],
        by = b[1]
      segAx[segIdx] = ax
      segAy[segIdx] = ay
      segBx[segIdx] = bx
      segBy[segIdx] = by
      segMinX[segIdx] = ax < bx ? ax : bx
      segMaxX[segIdx] = ax > bx ? ax : bx
      segMinY[segIdx] = ay < by ? ay : by
      segMaxY[segIdx] = ay > by ? ay : by
      segContour[segIdx] = contour
      segIndex[segIdx] = i
      segLast[segIdx] = last
      order[segIdx] = segIdx
      segIdx++
    }
  }
  // Ordinary icons keep the original sweep and segment layout. Only consider
  // an X sweep when many contour starts form a horizontal strip.
  if (contours.length > 4) {
    let left = Infinity,
      right = -Infinity,
      bottom = Infinity,
      top = -Infinity
    for (const contour of contours) {
      const point = contour[0]
      if (!point) continue
      const px = point[0],
        py = point[1]
      if (px < left) left = px
      if (px > right) right = px
      if (py < bottom) bottom = py
      if (py > top) top = py
    }
    if (right - left > 2 * (top - bottom)) {
      let minX = Infinity,
        maxX = -Infinity,
        minY = Infinity,
        maxY = -Infinity,
        spanX = 0,
        spanY = 0
      for (let k = 0; k < totalSegs; k++) {
        const lowX = segMinX[k]!,
          highX = segMaxX[k]!,
          lowY = segMinY[k]!,
          highY = segMaxY[k]!
        if (lowX < minX) minX = lowX
        if (highX > maxX) maxX = highX
        if (lowY < minY) minY = lowY
        if (highY > maxY) maxY = highY
        spanX += highX - lowX
        spanY += highY - lowY
      }
      // Span / extent estimates the active set. Swap only when X predicts
      // at least half the overlap; long horizontal edges still favor Y.
      if (2 * spanX * (maxY - minY) < spanY * (maxX - minX)) {
        const tmpA = segAx,
          tmpB = segBx,
          tmpMin = segMinX,
          tmpMax = segMaxX
        segAx = segAy
        segAy = tmpA
        segBx = segBy
        segBy = tmpB
        segMinX = segMinY
        segMinY = tmpMin
        segMaxX = segMaxY
        segMaxY = tmpMax
      }
    }
  }
  if (totalSegs <= 32) {
    for (let i = 1; i < totalSegs; i++) {
      const key = order[i]!,
        keyY = segMinY[key]!
      let j = i - 1
      while (j >= 0 && segMinY[order[j]!]! > keyY) {
        order[j + 1] = order[j]!
        j--
      }
      order[j + 1] = key
    }
  } else {
    order.subarray(0, totalSegs).sort((a, b) => segMinY[a]! - segMinY[b]!)
  }
  let activeLen = 0
  for (let k = 0; k < totalSegs; k++) {
    const s = order[k]!,
      sMinY = segMinY[s]!,
      sMinX = segMinX[s]!,
      sMaxX = segMaxX[s]!,
      sContour = segContour[s]!,
      sIdx = segIndex[s]!,
      sLastMinus1 = segLast[s]! - 1,
      sax = segAx[s]!,
      say = segAy[s]!,
      sbx = segBx[s]!,
      sby = segBy[s]!,
      sdx = sbx - sax,
      sdy = sby - say
    let write = 0
    for (let m = 0; m < activeLen; m++) {
      const t = active[m]!
      if (segMaxY[t]! < sMinY) continue
      active[write++] = t
      if (sMaxX < segMinX[t]! || segMaxX[t]! < sMinX) continue
      if (sContour === segContour[t]!) {
        const diff = Math.abs(sIdx - segIndex[t]!)
        if (diff === 1 || diff === sLastMinus1) continue
      }
      const tax = segAx[t]!,
        tay = segAy[t]!,
        tbx = segBx[t]!,
        tby = segBy[t]!,
        tdx = tbx - tax,
        tdy = tby - tay,
        a = sdx * (tay - say) - sdy * (tax - sax),
        b = sdx * (tby - say) - sdy * (tbx - sax),
        c = tdx * (say - tay) - tdy * (sax - tax),
        d = tdx * (sby - tay) - tdy * (sbx - tax)
      if (a * b <= 0 && c * d <= 0) return true
    }
    activeLen = write
    active[activeLen++] = s
  }
  return false
}
let poolPolyX = new Float64Array(256),
  poolPolyY = new Float64Array(256),
  poolPolyStart = new Int32Array(16),
  poolPolyLen = new Int32Array(16),
  poolAreas = new Float64Array(16),
  poolMinX = new Float64Array(16),
  poolMinY = new Float64Array(16),
  poolMaxX = new Float64Array(16),
  poolMaxY = new Float64Array(16),
  flatWriteLen = 0,
  flatMinX = 0,
  flatMinY = 0,
  flatMaxX = 0,
  flatMaxY = 0,
  flatTolSq16 = 0

function ensureContourPools(count: number): void {
  if (poolPolyStart.length >= count) return
  const cap = Math.max(poolPolyStart.length * 2, count)
  poolPolyStart = new Int32Array(cap)
  poolPolyLen = new Int32Array(cap)
  poolAreas = new Float64Array(cap)
  poolMinX = new Float64Array(cap)
  poolMinY = new Float64Array(cap)
  poolMaxX = new Float64Array(cap)
  poolMaxY = new Float64Array(cap)
}

function pushPolyPoint(x: number, y: number): void {
  const idx = flatWriteLen
  if (idx >= poolPolyX.length) {
    const cap = poolPolyX.length * 2
    const nextX = new Float64Array(cap),
      nextY = new Float64Array(cap)
    nextX.set(poolPolyX)
    nextY.set(poolPolyY)
    poolPolyX = nextX
    poolPolyY = nextY
  }
  poolPolyX[idx] = x
  poolPolyY[idx] = y
  flatWriteLen = idx + 1
  if (x < flatMinX) flatMinX = x
  if (x > flatMaxX) flatMaxX = x
  if (y < flatMinY) flatMinY = y
  if (y > flatMaxY) flatMaxY = y
}

function addFlatSubdiv(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  depth: number,
): void {
  const dx = x0 - 2 * x1 + x2,
    dy = y0 - 2 * y1 + y2
  if (depth >= 16 || dx * dx + dy * dy <= flatTolSq16) {
    pushPolyPoint(x2, y2)
    return
  }
  const ax = (x0 + x1) * 0.5,
    ay = (y0 + y1) * 0.5,
    bx = (x1 + x2) * 0.5,
    by = (y1 + y2) * 0.5,
    x = (ax + bx) * 0.5,
    y = (ay + by) * 0.5
  addFlatSubdiv(x0, y0, ax, ay, x, y, depth + 1)
  addFlatSubdiv(x, y, bx, by, x2, y2, depth + 1)
}

function contourAreaOnly(contour: readonly WindfoilQuadratic[]): number {
  const len = contour.length
  if (len === 0) return 0
  let area6 = 0
  for (let i = 0; i < len; i++) {
    const q = contour[i]!,
      x0 = q[0],
      y0 = q[1],
      x1 = q[2],
      y1 = q[3],
      x2 = q[4],
      y2 = q[5]
    area6 += x0 * (2 * y1 + y2) + 2 * x1 * (y2 - y0) - x2 * (y0 + 2 * y1)
  }
  return area6 / 6
}

function windingAtFlat(start: number, len: number, px: number, py: number): number {
  let winding = 0
  const polyX = poolPolyX,
    polyY = poolPolyY,
    end = start + len
  let ax = polyX[start]!,
    ay = polyY[start]!
  for (let i = start + 1; i < end; i++) {
    const bx = polyX[i]!,
      by = polyY[i]!
    if (ay <= py) {
      if (by > py && (bx - ax) * (py - ay) - (px - ax) * (by - ay) > 0) winding++
    } else if (by <= py && (bx - ax) * (py - ay) - (px - ax) * (by - ay) < 0) {
      winding--
    }
    ax = bx
    ay = by
  }
  return winding
}

function contoursIntersectFlat(count: number, totalSegs: number): boolean {
  if (totalSegs < 2) return false
  ensureSegPools(totalSegs)
  let segAx = poolSegAx,
    segAy = poolSegAy,
    segBx = poolSegBx,
    segBy = poolSegBy,
    segMinX = poolSegMinX,
    segMaxX = poolSegMaxX,
    segMinY = poolSegMinY,
    segMaxY = poolSegMaxY
  const segContour = poolSegContour,
    segIndex = poolSegIndex,
    segLast = poolSegLast,
    order = poolSegOrder,
    active = poolSegActive,
    polyX = poolPolyX,
    polyY = poolPolyY
  let segIdx = 0
  for (let contour = 0; contour < count; contour++) {
    const start = poolPolyStart[contour]!,
      len = poolPolyLen[contour]!,
      last = len - 1
    if (len <= 1) continue
    let ax = polyX[start]!,
      ay = polyY[start]!
    for (let i = 1; i < len; i++) {
      const bx = polyX[start + i]!,
        by = polyY[start + i]!
      segAx[segIdx] = ax
      segAy[segIdx] = ay
      segBx[segIdx] = bx
      segBy[segIdx] = by
      segMinX[segIdx] = ax < bx ? ax : bx
      segMaxX[segIdx] = ax > bx ? ax : bx
      segMinY[segIdx] = ay < by ? ay : by
      segMaxY[segIdx] = ay > by ? ay : by
      segContour[segIdx] = contour
      segIndex[segIdx] = i
      segLast[segIdx] = last
      order[segIdx] = segIdx
      segIdx++
      ax = bx
      ay = by
    }
  }
  if (count > 4) {
    let left = Infinity,
      right = -Infinity,
      bottom = Infinity,
      top = -Infinity
    for (let contour = 0; contour < count; contour++) {
      if (poolPolyLen[contour]! <= 0) continue
      const start = poolPolyStart[contour]!,
        px = polyX[start]!,
        py = polyY[start]!
      if (px < left) left = px
      if (px > right) right = px
      if (py < bottom) bottom = py
      if (py > top) top = py
    }
    if (right - left > 2 * (top - bottom)) {
      let minX = Infinity,
        maxX = -Infinity,
        minY = Infinity,
        maxY = -Infinity,
        spanX = 0,
        spanY = 0
      for (let k = 0; k < totalSegs; k++) {
        const lowX = segMinX[k]!,
          highX = segMaxX[k]!,
          lowY = segMinY[k]!,
          highY = segMaxY[k]!
        if (lowX < minX) minX = lowX
        if (highX > maxX) maxX = highX
        if (lowY < minY) minY = lowY
        if (highY > maxY) maxY = highY
        spanX += highX - lowX
        spanY += highY - lowY
      }
      if (2 * spanX * (maxY - minY) < spanY * (maxX - minX)) {
        const tmpA = segAx,
          tmpB = segBx,
          tmpMin = segMinX,
          tmpMax = segMaxX
        segAx = segAy
        segAy = tmpA
        segBx = segBy
        segBy = tmpB
        segMinX = segMinY
        segMinY = tmpMin
        segMaxX = segMaxY
        segMaxY = tmpMax
      }
    }
  }
  if (totalSegs <= 32) {
    for (let i = 1; i < totalSegs; i++) {
      const key = order[i]!,
        keyY = segMinY[key]!
      let j = i - 1
      while (j >= 0 && segMinY[order[j]!]! > keyY) {
        order[j + 1] = order[j]!
        j--
      }
      order[j + 1] = key
    }
  } else {
    order.subarray(0, totalSegs).sort((a, b) => segMinY[a]! - segMinY[b]!)
  }
  let activeLen = 0
  for (let k = 0; k < totalSegs; k++) {
    const s = order[k]!,
      sMinY = segMinY[s]!,
      sMinX = segMinX[s]!,
      sMaxX = segMaxX[s]!,
      sContour = segContour[s]!,
      sIdx = segIndex[s]!,
      sLastMinus1 = segLast[s]! - 1,
      sax = segAx[s]!,
      say = segAy[s]!,
      sbx = segBx[s]!,
      sby = segBy[s]!,
      sdx = sbx - sax,
      sdy = sby - say
    let write = 0
    for (let m = 0; m < activeLen; m++) {
      const t = active[m]!
      if (segMaxY[t]! < sMinY) continue
      active[write++] = t
      if (sMaxX < segMinX[t]! || segMaxX[t]! < sMinX) continue
      if (sContour === segContour[t]!) {
        const diff = Math.abs(sIdx - segIndex[t]!)
        if (diff === 1 || diff === sLastMinus1) continue
      }
      const tax = segAx[t]!,
        tay = segAy[t]!,
        tbx = segBx[t]!,
        tby = segBy[t]!,
        tdx = tbx - tax,
        tdy = tby - tay,
        a = sdx * (tay - say) - sdy * (tax - sax),
        b = sdx * (tby - say) - sdy * (tbx - sax),
        c = tdx * (say - tay) - tdy * (sax - tax),
        d = tdx * (sby - tay) - tdy * (sbx - tax)
      if (a * b <= 0 && c * d <= 0) return true
    }
    activeLen = write
    active[activeLen++] = s
  }
  return false
}

function reverseContour(contour: readonly WindfoilQuadratic[]): WindfoilQuadratic[] {
  const len = contour.length,
    rev = new Array<WindfoilQuadratic>(len)
  for (let k = 0; k < len; k++) {
    const q = contour[len - 1 - k]!
    rev[k] = [q[4], q[5], q[2], q[3], q[0], q[1]]
  }
  return rev
}

export function canonicalizeWinding(
  contours: readonly (readonly WindfoilQuadratic[])[],
  rule: 'evenodd' | 'nonzero',
  tolerance: number,
  check = true,
): { contours: WindfoilQuadratic[][]; dropped: number; intersects: boolean } {
  const count = contours.length
  if (count === 0) return { contours: [], dropped: 0, intersects: false }
  const tolSq16 = 16 * tolerance * tolerance
  if (count === 1 && !check) {
    const contour = contours[0]!,
      area = contourAreaOnly(contour)
    if (Math.abs(area) < 1e-12) return { contours: [], dropped: 1, intersects: false }
    return {
      contours: [area > 0 ? [...contour] : reverseContour(contour)],
      dropped: 0,
      intersects: false,
    }
  }
  ensureContourPools(count)
  const areas = poolAreas,
    polyMinX = poolMinX,
    polyMinY = poolMinY,
    polyMaxX = poolMaxX,
    polyMaxY = poolMaxY
  flatWriteLen = 0
  flatTolSq16 = tolSq16
  let totalSegs = 0
  for (let i = 0; i < count; i++) {
    const contour = contours[i]!,
      cLen = contour.length,
      start = flatWriteLen
    poolPolyStart[i] = start
    if (cLen > 0) {
      if (start + cLen + 1 >= poolPolyX.length) {
        const cap = Math.max(poolPolyX.length * 2, start + cLen + 16)
        const nextX = new Float64Array(cap),
          nextY = new Float64Array(cap)
        nextX.set(poolPolyX)
        nextY.set(poolPolyY)
        poolPolyX = nextX
        poolPolyY = nextY
      }
      const q0 = contour[0]!,
        x0 = q0[0],
        y0 = q0[1]
      let minX = x0,
        maxX = x0,
        minY = y0,
        maxY = y0,
        area6 = 0,
        writeIdx = start
      poolPolyX[writeIdx] = x0
      poolPolyY[writeIdx] = y0
      writeIdx++
      for (let k = 0; k < cLen; k++) {
        const q = contour[k]!,
          qx0 = q[0],
          qy0 = q[1],
          qx1 = q[2],
          qy1 = q[3],
          qx2 = q[4],
          qy2 = q[5],
          dx = qx0 - 2 * qx1 + qx2,
          dy = qy0 - 2 * qy1 + qy2
        area6 += qx0 * (2 * qy1 + qy2) + 2 * qx1 * (qy2 - qy0) - qx2 * (qy0 + 2 * qy1)
        if (dx * dx + dy * dy <= tolSq16 && writeIdx < poolPolyX.length) {
          poolPolyX[writeIdx] = qx2
          poolPolyY[writeIdx] = qy2
          writeIdx++
          if (qx2 < minX) minX = qx2
          if (qx2 > maxX) maxX = qx2
          if (qy2 < minY) minY = qy2
          if (qy2 > maxY) maxY = qy2
        } else {
          flatWriteLen = writeIdx
          flatMinX = minX
          flatMaxX = maxX
          flatMinY = minY
          flatMaxY = maxY
          addFlatSubdiv(qx0, qy0, qx1, qy1, qx2, qy2, 0)
          writeIdx = flatWriteLen
          minX = flatMinX
          maxX = flatMaxX
          minY = flatMinY
          maxY = flatMaxY
        }
      }
      flatWriteLen = writeIdx
      const len = writeIdx - start
      poolPolyLen[i] = len
      if (len > 1) totalSegs += len - 1
      areas[i] = area6 / 6
      polyMinX[i] = minX
      polyMinY[i] = minY
      polyMaxX[i] = maxX
      polyMaxY[i] = maxY
    } else {
      poolPolyLen[i] = 0
      areas[i] = 0
      polyMinX[i] = polyMinY[i] = Infinity
      polyMaxX[i] = polyMaxY[i] = -Infinity
    }
  }
  const intersects = check && contoursIntersectFlat(count, totalSegs)
  if (intersects) return { contours: contours.map((c) => [...c]), dropped: 0, intersects: true }
  const output: WindfoilQuadratic[][] = []
  const filled = (w: number): number => Number(rule === 'evenodd' ? Math.abs(w) % 2 === 1 : w !== 0)
  for (let i = 0; i < count; i++) {
    const area = areas[i]!,
      absArea = Math.abs(area)
    if (absArea < 1e-12) continue
    let outside = 0
    if (count > 1) {
      const start = poolPolyStart[i]!,
        sx = (poolPolyX[start]! + poolPolyX[start + 1]!) * 0.5,
        sy = (poolPolyY[start]! + poolPolyY[start + 1]!) * 0.5
      for (let j = 0; j < count; j++) {
        if (
          j !== i &&
          Math.abs(areas[j]!) > absArea &&
          sx >= polyMinX[j]! &&
          sx <= polyMaxX[j]! &&
          sy >= polyMinY[j]! &&
          sy <= polyMaxY[j]! &&
          windingAtFlat(poolPolyStart[j]!, poolPolyLen[j]!, sx, sy) !== 0
        ) {
          outside += Math.sign(areas[j]!)
        }
      }
    }
    const signArea = Math.sign(area)
    const orientation = filled(outside + signArea) - filled(outside)
    if (!orientation) continue
    const contour = contours[i]!
    output.push(signArea === orientation ? [...contour] : reverseContour(contour))
  }
  return { contours: output, dropped: count - output.length, intersects: false }
}
