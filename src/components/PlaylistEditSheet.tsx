/** Sheet to edit a playlist: cover, name, description, and visibility. */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Cover } from '@/components/Cover';
import { Dialog } from '@/components/Dialog';
import { useServerCover } from '@/hooks/useServerCover';
import { useT } from '@/i18n';
import { colors, fontSize, radius, spacing, themed } from '@/theme';

export interface PlaylistEdit {
  name: string;
  comment: string;
  public: boolean;
}

interface Props {
  visible: boolean;
  initial: PlaylistEdit;
  coverUri?: string;
  /** Hides the public playlist toggle (e.g. in local mode, no server). */
  hidePublic?: boolean;
  /**
   * Server playlist ID: enables changing the cover with a local image
   * (Navidrome native API >= 0.61). Navidrome profiles only.
   */
  coverUploadId?: string;
  /**
   * Local profile playlist ID: enables changing the cover by copying the image
   * to the app's storage (no server involved).
   */
  localCoverId?: string;
  onCancel: () => void;
  onSave: (changes: PlaylistEdit) => void;
}

export function PlaylistEditSheet({
  visible,
  initial,
  coverUri,
  hidePublic,
  coverUploadId,
  localCoverId,
  onCancel,
  onSave,
}: Props) {
  const t = useT();
  const [name, setName] = useState(initial.name);
  const [comment, setComment] = useState(initial.comment);
  const [isPublic, setIsPublic] = useState(initial.public);
  // Cover change (upload/copy, inline error, and password dialog): logic
  // shared with the cover viewer. Error is inline because a toast would be
  // hidden under this Modal.
  const cover = useServerCover({ coverUploadId, localCoverId });
  const { reset: resetCover } = cover;

  // Resets fields every time it opens (or when what it opened on changes under
  // it). While rendering rather than from an effect, so the old values never
  // get a frame on screen first.
  const [opened, setOpened] = useState({ visible, ...initial });
  if (
    opened.visible !== visible ||
    opened.name !== initial.name ||
    opened.comment !== initial.comment ||
    opened.public !== initial.public
  ) {
    setOpened({ visible, ...initial });
    if (visible) {
      setName(initial.name);
      setComment(initial.comment);
      setIsPublic(initial.public);
      resetCover();
    }
  }

  const canSave = name.trim().length > 0;

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onCancel}
    >
      <SafeAreaView style={styles.safe} edges={['top']}>
        <View style={styles.header}>
          <Pressable hitSlop={12} onPress={onCancel}>
            <Text style={[styles.headerAction, { color: colors.accent }]}>{t('Cancel')}</Text>
          </Pressable>
          <Text style={styles.title}>{t('Edit playlist')}</Text>
          <Pressable
            hitSlop={12}
            disabled={!canSave}
            onPress={() => onSave({ name: name.trim(), comment: comment.trim(), public: isPublic })}
          >
            <Text style={[styles.headerAction, { color: colors.accent }, !canSave && styles.disabled]}>{t('Save')}</Text>
          </Pressable>
        </View>

        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            <View style={styles.coverWrap}>
              {cover.enabled ? (
                <>
                  <Pressable
                    onPress={() => void cover.pickAndUpload()}
                    disabled={cover.uploading}
                    accessibilityRole="button"
                    accessibilityLabel={t('Change cover')}
                    style={({ pressed }) => pressed && { opacity: 0.7 }}
                  >
                    <Cover uri={cover.pickedUri ?? coverUri} size={160} />
                    {cover.uploading ? (
                      <View style={styles.coverOverlay}>
                        <ActivityIndicator color={colors.onArtwork} />
                      </View>
                    ) : (
                      <View style={styles.coverBadges}>
                        <View style={styles.coverBadge}>
                          <Ionicons name="camera" size={16} color={colors.onArtwork} />
                        </View>
                        <Pressable
                          hitSlop={6}
                          accessibilityRole="button"
                          accessibilityLabel={t('Remove cover')}
                          onPress={() => void cover.removeCover()}
                          style={({ pressed }) => [styles.coverBadge, pressed && { opacity: 0.7 }]}
                        >
                          <Ionicons name="trash-outline" size={16} color={colors.onArtwork} />
                        </Pressable>
                      </View>
                    )}
                  </Pressable>
                  {cover.error ? <Text style={styles.coverError}>{cover.error}</Text> : null}
                </>
              ) : (
                <Cover uri={coverUri} size={160} />
              )}
            </View>

            <Text style={styles.label}>{t('Name')}</Text>
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={setName}
              placeholder={t('Playlist name')}
              placeholderTextColor={colors.textMuted}
            />

            <Text style={styles.label}>{t('Description')}</Text>
            <TextInput
              style={[styles.input, styles.multiline]}
              value={comment}
              onChangeText={setComment}
              placeholder={t('Add an optional description')}
              placeholderTextColor={colors.textMuted}
              multiline
              numberOfLines={3}
              textAlignVertical="top"
            />

            {hidePublic ? null : (
              <Pressable style={styles.switchRow} onPress={() => setIsPublic((v) => !v)}>
                <View style={styles.switchInfo}>
                  <Text style={styles.switchTitle}>{t('Public playlist')}</Text>
                  <Text style={styles.switchSub}>{t('Visible to other users on the server')}</Text>
                </View>
                <Switch
                  value={isPublic}
                  onValueChange={setIsPublic}
                  trackColor={{ true: colors.accent, false: colors.control }}
                  thumbColor={colors.knob}
                />
              </Pressable>
            )}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>

      <Dialog
        visible={cover.askPassword}
        title={t('Confirm your password')}
        message={t('Your password is needed to upload images and will be stored securely.')}
        input={{ placeholder: t('Password'), secure: true }}
        confirmLabel={t('Save')}
        onCancel={cover.cancelPassword}
        onConfirm={(value) => void cover.confirmPassword(value)}
      />
    </Modal>
  );
}

const styles = themed((colors) => ({
  safe: { flex: 1, backgroundColor: colors.background },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  title: { color: colors.text, fontSize: fontSize.md, fontWeight: '700' },
  headerAction: { color: colors.accent, fontSize: fontSize.md, fontWeight: '600' },
  disabled: { color: colors.textMuted },
  content: { padding: spacing.lg, gap: spacing.sm },
  coverWrap: { alignItems: 'center', marginBottom: spacing.sm },
  coverOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.scrim,
    borderRadius: radius.md,
  },
  coverBadges: {
    position: 'absolute',
    right: spacing.sm,
    bottom: spacing.sm,
    flexDirection: 'row',
    gap: spacing.sm,
  },
  // Denser than `scrim`: a 16 px icon has less of the cover to lift itself off.
  coverBadge: {
    backgroundColor: 'rgba(0,0,0,0.65)',
    borderRadius: radius.pill,
    padding: spacing.sm,
  },
  coverError: {
    color: colors.danger,
    fontSize: fontSize.sm,
    marginTop: spacing.xs,
    textAlign: 'center',
  },
  label: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: '600',
    marginTop: spacing.md,
  },
  input: {
    backgroundColor: colors.surfaceHighlight,
    borderRadius: radius.md,
    color: colors.text,
    fontSize: fontSize.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  multiline: { minHeight: 90 },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginTop: spacing.lg,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.lg,
  },
  switchInfo: { flex: 1 },
  switchTitle: { color: colors.text, fontSize: fontSize.md, fontWeight: '600' },
  switchSub: { color: colors.textSecondary, fontSize: fontSize.xs, marginTop: 2 },
}));
