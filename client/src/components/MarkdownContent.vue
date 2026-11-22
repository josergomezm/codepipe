<script setup lang="ts">
import { computed } from 'vue'
import { renderMarkdown, type RenderEnv } from '@/lib/markdown'

/**
 * Rendered markdown with CodePipe's typography (see `.md` in style.css):
 * scrollable tables, code blocks with a copy button, and file references
 * that emit `open-file` when clicked.
 */
const props = defineProps<{ source: string; env?: RenderEnv; compact?: boolean }>()
const emit = defineEmits<{ 'open-file': [path: string] }>()

const html = computed(() => renderMarkdown(props.source, props.env))

async function onClick(e: MouseEvent) {
  const target = e.target as HTMLElement | null
  if (!target) return

  const copyBtn = target.closest<HTMLElement>('[data-copy]')
  if (copyBtn) {
    const code = copyBtn.closest('.md-code')?.querySelector('code')?.textContent ?? ''
    try {
      await navigator.clipboard.writeText(code)
      copyBtn.textContent = 'Copied'
    } catch {
      copyBtn.textContent = 'Copy failed'
    }
    setTimeout(() => (copyBtn.textContent = 'Copy'), 1500)
    return
  }

  const fileEl = target.closest<HTMLElement>('[data-file-path]')
  if (fileEl) {
    // Let ctrl/cmd-click etc. on a plain link fall through untouched.
    if (fileEl.tagName === 'A' && (e.metaKey || e.ctrlKey || e.shiftKey)) return
    e.preventDefault()
    emit('open-file', fileEl.dataset.filePath!)
  }
}
</script>

<template>
  <!-- eslint-disable-next-line vue/no-v-html -- markdown-it with html:false -->
  <div class="md" :class="{ 'md-compact': compact }" @click="onClick" v-html="html" />
</template>
