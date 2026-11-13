/**
 * @internal The atlas passes in WGSL, run on three's device by `gpuAtlas.ts` and on a raw
 * `GPUDevice` by the Three-free entry (`vanilla.ts`): boundary seeds (`seedMain`), one jump
 * flood step (`jumpMain`) and the resolve into an r8unorm atlas (`fullscreenVert`,
 * `resolveFrag`). Each pass binds 16 bytes of `Params` at binding 0:
 * the size, then the raster's row stride in words for the seeds or the step for a jump, then
 * 1 / pxRange for the resolve. The seed and resolve passes read the raster and the seeds from
 * storage buffers (one rgba8unorm texel per word, alpha in its top byte), never a texture: on
 * an M3 Max that cut their pipelines' native compile from
 * ~120 to ~20 ms each, in Chrome and in WebKit. Every real seed coordinate is >= 0; x is
 * biased by +2 so that the sign of seed.x carries the texel's inside/outside state across the
 * ping-pong, and 32768 marks no seed. The neighbours are visited in one order everywhere, so
 * ties and sums, and with them the bytes, do not depend on the device.
 */
export const JFA_WGSL = /* wgsl */ `
struct Params {
  width: i32,
  height: i32,
  stride: i32,
  invPxRange: f32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> rasterWords: array<u32>;
@group(0) @binding(1) var<storage, read> inputSeeds: array<vec2f>;
@group(0) @binding(2) var<storage, read_write> outputSeeds: array<vec2f>;

fn inAtlas(x: i32, y: i32) -> bool {
  return x >= 0 && y >= 0 && x < params.width && y < params.height;
}

fn alphaAt(x: i32, y: i32) -> u32 {
  return rasterWords[y * params.stride + x] >> 24u;
}

@compute @workgroup_size(8, 8)
fn seedMain(@builtin(global_invocation_id) id: vec3u) {
  let x = i32(id.x);
  let y = i32(id.y);
  if (!inAtlas(x, y)) {
    return;
  }
  let index = y * params.width + x;
  let here = alphaAt(x, y);
  if (here < 128u) {
    outputSeeds[index] = vec2f(32768.0);
    return;
  }
  let excess = f32(here) - 127.5;
  var sum = vec2f(0.0);
  var count = 0.0;
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      if ((dx != 0 || dy != 0) && inAtlas(x + dx, y + dy)) {
        let neighbor = alphaAt(x + dx, y + dy);
        if (neighbor < 128u) {
          let crossing = excess / f32(here - neighbor);
          sum += vec2f(crossing * f32(dx), crossing * f32(dy));
          count += 1.0;
        }
      }
    }
  }
  if (count > 0.0) {
    let seeded = vec2f(f32(x), f32(y)) + sum / count;
    outputSeeds[index] = vec2f(-(seeded.x + 2.0), seeded.y);
  } else {
    outputSeeds[index] = vec2f(-32768.0, 32768.0);
  }
}

@compute @workgroup_size(8, 8)
fn jumpMain(@builtin(global_invocation_id) id: vec3u) {
  let x = i32(id.x);
  let y = i32(id.y);
  if (!inAtlas(x, y)) {
    return;
  }
  let index = y * params.width + x;
  let biasedPos = vec2f(f32(x) + 2.0, f32(y));
  let here = inputSeeds[index];
  var best = vec2f(abs(here.x), here.y);
  var bestDistance = 3.402823e38;
  if (best.x < 20002.0) {
    let delta = best - biasedPos;
    bestDistance = dot(delta, delta);
  }
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let nx = x + params.stride * dx;
      let ny = y + params.stride * dy;
      if ((dx != 0 || dy != 0) && inAtlas(nx, ny)) {
        let seed = inputSeeds[ny * params.width + nx];
        let candidate = vec2f(abs(seed.x), seed.y);
        if (candidate.x < 20002.0) {
          let delta = candidate - biasedPos;
          let distance = dot(delta, delta);
          if (distance < bestDistance) {
            bestDistance = distance;
            best = candidate;
          }
        }
      }
    }
  }
  outputSeeds[index] = vec2f(select(best.x, -best.x, here.x < 0.0), best.y);
}

@vertex
fn fullscreenVert(@builtin(vertex_index) vid: u32) -> @builtin(position) vec4f {
  let x = f32((vid << 1u) & 2u);
  let y = f32(vid & 2u);
  return vec4f(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
}

@fragment
fn resolveFrag(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let pixelPos = floor(pos.xy - vec2f(0.5));
  let pixel = vec2i(pixelPos);
  let rawSeed = inputSeeds[pixel.y * params.width + pixel.x];
  let inside = rawSeed.x < 0.0;
  let absX = abs(rawSeed.x);
  if (absX >= 20002.0) {
    return vec4f(select(0.0, 1.0, inside), 0.0, 0.0, 1.0);
  }
  let dist = length(vec2f(absX - 2.0, rawSeed.y) - pixelPos);
  let signedDist = select(dist, -dist, inside);
  return vec4f(clamp(0.5 - signedDist * params.invPxRange, 0.0, 1.0), 0.0, 0.0, 1.0);
}
`

/** @internal The mip blit (`mipVert`, `mipFrag`) the Three-free entry appends to `JFA_WGSL`. */
export const MIP_WGSL = /* wgsl */ `
@group(0) @binding(0) var mipSrc: texture_2d<f32>;
@group(0) @binding(1) var mipSampler: sampler;

struct MipVarying {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn mipVert(@builtin(vertex_index) vid: u32) -> MipVarying {
  let x = f32((vid << 1u) & 2u);
  let y = f32(vid & 2u);
  var out: MipVarying;
  out.pos = vec4f(x * 2.0 - 1.0, 1.0 - y * 2.0, 0.0, 1.0);
  out.uv = vec2f(x, y);
  return out;
}

@fragment
fn mipFrag(in: MipVarying) -> @location(0) vec4f {
  return textureSampleLevel(mipSrc, mipSampler, in.uv, 0.0);
}
`
