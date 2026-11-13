import { expect, it, vi } from 'vitest'
it('lazily uses browser color parsing and distinguishes invalid color assignments', async () => {
  let style = '#000000'
  const create = vi.fn(() => ({
    get fillStyle() {
      return style
    },
    set fillStyle(value: string) {
      if (value === 'rebeccapurple') style = '#663399'
      else if (/^#[\da-f]{6}$/.test(value)) style = value
    },
  }))
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      getContext = create
    },
  )
  vi.resetModules()
  const { colorPaint } = await import('../src/windfoil/svg/colors.js')
  expect(create).not.toHaveBeenCalled()
  expect(colorPaint('rebeccapurple', 0.25)).toEqual({ type: 'solid', color: [0.4, 0.2, 0.6, 0.25] })
  expect(colorPaint('not-a-color')).toEqual({ type: 'unsupported', value: 'not-a-color' })
  expect(colorPaint('rgba(100% 0% 50% / 25%)')).toEqual({ type: 'solid', color: [1, 0, 0.5, 0.25] })
  expect(colorPaint('rgb(300, -1, 20)')).toEqual({ type: 'solid', color: [1, 0, 20 / 255, 1] })
  expect(colorPaint('rgb(a b c)')).toEqual({ type: 'unsupported', value: 'rgb(a b c)' })
  expect(colorPaint('rgb(1 2)')).toEqual({ type: 'unsupported', value: 'rgb(1 2)' })
  expect(create).toHaveBeenCalledOnce()
})
