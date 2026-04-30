import { describe, it, expect, beforeEach } from 'vitest'
import { KiroAdapter } from './kiro.js'
import { stripAnsi } from './strip-ansi.js'

/** Simulate CLI startup by sending a prompt pattern. */
function simulateStartup(adapter: KiroAdapter): void {
  adapter.onData('1% > Ready')
}

/**
 * Tests reproducing the exact bugs from the session JSON:
 * - Tool validation errors bleeding into assistant messages
 * - Assistant messages accumulating content across tool boundaries
 * - Interactive prompts (y/n/t) mixed with tool output
 * - ANSI escape sequences leaking through stripAnsi
 */

describe('KiroAdapter — tool output interleaving with assistant text', () => {
  let adapter: KiroAdapter

  beforeEach(() => {
    adapter = new KiroAdapter()
  })

  it('classifies "Tool validation failed" as tool output, not assistant content', () => {
    simulateStartup(adapter)
    adapter.notifyUserInput('make the frontend mobile friendly')

    // First response chunk
    const r1 = adapter.onData('Sure! Let me first look at the current frontend code.')
    expect(r1.length).toBe(1)
    expect(r1[0].type).toBe('chunk')
    if (r1[0].type === 'chunk') {
      expect(r1[0].content).toContain('Sure!')
    }

    // Tool validation error arrives — should be tool output, NOT appended to assistant
    const r2 = adapter.onData('Tool validation failed: \nFailed to validate tool parameters: Directory not found: C:\\frontend\\src')
    const chunks = r2.filter(e => e.type === 'chunk')
    const toolEvents = r2.filter(e => e.type === 'tool_use')

    // The tool validation error should be classified as tool output
    expect(toolEvents.length).toBeGreaterThanOrEqual(1)
    // No chunk should contain "Tool validation failed"
    for (const chunk of chunks) {
      if (chunk.type === 'chunk') {
        expect(chunk.content).not.toContain('Tool validation failed')
        expect(chunk.content).not.toContain('Failed to validate')
      }
    }
  })

  it('does not accumulate tool errors into assistant message content', () => {
    simulateStartup(adapter)
    adapter.notifyUserInput('help me')

    // Assistant starts responding
    adapter.onData('Let me look at the code.')

    // Tool error arrives
    const toolEvents = adapter.onData('Tool validation failed: \nFailed to validate tool parameters: file not found')
    // Should be tool_use, possibly with message_complete before it
    const types = toolEvents.map(e => e.type)
    expect(types).not.toContain('chunk') // No content chunk with tool error text

    // More assistant text arrives after the tool error
    const r3 = adapter.onData('I see the issue. Let me try a different approach.')
    const chunks = r3.filter(e => e.type === 'chunk')
    expect(chunks.length).toBe(1)
    if (chunks[0].type === 'chunk') {
      // New assistant text should NOT contain the previous tool error
      expect(chunks[0].content).not.toContain('Tool validation failed')
      expect(chunks[0].content).toContain('different approach')
    }
  })

  it('handles the real session flow: assistant → tool error → tool success → assistant continuation', () => {
    simulateStartup(adapter)
    adapter.notifyUserInput('make the frontend mobile friendly')

    // 1. Assistant starts
    const r1 = adapter.onData('Sure! Let me first look at the current frontend code.')
    expect(r1[0].type).toBe('chunk')

    // 2. Tool use (reading directory)
    const r2 = adapter.onData('Reading directory: C:/Users/codepipe (using tool: read, max depth: 2)')
    const toolUse = r2.filter(e => e.type === 'tool_use')
    expect(toolUse.length).toBeGreaterThanOrEqual(1)

    // 3. Tool success
    const r3 = adapter.onData('✓ Successfully read directory C:\\codepipe (57 entries)\n - Completed in 0.8s')
    const toolResult = r3.filter(e => e.type === 'tool_use')
    expect(toolResult.length).toBeGreaterThanOrEqual(1)

    // 4. Tool validation error
    const r4 = adapter.onData("Tool validation failed: \nFailed to validate tool parameters: 'tailwind.config.js' does not exist")
    const toolError = r4.filter(e => e.type === 'tool_use')
    expect(toolError.length).toBeGreaterThanOrEqual(1)
    // No chunk should contain the error
    const errorChunks = r4.filter(e => e.type === 'chunk')
    for (const c of errorChunks) {
      if (c.type === 'chunk') {
        expect(c.content).not.toContain('Tool validation failed')
      }
    }

    // 5. Assistant continues with analysis
    const r5 = adapter.onData('Good, I can see the project structure. Let me check the components.')
    const assistantChunks = r5.filter(e => e.type === 'chunk')
    expect(assistantChunks.length).toBe(1)
    if (assistantChunks[0].type === 'chunk') {
      expect(assistantChunks[0].content).toContain('project structure')
      // Must NOT contain any previous tool output
      expect(assistantChunks[0].content).not.toContain('Tool validation')
      expect(assistantChunks[0].content).not.toContain('Successfully read')
    }
  })

  it('handles interactive prompt [y/n/t] after tool write', () => {
    simulateStartup(adapter)
    adapter.notifyUserInput('make changes')

    // Assistant responds
    adapter.onData('I will update the file.')

    // Tool write + interactive prompt
    const r = adapter.onData("I'll modify the following file: AppSidebar.vue (using tool: write)\nAllow this action? Use 't' to trust the 'write' tool. [y/n/t]:")
    const types = r.map(e => e.type)

    // Should have: message_complete (for assistant), tool_use, interactive_prompt
    expect(types).toContain('interactive_prompt')

    // The interactive prompt content should NOT contain tool output
    const prompt = r.find(e => e.type === 'interactive_prompt')
    if (prompt && prompt.type === 'interactive_prompt') {
      expect(prompt.options).toContain('y')
      expect(prompt.options).toContain('n')
      expect(prompt.options).toContain('t')
    }
  })

  it('properly handles user answering interactive prompt and resuming', () => {
    simulateStartup(adapter)
    adapter.notifyUserInput('update the file')

    // Assistant responds
    adapter.onData('I will update the sidebar.')

    // Interactive prompt
    adapter.onData("Allow this action? [y/n/t]:")

    // User answers "y"
    adapter.notifyUserInput('y')

    // Tool execution result
    const r1 = adapter.onData('- Completed in 0.38s')
    const toolEvents = r1.filter(e => e.type === 'tool_use')
    expect(toolEvents.length).toBeGreaterThanOrEqual(1)

    // Assistant continues
    const r2 = adapter.onData('Now let me update the ChatView component.')
    const chunks = r2.filter(e => e.type === 'chunk')
    expect(chunks.length).toBe(1)
    if (chunks[0].type === 'chunk') {
      expect(chunks[0].content).toContain('ChatView')
      expect(chunks[0].content).not.toContain('Completed in')
    }
  })

  it('classifies diff-style output as tool output', () => {
    simulateStartup(adapter)
    adapter.notifyUserInput('update file')
    adapter.onData('I will update the file.')

    // Diff output from write tool
    const r = adapter.onData(
      '-  1    : <script setup lang="ts">\n' +
      '-  2    : import { watch } from \'vue\'\n' +
      '+      1: <script setup lang="ts">\n' +
      '+      2: import { watch, computed } from \'vue\''
    )
    const chunks = r.filter(e => e.type === 'chunk')
    const tools = r.filter(e => e.type === 'tool_use')

    // Diff lines should be tool output
    expect(tools.length).toBeGreaterThanOrEqual(1)
    // No chunk should contain diff markers
    for (const c of chunks) {
      if (c.type === 'chunk') {
        expect(c.content).not.toMatch(/^[+-]\s*\d+\s*:/)
      }
    }
  })

  it('classifies "I\'ll modify/create the following file" as tool output', () => {
    simulateStartup(adapter)
    adapter.notifyUserInput('fix the bug')
    adapter.onData('Let me fix that.')

    const r = adapter.onData("I'll modify the following file: src/App.vue (using tool: write)")
    const tools = r.filter(e => e.type === 'tool_use')
    expect(tools.length).toBeGreaterThanOrEqual(1)

    const chunks = r.filter(e => e.type === 'chunk')
    for (const c of chunks) {
      if (c.type === 'chunk') {
        expect(c.content).not.toContain("I'll modify")
      }
    }
  })
})

describe('stripAnsi — partial ANSI sequence handling', () => {
  it('strips orphaned SGR parameter fragments like "5;252m"', () => {
    // This happens when an ANSI escape is split across PTY chunks:
    // Chunk 1: "text\x1b[38;" → strip-ansi removes "\x1b[38;"
    // Chunk 2: "5;252mmore text" → "5;252m" is left as orphan
    const result = stripAnsi('5;252mLet me take a look')
    expect(result).not.toContain('5;252m')
    expect(result.trim()).toContain('Let me take a look')
  })

  it('strips simple orphaned "0m" fragments', () => {
    const result = stripAnsi('0m some text here')
    expect(result).not.toMatch(/^\s*0m/)
    expect(result.trim()).toContain('some text here')
  })

  it('does not strip normal text that looks like ANSI fragments', () => {
    // "100m sprint" should NOT be mangled
    const result = stripAnsi('the 100m sprint was fast')
    expect(result).toContain('100m')
  })

  it('strips bare escape characters with incomplete sequences', () => {
    const result = stripAnsi('\x1b[\n 0m some text')
    expect(result.trim()).not.toContain('\x1b')
  })

  it('handles the exact ANSI leak from the session: \\u001b[\\n 0m', () => {
    // This is the exact sequence that leaked in the session JSON
    const result = stripAnsi('Replacing: ChatView.vue\x1b[\n 0m')
    expect(result).not.toContain('\x1b')
    expect(result.trim()).toContain('Replacing:')
  })
})

describe('KiroAdapter — message finalization', () => {
  let adapter: KiroAdapter

  beforeEach(() => {
    adapter = new KiroAdapter()
  })

  it('emits message_complete when tool output follows assistant text', () => {
    simulateStartup(adapter)
    adapter.notifyUserInput('help')

    // Assistant text
    adapter.onData('Let me check the files.')

    // Pure tool output — should trigger message_complete for the assistant text
    const r = adapter.onData('Reading file: src/App.vue (using tool: read)')
    const types = r.map(e => e.type)
    expect(types).toContain('message_complete')
    expect(types).toContain('tool_use')
  })

  it('starts a new assistant message after tool output', () => {
    simulateStartup(adapter)
    adapter.notifyUserInput('help')

    // First assistant segment
    const r1 = adapter.onData('Let me check.')
    expect(r1[0].type).toBe('chunk')

    // Tool output (finalizes first assistant message)
    adapter.onData('Reading file: src/App.vue (using tool: read)')

    // Second assistant segment — should be a NEW chunk, not appended to first
    const r3 = adapter.onData('I found the issue.')
    const chunks = r3.filter(e => e.type === 'chunk')
    expect(chunks.length).toBe(1)
    if (chunks[0].type === 'chunk') {
      expect(chunks[0].content).toContain('found the issue')
      expect(chunks[0].content).not.toContain('Let me check')
    }
  })

  it('handles multiple tool operations between assistant segments', () => {
    simulateStartup(adapter)
    adapter.notifyUserInput('analyze the project')

    // Assistant
    adapter.onData('Let me look at the structure.')

    // Multiple tool operations
    adapter.onData('Reading directory: /project (using tool: read)')
    adapter.onData('✓ Successfully read directory (42 entries)\n - Completed in 0.5s')
    adapter.onData('Reading file: /project/package.json (using tool: read)')
    adapter.onData('✓ Successfully read 1024 bytes\n - Completed in 0.1s')

    // Assistant resumes
    const r = adapter.onData('I can see this is a Node.js project.')
    const chunks = r.filter(e => e.type === 'chunk')
    expect(chunks.length).toBe(1)
    if (chunks[0].type === 'chunk') {
      expect(chunks[0].content).toContain('Node.js project')
      expect(chunks[0].content).not.toContain('Successfully')
      expect(chunks[0].content).not.toContain('Reading')
    }
  })
})
