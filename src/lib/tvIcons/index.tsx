/**
 * Icons, at the size the screen deserves.
 *
 * The type ladder is scaled for a television in one place (`theme`), but an
 * icon carries its size as a number on the spot — `size={22}` — in some four
 * hundred places across seventy-six files. Left alone they stay at phone size
 * beside text that has grown by half, which reads as an app whose icons have
 * shrunk.
 *
 * Rather than visit four hundred call sites and ask every screen written after
 * today to remember, Metro is told that `@expo/vector-icons/Ionicons` means
 * this file (see `metro.config.js`). It is the real icon with its size run
 * through the same scaling as the rest, and nothing at all on a phone, where
 * the factor is one.
 *
 * The wrapper imports the package's build path rather than its entry point,
 * which is what keeps the redirection from pointing at itself.
 */
import Ionicons from '@expo/vector-icons/build/Ionicons';
import MaterialCommunityIcons from '@expo/vector-icons/build/MaterialCommunityIcons';
import MaterialIcons from '@expo/vector-icons/build/MaterialIcons';
import { createElement, type ComponentType } from 'react';

import { TV_TEXT, tvScale } from '@/lib/tv';

/** The default `@expo/vector-icons` uses when nothing says otherwise. */
const DEFAULT_SIZE = 24;

function scaled<P extends { size?: number }>(Icon: ComponentType<P>, named: string) {
  function TvIcon(props: P) {
    return createElement(Icon, { ...props, size: tvScale(props.size ?? DEFAULT_SIZE, TV_TEXT) });
  }
  // Kept so a stack trace still names the icon set it came from.
  TvIcon.displayName = `Tv(${named})`;
  return TvIcon;
}

export const TvIonicons = scaled(Ionicons, 'Ionicons');
export const TvMaterialCommunityIcons = scaled(MaterialCommunityIcons, 'MaterialCommunityIcons');
export const TvMaterialIcons = scaled(MaterialIcons, 'MaterialIcons');
