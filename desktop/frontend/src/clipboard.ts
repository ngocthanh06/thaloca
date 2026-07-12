// Shared clipboard helper: every explicit "Copy" action in the app should
// go through this (instead of calling navigator.clipboard.writeText
// directly) so it's recorded in the copy history panel. Manual Cmd+C
// selections are captured separately via the native 'copy' event listener
// wired in main.ts.
import { api } from './api'

export async function copyToClipboard(text: string, source: string): Promise<void> {
  await navigator.clipboard.writeText(text)
  void api.recordClipboardCopy(text, source)
}
