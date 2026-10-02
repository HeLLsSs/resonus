/**
 * Ride mode: the player for a motorbike. Black, white, and four buttons a
 * glove can hit without looking; the screen stays on. Play or pause in the
 * middle, the song either side, the volume under them, and a flick across
 * the screen skips too. Nothing else: a list is not a thing to read at
 * speed.
 *
 * Opening it turns ride mode on (see `src/lib/rideSync.ts`), and the cross
 * turns it off, which is what closes the screen: the intercom disconnecting
 * closes it the same way, through `active`.
 *
 * One wide button under the rest prepares the ride: the next songs of the
 * queue downloaded before the bike leaves the network behind, with the count
 * on the button while they come (see `src/lib/ridePrepare.ts`).
 *
 * The screen goes to full brightness for the sun, and after a minute with
 * nothing touched it drops to nearly nothing: hours on a handlebar in the
 * sun at full brightness is heat and a drained battery, and a rider is
 * looking at the road. The first tap only wakes it.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useKeepAwake } from 'expo-keep-awake';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Directions, Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { COVER, songCoverUrl } from '@/api/data';
import { type Song } from '@/api/subsonic';
import { Cover } from '@/components/Cover';
import { Dialog } from '@/components/Dialog';
import { useT } from '@/i18n';
import { haptic } from '@/lib/haptics';
import { canListen, setScreenBrightness, songsToPrepare } from '@/lib/rideMode';
import { prepareRide, useRidePreparation } from '@/lib/ridePrepare';
import { activateRide, deactivateRide } from '@/lib/rideSync';
import { listenAndPlay, playRideRadio } from '@/lib/rideVoice';
import { onVolumeLevelChanged, setVolumeLevel, volumeLevel, volumeStep } from '@/lib/volumeLevel';
import { useAuthStore } from '@/store/auth';
import { useDownloads } from '@/store/downloads';
import { useNetworkType } from '@/store/networkType';
import { currentSong, useLiveInfo, usePlayerStore } from '@/store/player';
import { useRideMode } from '@/store/rideMode';
import { useSettings } from '@/store/settings';
import { useToast } from '@/store/toast';
import { spacing, useTheme } from '@/theme';

/** The screen's own colours: sunlight on a handlebar wants black and white, whatever the theme. */
const BLACK = '#000000';
const WHITE = '#FFFFFF';
const GREY = '#9A9A9A';
const BUTTON = '#1F1F1F';

const SKIP = 96;
const PLAY = 136;
const VOLUME = 76;

/** How long untouched before the screen dims. */
const DIM_AFTER_MS = 60_000;
/** The brightness while dimmed: enough to find the screen, not enough to heat it. */
const DIM_LEVEL = 0.02;

function BigButton({
  icon,
  label,
  size,
  color = BUTTON,
  iconColor = WHITE,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  size: number;
  color?: string;
  iconColor?: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { width: size, height: size, borderRadius: size / 2, backgroundColor: color },
        pressed && { opacity: 0.7 },
      ]}
    >
      <Ionicons name={icon} size={size * 0.5} color={iconColor} />
    </Pressable>
  );
}

export default function RideScreen() {
  useKeepAwake();
  const t = useT();
  const router = useRouter();
  const { accent, onAccent } = useTheme();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const landscape = width > height;

  const song = usePlayerStore(currentSong);
  const live = useLiveInfo(song);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const toggle = usePlayerStore((s) => s.toggle);
  const next = usePlayerStore((s) => s.next);
  const previous = usePlayerStore((s) => s.previous);
  const active = useRideMode((s) => s.active);
  const radioName = useRideMode((s) => s.config.radioStationName);
  const prepareCount = useRideMode((s) => s.config.prepareCount);
  const offline = useAuthStore((s) => s.offline);
  const toast = useToast((s) => s.show);
  const [voice] = useState(canListen);
  const [listening, setListening] = useState(false);
  const askVoice = () => {
    if (listening) return;
    setListening(true);
    haptic('medium');
    void listenAndPlay().finally(() => setListening(false));
  };

  // The songs the next tap on Prepare would fetch, and how far the last tap
  // has got, counted off the downloads themselves. Over mobile data the
  // songs wait in `confirming` for the word; the Wi-Fi only setting is the
  // download's own to refuse, with its own toast.
  const files = useDownloads((s) => s.files);
  const preparing = useRidePreparation((s) => s.preparing);
  const [confirming, setConfirming] = useState<Song[] | null>(null);
  const prepared = preparing ? preparing.filter((id) => files[id]).length : 0;
  const askPrepare = () => {
    if (preparing) return;
    haptic('medium');
    const { queue, index, repeat } = usePlayerStore.getState();
    const songs = songsToPrepare(queue, index, prepareCount, repeat === 'all', files);
    if (songs.length === 0) {
      toast(t('The next songs are already downloaded'));
      return;
    }
    if (useNetworkType.getState().cellular && !useSettings.getState().downloadWifiOnly) {
      setConfirming(songs);
      return;
    }
    void prepareRide(songs);
  };

  // Opened by hand, from the settings or a shortcut: that is ride mode on.
  // Opened by the intercom it already is, and this does nothing.
  useEffect(() => {
    void activateRide('manual');
  }, []);
  // Off, by the cross or the intercom going away, closes the screen. Once it
  // has been on: the first render is before the effect above has run.
  const wasActive = useRef(false);
  useEffect(() => {
    if (active) {
      wasActive.current = true;
      return;
    }
    if (!wasActive.current) return;
    wasActive.current = false;
    if (router.canGoBack()) router.back();
    else router.replace('/(tabs)');
  }, [active, router]);

  // Full brightness while the screen is up and awake, the phone's own again
  // on the way out. The timer restarts at every touch and is not a state of
  // its own: only the dimming is drawn.
  const [dimmed, setDimmed] = useState(false);
  const dimTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const armDim = () => {
    if (dimTimer.current) clearTimeout(dimTimer.current);
    dimTimer.current = setTimeout(() => setDimmed(true), DIM_AFTER_MS);
  };
  const wake = () => {
    armDim();
    setDimmed(false);
  };
  useEffect(() => {
    setScreenBrightness(dimmed ? DIM_LEVEL : 1);
  }, [dimmed]);
  useEffect(() => {
    armDim();
    return () => {
      if (dimTimer.current) clearTimeout(dimTimer.current);
      setScreenBrightness(-1);
    };
  }, []);

  const [level, setLevel] = useState(volumeLevel);
  useEffect(() => onVolumeLevelChanged(setLevel), []);
  const bump = (direction: -1 | 1) => {
    const target = Math.max(0, Math.min(1, level + direction * volumeStep()));
    setVolumeLevel(target);
    setLevel(target);
    haptic('light');
  };

  const skip = (action: () => void) => {
    haptic('medium');
    action();
  };
  const flingLeft = Gesture.Fling()
    .direction(Directions.LEFT)
    .runOnJS(true)
    .onEnd((_e, success) => {
      if (success) skip(next);
    });
  const flingRight = Gesture.Fling()
    .direction(Directions.RIGHT)
    .runOnJS(true)
    .onEnd((_e, success) => {
      if (success) skip(previous);
    });

  const title = live?.title ?? song?.title ?? t('Nothing playing');
  const artist = live?.artist ?? song?.artist ?? '';
  const cover = song ? songCoverUrl(song, COVER.card) : undefined;
  const coverSize = Math.round(Math.min(landscape ? height * 0.55 : width * 0.5, 320));

  return (
    <View
      style={[
        styles.root,
        {
          paddingTop: insets.top + spacing.md,
          paddingBottom: insets.bottom + spacing.lg,
          paddingLeft: insets.left + spacing.lg,
          paddingRight: insets.right + spacing.lg,
        },
      ]}
      // Every touch restarts the dimming; the screen is not taken over, the
      // touch goes on to whatever was under it.
      onTouchStart={wake}
    >
      <GestureDetector gesture={Gesture.Race(flingLeft, flingRight)}>
        <View style={[styles.body, landscape && styles.bodyLandscape]}>
          <View style={styles.coverBox}>
            <Cover
              uri={cover}
              size={coverSize}
              rounded
              placeholderIcon={song?.url ? 'radio' : 'musical-notes'}
            />
          </View>
          <View style={styles.panel}>
            <Text style={styles.title} numberOfLines={2}>
              {title}
            </Text>
            <Text style={styles.artist} numberOfLines={1}>
              {artist}
            </Text>
            <View style={styles.transport}>
              <BigButton icon="play-skip-back" label={t('Previous')} size={SKIP} onPress={() => skip(previous)} />
              <BigButton
                icon={isPlaying ? 'pause' : 'play'}
                label={isPlaying ? t('Pause') : t('Play')}
                size={PLAY}
                color={accent}
                iconColor={onAccent}
                onPress={toggle}
              />
              <BigButton icon="play-skip-forward" label={t('Next')} size={SKIP} onPress={() => skip(next)} />
            </View>
            <View style={styles.volumeRow}>
              <BigButton icon="volume-low" label={t('Volume down')} size={VOLUME} onPress={() => bump(-1)} />
              <View style={styles.volumeBar}>
                <View style={[styles.volumeFill, { width: `${Math.round(level * 100)}%` }]} />
              </View>
              <BigButton icon="volume-high" label={t('Volume up')} size={VOLUME} onPress={() => bump(1)} />
            </View>
            {/* The two ways to music with no list: a word said into the
                helmet, and the one station chosen in the settings. Each only
                when the phone, or the settings, can answer for it. */}
            {voice || radioName ? (
              <View style={styles.shortcuts}>
                {voice ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('Voice')}
                    onPress={askVoice}
                    style={({ pressed }) => [styles.shortcut, (pressed || listening) && { opacity: 0.7 }]}
                  >
                    <Ionicons name="mic" size={36} color={WHITE} />
                    <Text style={styles.shortcutText}>{t('Voice')}</Text>
                  </Pressable>
                ) : null}
                {radioName ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={radioName}
                    onPress={() => {
                      haptic('medium');
                      void playRideRadio();
                    }}
                    style={({ pressed }) => [styles.shortcut, pressed && { opacity: 0.7 }]}
                  >
                    <Ionicons name="radio" size={36} color={WHITE} />
                    <Text style={styles.shortcutText} numberOfLines={1}>
                      {radioName}
                    </Text>
                  </Pressable>
                ) : null}
              </View>
            ) : null}
            {/* Nothing to fetch without a server or a queue; a button that
                could only say so would be a button for nothing. */}
            {!offline && song ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={t('Prepare the ride')}
                onPress={askPrepare}
                style={({ pressed }) => [styles.shortcut, styles.prepare, (pressed || preparing) && { opacity: 0.7 }]}
              >
                <Ionicons name="cloud-download-outline" size={36} color={WHITE} />
                <Text style={styles.shortcutText} numberOfLines={1}>
                  {preparing ? `${t('Preparing the ride')}  ${prepared} / ${preparing.length}` : t('Prepare the ride')}
                </Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      </GestureDetector>
      <Dialog
        visible={confirming !== null}
        title={t('Download on mobile data?')}
        message={t('{n} songs will be downloaded over mobile data.', { n: confirming?.length ?? 0 })}
        confirmLabel={t('Download')}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          const songs = confirming;
          setConfirming(null);
          if (songs) void prepareRide(songs);
        }}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('Exit ride mode')}
        onPress={deactivateRide}
        style={({ pressed }) => [styles.exit, { top: insets.top + spacing.sm }, pressed && { opacity: 0.7 }]}
      >
        <Ionicons name="close" size={36} color={WHITE} />
      </Pressable>
      {/* Dimmed, the first tap is the screen waking up and nothing else: a
          glove reaching for the play button in the dark would find it. */}
      {dimmed ? <Pressable style={StyleSheet.absoluteFill} onPress={wake} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: BLACK },
  body: { flex: 1, justifyContent: 'center', gap: spacing.lg },
  bodyLandscape: { flexDirection: 'row', alignItems: 'center', gap: spacing.xl },
  coverBox: { alignItems: 'center', justifyContent: 'center' },
  panel: { flex: 1, justifyContent: 'center', gap: spacing.md },
  title: { color: WHITE, fontSize: 34, fontWeight: '800', textAlign: 'center', lineHeight: 40 },
  artist: { color: GREY, fontSize: 24, fontWeight: '600', textAlign: 'center' },
  transport: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.lg,
    marginTop: spacing.md,
  },
  button: { alignItems: 'center', justifyContent: 'center' },
  volumeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginTop: spacing.md },
  volumeBar: { flex: 1, height: 12, borderRadius: 6, backgroundColor: BUTTON, overflow: 'hidden' },
  volumeFill: { height: '100%', backgroundColor: WHITE },
  shortcuts: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.md },
  shortcut: {
    flex: 1,
    height: 72,
    borderRadius: 36,
    backgroundColor: BUTTON,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
  },
  shortcutText: { color: WHITE, fontSize: 22, fontWeight: '700', flexShrink: 1 },
  prepare: { flex: 0, marginTop: spacing.md },
  exit: {
    position: 'absolute',
    right: spacing.md,
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: BUTTON,
  },
});
