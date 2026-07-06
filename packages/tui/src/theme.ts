import { SyntaxStyle } from "@opentui/core"

/** Main body text: slightly grey so emphasis can pop white. */
export const BODY = "#c9c9c9"
/** Emphasis (bold/italic/headings): full bright. */
export const BRIGHT = "#ffffff"
/** Secondary/chrome text (headers, footer, queue meta, section headings). */
export const DIM = "#9a9a9a"
/** Extra-faint text (answered rows, section labels). */
export const FAINT = "#6f6f6f"
/** Borders / gutters. */
export const GUTTER = "#4a4a4a"
/** Subtle accent (inline code). */
export const ACCENT = "#8ab4d8"
/** Queue highlight background when the queue has focus. */
export const HIGHLIGHT_BG = "#3a3a3a"
/** Queue highlight background when the composer has focus (muted). */
export const HIGHLIGHT_BG_MUTED = "#262626"
/** Banner / attention background block. */
export const BANNER_BG = "#2e2e2e"
/** Sidebar paint: rgb(10,10,10), edge to edge. */
export const SIDEBAR_BG = "#0a0a0a"
/** Main-area paint: rgb(21,26,29), edge to edge including the footer row. */
export const MAIN_BG = "#151a1d"
/** Faded border for the unfocused composer. */
export const GUTTER_FADED = "#333333"
/** Presence: live/working agent marker (muted green). */
export const LIVE = "#6f9f6f"
/** Presence: needs-attention marker (muted amber). */
export const ATTENTION = "#d8a15f"

let syntax: SyntaxStyle | undefined
let syntaxDim: SyntaxStyle | undefined

/**
 * Markdown syntax theme, Claude Code style: body text slightly grey (BODY),
 * emphasis pops at full bright. Lazily created because SyntaxStyle touches
 * the native render lib.
 */
export function markdownSyntax(): SyntaxStyle {
  syntax ??= SyntaxStyle.fromTheme([
    { scope: ["default"], style: { foreground: BODY } },
    { scope: ["markup.strong"], style: { foreground: BRIGHT, bold: true } },
    { scope: ["markup.italic"], style: { foreground: BRIGHT, italic: true } },
    { scope: ["markup.heading"], style: { foreground: BRIGHT, bold: true } },
    { scope: ["markup.raw"], style: { foreground: ACCENT } },
    { scope: ["markup.list"], style: { foreground: DIM } },
    { scope: ["markup.quote"], style: { foreground: DIM } },
    { scope: ["markup.link"], style: { underline: true } },
    { scope: ["markup.link.url"], style: { foreground: DIM } },
    { scope: ["conceal"], style: { foreground: FAINT } },
  ])
  return syntax
}

/**
 * Attenuated markdown theme for the main pane while the queue has focus:
 * everything drops a full shade (to FAINT) so the focused pane visibly wins.
 */
export function markdownSyntaxDim(): SyntaxStyle {
  syntaxDim ??= SyntaxStyle.fromTheme([
    { scope: ["default"], style: { foreground: FAINT } },
    { scope: ["markup.strong"], style: { foreground: FAINT, bold: true } },
    { scope: ["markup.italic"], style: { foreground: FAINT, italic: true } },
    { scope: ["markup.heading"], style: { foreground: FAINT, bold: true } },
    { scope: ["markup.raw"], style: { foreground: FAINT } },
    { scope: ["markup.list"], style: { foreground: FAINT } },
    { scope: ["markup.quote"], style: { foreground: FAINT } },
    { scope: ["markup.link"], style: { foreground: FAINT, underline: true } },
    { scope: ["markup.link.url"], style: { foreground: FAINT } },
    { scope: ["conceal"], style: { foreground: FAINT } },
  ])
  return syntaxDim
}
