/**
 * The little "YT" or "SC" next to a title: the track was found online by the
 * proxy in front of the server and is not in the library, or not yet. Read
 * off the id, which is the one thing the proxy leaves on such a track once
 * the words it puts in the title have been taken off (see `subsonic.ts`).
 *
 * Drawn the way the explicit badge is, beside the artist: the same box, the
 * same weight, so a row with both reads as one line of marks and not two
 * styles fighting. Nothing at all for a song of the server's own, which is
 * every song on a server with no proxy.
 */
import { Text, View } from 'react-native';

import { onlineSource } from '@/api/subsonic';
import { useT } from '@/i18n';
import { radius, themed } from '@/theme';

/** Whether the badge would draw anything, for rows that lay out around it. */
export function useOnlineBadge(id?: string): boolean {
  return onlineSource(id) !== null;
}

export function OnlineBadge({ id }: { id?: string }) {
  const t = useT();
  const source = onlineSource(id);
  if (!source) return null;
  const youtube = source === 'youtube';
  return (
    <View style={styles.badge} accessibilityLabel={youtube ? t('From YouTube') : t('From SoundCloud')}>
      <Text style={styles.letters} allowFontScaling={false}>
        {youtube ? 'YT' : 'SC'}
      </Text>
    </View>
  );
}

const styles = themed((colors) => ({
  // Two letters where the explicit badge has one, so it grows sideways and
  // keeps the height, which is what lines the two up on a row.
  badge: {
    height: 14,
    paddingHorizontal: 3,
    borderRadius: radius.sm,
    backgroundColor: colors.textMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  letters: {
    color: colors.background,
    fontSize: 9,
    fontWeight: '700',
    lineHeight: 14,
    letterSpacing: 0.5,
  },
}));
