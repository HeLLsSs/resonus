/** `@/i18n` with no dictionaries: the English text, placeholders filled in. */
export function tg(text: string, vars?: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (vars && name in vars ? String(vars[name]) : whole));
}
