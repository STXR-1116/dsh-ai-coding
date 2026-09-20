/** Shared transcript helpers for the knowledge and memory lifecycle loops. */

/**
 * Extract visible text from a session message.
 * @param message - Session message content blocks to inspect.
 * @returns Concatenated text, or undefined when no text block has content.
 */
export function textOf(message: { readonly content: readonly { readonly type: string; readonly text?: string }[] }): string | undefined {
  const text = message.content
    .filter(block => block.type === 'text')
    .map(block => block.text ?? '')
    .join('')
  return text.length === 0 ? undefined : text
}
