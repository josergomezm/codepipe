import { describe, it, expect } from 'vitest'
import { smallestSize } from './terminal-manager.js'

describe('smallestSize', () => {
  it('picks the smallest columns and rows across screens, ignoring unsized ones', () => {
    expect(smallestSize([{ cols: 180, rows: 50 }, null, { cols: 44, rows: 60 }])).toEqual({ cols: 44, rows: 50 })
  })

  it('returns null until a screen reports its size', () => {
    expect(smallestSize([null, null])).toBeNull()
    expect(smallestSize([])).toBeNull()
  })
})
