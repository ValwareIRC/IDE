// The fonts Prism offers in its pickers: the ones that come with it, then what is installed on this computer.
import type { SelectOption } from '@/components/Select'

export const BUNDLED_UI: Array<{ value: string; label: string; sub: string }> = [
  { value: 'Inter Variable', label: 'Inter', sub: 'Clean and neutral' },
  { value: 'Nunito Variable', label: 'Nunito', sub: 'Rounded and friendly' },
  { value: 'Space Grotesk Variable', label: 'Space Grotesk', sub: 'A little futuristic' },
  { value: 'JetBrains Mono Variable', label: 'JetBrains Mono', sub: 'Everything in code lettering' },
  { value: 'Fixedsys Excelsior', label: 'Fixedsys Excelsior', sub: 'The old Windows system font; sharpest at 16' }
]

export const BUNDLED_MONO: Array<{ value: string; label: string; sub: string }> = [
  { value: 'JetBrains Mono Variable', label: 'JetBrains Mono', sub: 'Comes with Prism' },
  { value: 'Fixedsys Excelsior', label: 'Fixedsys Excelsior', sub: 'Pixel font, sharpest at size 16' }
]

export const LOOKS_MONO = /mono|code|consol|courier|fixed|terminal|hack|fira|cascadia|menlo|iosevka|lucida console|ocr/i

/** Bundled fonts first, then this computer's, code-looking ones first for code. */
export function fontOptions(installed: string[], mono: boolean): Array<SelectOption<string>> {
  const bundled = (mono ? BUNDLED_MONO : BUNDLED_UI).map((f) => ({ ...f, group: 'Comes with Prism' }))
  const rest = installed.filter((f) => !bundled.some((b) => b.label === f || b.value === f))
  const likely = mono ? rest.filter((f) => LOOKS_MONO.test(f)) : []
  const others = rest.filter((f) => !likely.includes(f))
  return [...bundled, ...likely.map((f) => ({ value: f, label: f, group: 'Code fonts on this computer' })), ...others.map((f) => ({ value: f, label: f, group: mono ? 'Other fonts on this computer' : 'On this computer' }))]
}

/** Wait for a font to be ready before measuring text with it (the terminal sizes its cells once). */
export async function fontReady(family: string, px = 16): Promise<void> {
  try {
    await document.fonts.load(`${px}px "${family.replace(/"/g, '')}"`)
  } catch {
    /* not a web font, or not available: the fallback is used */
  }
}
