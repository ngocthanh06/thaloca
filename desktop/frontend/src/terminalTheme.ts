import type { ITheme } from '@xterm/xterm'

// Explicit palette keeps ANSI output legible against Thaloca's dark surface
// and avoids xterm/browser defaults changing between releases.
export const terminalTheme: ITheme = {
  background: '#0a0e17',
  foreground: '#d8e1ee',
  cursor: '#55d697',
  cursorAccent: '#0a0e17',
  selectionBackground: '#294b46',
  black: '#182130',
  red: '#ff6b78',
  green: '#55d697',
  yellow: '#e8c581',
  blue: '#6da9ff',
  magenta: '#c792ea',
  cyan: '#5bd8e5',
  white: '#d8e1ee',
  brightBlack: '#637083',
  brightRed: '#ff8791',
  brightGreen: '#78e3ad',
  brightYellow: '#f3d999',
  brightBlue: '#8bbaff',
  brightMagenta: '#d6a6f2',
  brightCyan: '#7ce5ee',
  brightWhite: '#f5f8fc',
}
