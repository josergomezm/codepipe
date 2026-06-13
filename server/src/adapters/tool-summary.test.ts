import { describe, it, expect } from 'vitest'
import { summarizeToolInput, oneLine } from './tool-summary.js'

describe('oneLine', () => {
  it('collapses whitespace and newlines', () => {
    expect(oneLine('a\n\n  b   c')).toBe('a b c')
  })
  it('truncates long strings with an ellipsis', () => {
    expect(oneLine('x'.repeat(200), 10)).toBe('xxxxxxxxx…')
  })
  it('stringifies non-strings', () => {
    expect(oneLine({ a: 1 })).toBe('{"a":1}')
  })
})

describe('summarizeToolInput', () => {
  it('uses the command for Bash', () => {
    expect(summarizeToolInput('Bash', { command: 'git status' })).toBe('git status')
  })
  it('uses the file path for read/write/edit', () => {
    expect(summarizeToolInput('Read', { file_path: '/src/app.ts' })).toBe('/src/app.ts')
    expect(summarizeToolInput('Edit', { path: '/a/b.ts' })).toBe('/a/b.ts')
  })
  it('uses the pattern for search tools', () => {
    expect(summarizeToolInput('Grep', { pattern: 'TODO' })).toBe('TODO')
  })

  it('summarizes Agent/Task tools as "<subagent>: <description>" and ignores the prompt', () => {
    const summary = summarizeToolInput('Agent', {
      subagent_type: 'Explore',
      description: 'Explore UI codebase for gaps',
      prompt: 'Explore this project thoroughly...\n\nLook at:\n1. structure\n2. files',
    })
    expect(summary).toBe('Explore: Explore UI codebase for gaps')
    expect(summary).not.toContain('\\n')
    expect(summary).not.toContain('Look at')
  })

  it('falls back to a compact one-line view of the first fields', () => {
    const summary = summarizeToolInput('Custom', { foo: 'bar', baz: 42 })
    expect(summary).toContain('foo')
    expect(summary).not.toContain('\n')
  })

  it('returns the tool name when there is no usable input', () => {
    expect(summarizeToolInput('Mystery', {})).toBe('Mystery')
    expect(summarizeToolInput('Mystery', null)).toBe('Mystery')
  })
})
