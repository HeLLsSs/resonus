/**
 * Full-screen lyrics page (expanded from the player card), Spotify-style:
 * background from the cover's dominant color, karaoke with tap-line-to-seek
 * and basic controls (progress and play/pause) at the bottom.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { COVER, serverImageSource, songCoverUrl } from '@/api/data';
import { Cover } from '@/components/Cover';
import { lyricsStyles, SyncedLyricsView } from '@/components/LyricsCard';
import { SeekBar } from '@/components/SeekBar';
import { useDominantColor } from '@/hooks/useDominantColor';
import { useLyrics } from '@/hooks/useLyrics';
import { useT } from '@/i18n';
import { currentSong, usePlayerStore } from '@/store/player';
import { useSettings } from '@/store/settings';
import { colors, fontSize, radius, spacing, themed, useTheme } from '@/theme';
import { centredPadding, useScreenSize } from '@/hooks/useScreenSize';

export default function LyricsScreen() {
  // Repaints on a change of appearance or accent: a stack keeps this screen
  // mounted while you are on another one, out of reach of anything else.
  useTheme();
  const router = useRouter();
  const t = useT();
  const { width, landscape } = useScreenSize();
  const song = usePlayerStore(currentSong);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const durationSec = usePlayerStore((s) => s.durationSec);
  const toggle = usePlayerStore((s) => s.toggle);
  const previous = usePlayerStore((s) => s.previous);
  const next = usePlayerStore((s) => s.next);
  const { data, isLoading } = useLyrics(song ?? undefined);
  const background = useSettings((s) => s.lyricsBackground);
  const wordLyrics = useSettings((s) => s.wordLyrics);
  const cover = song ? songCoverUrl(song, COVER.card) : undefined;
  // Only extract the palette when it's actually going to be used.
  const dominant = useDominantColor(background === 'color' ? cover : undefined);
  const bg = background === 'color' ? dominant : colors.background;
  // No edge fade over the artwork: that effect paints a gradient from a SOLID
  // colour, and with an image behind there is no colour to fade into — it came
  // out as two black bands with hard edges, only as wide as the lyrics body.
  // The scrim already keeps the text readable, so the fade just goes away.
  const fadeColor = background === 'cover' ? undefined : bg;
  const duration = durationSec || song?.duration || 0;
  const insets = useSafeAreaInsets();
  // Inside a full-screen modal iOS reports no top inset, and the close
  // button would sit against the edge.
  const topPad = insets.top > 0 ? insets.top : 12;
  // On a phone on its side the lyrics have four hundred points of height and
  // a cover on top of them would take half of it, so the cover goes beside
  // them instead, on the left, and the lyrics and the controls share the rest
  // (the player lays itself out the same way, #131). The cover is a square as
  // big as its column allows, and the column is measured rather than worked
  // out from the screen: the header and the insets have taken their share
  // before it is drawn.
  const [coverBox, setCoverBox] = useState({ width: 0, height: 0 });
  const coverSize = Math.min(coverBox.width, coverBox.height) - spacing.xl * 2;

  return (
    <View style={[styles.root, { backgroundColor: bg }]}>
      {background === 'cover' && cover ? (
        <>
          {/* Same as the player: no `recyclingKey`, or the change of song
              blanks this to black before the next cover arrives. */}
          <Image
            source={serverImageSource(cover)}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            blurRadius={60}
            transition={600}
          />
          {/* Same wash as the player: blur alone doesn't guarantee the lyrics
              stay readable over a bright cover, and which way it washes
              follows the appearance. */}
          <View style={styles.coverScrim} />
        </>
      ) : null}
      <View style={[styles.safe, { paddingTop: topPad, paddingBottom: insets.bottom }]}>
      <View style={styles.header}>
        <Pressable hitSlop={12} accessibilityRole="button" accessibilityLabel={t('Close')} onPress={() => router.back()}>
          <Ionicons name="close" size={26} color={colors.text} />
        </Pressable>
        <View style={styles.titleBox}>
          <Text style={styles.title} numberOfLines={1}>
            {song?.title ?? t('Lyrics')}
          </Text>
          {song?.artist ? (
            <Text style={styles.artist} numberOfLines={1}>
              {song.artist}
            </Text>
          ) : null}
        </View>
        <View style={{ width: 26 }} />
      </View>

      <View style={landscape ? styles.pageColumns : styles.pageStack}>
      {landscape ? (
        <View
          style={styles.coverColumn}
          onLayout={(e) => setCoverBox(e.nativeEvent.layout)}
        >
          {coverSize > 0 ? (
            /* No `transition`: this only ever draws the song that is playing,
               and a fade on the way in is a fade over the same picture blurred
               on the wall behind it. */
            <Cover uri={cover} size={coverSize} transition={0} />
          ) : null}
        </View>
      ) : null}
      <View style={styles.pageStack}>
      {/* Lyrics are a column of text: across a tablet a line runs the whole
          width and the eye loses the next one on the way back (#131). Beside
          the cover the column is already narrow, and the padding is only the
          page's own. */}
      <View
        style={[
          styles.body,
          { paddingHorizontal: landscape ? spacing.xl : centredPadding(width, spacing.xl) },
        ]}
      >
        {isLoading ? (
          <ActivityIndicator style={{ marginTop: spacing.xxl }} color={colors.text} />
        ) : data?.synced ? (
          <SyncedLyricsView lines={data.lines} large fadeColor={fadeColor} highlightWords={wordLyrics} />
        ) : data ? (
          <ScrollView contentContainerStyle={styles.plainContent} showsVerticalScrollIndicator={false}>
            <Text style={[lyricsStyles.line, lyricsStyles.lineLarge]}>
              {data.lines.map((l) => l.value).join('\n')}
            </Text>
          </ScrollView>
        ) : (
          <Text style={styles.empty}>{t('No lyrics available for this song.')}</Text>
        )}
      </View>

      <View style={styles.controls}>
        <SeekBar duration={duration} />
        <View style={styles.buttons}>
          <Pressable
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={t('Previous')}
            onPress={previous}
          >
            <Ionicons name="play-skip-back" size={32} color={colors.text} />
          </Pressable>
          <Pressable
            style={styles.playButton}
            accessibilityRole="button"
            accessibilityLabel={isPlaying ? t('Pause') : t('Play')}
            onPress={toggle}
          >
            <Ionicons
              name={isPlaying ? 'pause' : 'play'}
              size={30}
              color={colors.onInverse}
              style={!isPlaying && { marginLeft: 3 }}
            />
          </Pressable>
          <Pressable
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={t('Next')}
            onPress={next}
          >
            <Ionicons name="play-skip-forward" size={32} color={colors.text} />
          </Pressable>
        </View>
      </View>
      </View>
      </View>
      </View>
    </View>
  );
}

const styles = themed((colors) => ({
  root: { flex: 1, backgroundColor: colors.background },
  safe: { flex: 1 },
  coverScrim: { ...StyleSheet.absoluteFill, backgroundColor: colors.coverWash },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.md,
  },
  titleBox: { flex: 1, alignItems: 'center' },
  /** The lyrics and the controls, one under the other, as they have always
   *  been. `minHeight: 0` is what lets a flex child shrink below its content:
   *  without it the lyrics push the controls off the bottom of a short screen. */
  pageStack: { flex: 1, minHeight: 0 },
  /** The same, with the cover in a column of its own beside them (#131). */
  pageColumns: { flex: 1, minHeight: 0, flexDirection: 'row', alignItems: 'stretch' },
  /** About two fifths of the width, the way the player splits itself, with the
   *  cover in the middle of it. */
  coverColumn: { width: '40%', alignItems: 'center', justifyContent: 'center' },
  title: { color: colors.text, fontSize: fontSize.md, fontWeight: '700' },
  artist: { color: colors.textSecondary, fontSize: fontSize.xs },
  body: { flex: 1 },
  plainContent: { paddingVertical: spacing.lg, paddingBottom: spacing.xxl },
  empty: {
    color: colors.textSecondary,
    fontSize: fontSize.md,
    textAlign: 'center',
    marginTop: spacing.xxl,
    paddingHorizontal: spacing.xl,
  },
  controls: { paddingHorizontal: spacing.xl, paddingBottom: spacing.md },
  buttons: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.xxl,
    marginTop: spacing.sm,
  },
  playButton: {
    width: 60,
    height: 60,
    borderRadius: radius.pill,
    backgroundColor: colors.text,
    alignItems: 'center',
    justifyContent: 'center',
  },
}));
