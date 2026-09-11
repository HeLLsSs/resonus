/**
 * Self-contained bottom sheet: its visibility lives here and is opened
 * imperatively via `openRef`, so showing/hiding it does NOT re-render the
 * screen (with its list) that declares it — with state in the screen, opening
 * the menu had a noticeable delay. The content comes as a function receiving
 * `close` to close after choosing an action.
 *
 * Slides up and down and closes with a swipe, like the song menu: these menus
 * open the same way and from the same ⋯, so they behave the same way too.
 */
import { type MutableRefObject, type ReactNode, useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useBottomSheetAnim } from '@/hooks/useBottomSheetAnim';
import { useScreenSize } from '@/hooks/useScreenSize';
import { radius, SHEET_MAX_WIDTH, spacing, themed } from '@/theme';

/** How much of a scrolling sheet opens at once. Enough that the short ones
 *  never scroll at all, and little enough that a phone lying on its side is
 *  not swallowed whole by a menu (#131). */
function contentMaxH(height: number): number {
  return Math.round(height * 0.62);
}

export function SheetModal({
  openRef,
  onClosed,
  scrolls,
  children,
}: {
  /** The screen holds a ref and calls `openRef.current()` to open. */
  openRef: MutableRefObject<() => void>;
  /** Runs once the sheet is off screen, however it was closed. For an action
   *  that unmounts the sheet along with whatever declares it. */
  onClosed?: () => void;
  /**
   * For content that can outgrow the screen: it scrolls, and the swipe that
   * dismisses the sheet moves to the grabber, which is the one part of it that
   * is not the list. Without that the two gestures fight and the list wins
   * about half the time (the song menu settles the same argument, at more
   * length, because there the list is only part of the sheet).
   */
  scrolls?: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const { height } = useScreenSize();
  const [open, setOpen] = useState(false);
  // Handed over once mounted, as a ref is written: the screen only calls it
  // from a press, long after.
  useEffect(() => {
    openRef.current = () => setOpen(true);
  }, [openRef]);

  const closeNow = () => {
    setOpen(false);
    onClosed?.();
  };
  const { dismiss, pan, backdropStyle, sheetStyle, onSheetLayout } = useBottomSheetAnim(
    open,
    closeNow,
  );
  // The sheet slides down and only then is the Modal unmounted. Actions close
  // through here, so choosing one looks the same as swiping it away.
  const close = () => dismiss(closeNow);

  return (
    <Modal transparent animationType="none" visible={open} onRequestClose={close}>
      {/* Gestures inside an RN Modal need a root view of their own: the Modal
          renders in a native hierarchy outside the app's. */}
      <GestureHandlerRootView style={StyleSheet.absoluteFill}>
        <Animated.View style={[styles.backdrop, backdropStyle]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={close} />
        </Animated.View>
        {scrolls ? (
          <Animated.View
            style={[styles.sheet, { paddingBottom: insets.bottom + spacing.md }, sheetStyle]}
            onLayout={onSheetLayout}
          >
            {/* The grabber carries the drag on its own here, and its box is
                made tall enough to be worth aiming at now that it is the
                only way to swipe the sheet away. */}
            <GestureDetector gesture={pan}>
              <View style={styles.grabberArea}>
                <View style={styles.grabber} />
              </View>
            </GestureDetector>
            <ScrollView
              style={{ maxHeight: contentMaxH(height) }}
              showsVerticalScrollIndicator={false}
            >
              {children(close)}
            </ScrollView>
          </Animated.View>
        ) : (
          /* One drag around everything: what goes in here is a short list of
             actions that never scrolls, so nothing else competes for the
             gesture (the song menu needs two because its list does scroll). */
          <GestureDetector gesture={pan}>
            <Animated.View
              style={[styles.sheet, { paddingBottom: insets.bottom + spacing.md }, sheetStyle]}
              onLayout={onSheetLayout}
            >
              {/* Spotify-style grabber: the visual cue that the sheet can be
                  dragged down to dismiss. */}
              <View style={styles.grabber} />
              {children(close)}
            </Animated.View>
          </GestureDetector>
        )}
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = themed((colors) => ({
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: colors.backdrop },
  sheet: {
    position: 'absolute',
    bottom: 0,
    // Centred and no wider than a sheet wants to be (#131).
    alignSelf: 'center',
    width: '100%',
    maxWidth: SHEET_MAX_WIDTH,
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xxl,
    borderTopRightRadius: radius.xxl,
    paddingHorizontal: spacing.lg,
    // Smaller than the old spacing.lg because the grabber below already brings
    // its own margin: together they add up to the same top gap as before.
    paddingTop: spacing.sm,
  },
  // Where the drag is caught when the content below scrolls: the handle plus
  // the gap around it, so the finger has something to land on.
  grabberArea: { paddingTop: spacing.xs, paddingBottom: spacing.xs },
  // Spotify's little handle. Its only job is to advertise the drag gesture, so
  // it stays discreet: it must read as an affordance, not as a control.
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.textMuted,
    opacity: 0.5,
    marginBottom: spacing.md,
  },
}));
