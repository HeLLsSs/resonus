/**
 * Folding text so that two spellings of one name compare equal.
 *
 * Shared rather than kept where it was first needed: the car's search box, the
 * fuzzy search and the screens all have to fold a name the same way, and a
 * second copy of these four lines is a second set of rules nobody remembers to
 * keep in step.
 */

/** Lowercase, unaccented and single-spaced, the way the native side folds what
 *  was said: "bjork" is Björk in both places. */
export function fold(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
