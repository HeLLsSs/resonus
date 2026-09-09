/**
 * Full-screen cover viewer (desktop Spotify style): tapping the cover opens it
 * enlarged and centered on a dark background. Closes by tapping anywhere or
 * with the back button. Supports actions below the image (e.g. "Change cover"
 * on playlists) and child dialogs.
 */
import { Image } from 'expo-image';
import { type ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, useWindowDimensions } from 'react-native';

import { serverImageSource } from '@/api/data';
import { radius, spacing } from '@/theme';

export function CoverViewer({
  uri,
  visible,
  onClose,
  footer,
  children,
  square = true,
}: {
  uri?: string;
  visible: boolean;
  onClose: () => void;
  /** Actions below the image; tapping them doesn't close the viewer. */
  footer?: ReactNode;
  /** Extra content inside the Modal (e.g. a password Dialog). */
  children?: ReactNode;
  /** Covers are square and fill a square box. Artist photos arrive in any
   *  shape, so they get the whole area and keep their own proportions. */
  square?: boolean;
}) {
  const { width, height } = useWindowDimensions();
  // As large as possible without touching the edges.
  const maxW = width - spacing.lg * 2;
  const maxH = height * 0.72;
  const size = Math.min(maxW, maxH);

  return (
    <Modal
      transparent
      statusBarTranslucent
      visible={visible}
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityRole="button">
        <Image
          source={uri ? serverImageSource(uri) : undefined}
          // Not square: the box is the whole area and `contain` fits the image
          // inside it, so nothing is cropped whatever its shape. No radius
          // there — the corners would be the box's, not the image's.
          style={
            square
              ? { width: size, height: size, borderRadius: radius.lg }
              : { width: maxW, height: maxH }
          }
          contentFit="contain"
          transition={150}
        />
        {footer ? (
          // Pressable without onPress: absorbs the touch so that tapping
          // between the footer buttons doesn't close the viewer via backdrop.
          <Pressable style={styles.footer}>{footer}</Pressable>
        ) : null}
      </Pressable>
      {children}
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    // Near-black in both appearances, and not a theme colour: this is a picture
    // being looked at, and what a picture wants around it is the dark of a room
    // with the lights off. Whatever a caller puts in `footer` has to be drawn
    // in `onArtwork` for the same reason.
    backgroundColor: 'rgba(0,0,0,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  footer: {
    marginTop: spacing.xl * 2,
    alignItems: 'center',
    gap: spacing.lg,
  },
});
