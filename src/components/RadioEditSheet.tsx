/** Sheet to create or edit a radio station: name, URL, and optional website. */
import Ionicons from '@expo/vector-icons/Ionicons';
import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
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

export interface RadioEdit {
  name: string;
  streamUrl: string;
  homePageUrl: string;
}

interface Props {
  visible: boolean;
  /** Initial values (for editing); empty for creation. */
  initial: RadioEdit;
  /** true if editing an existing station (changes the title). */
  editing: boolean;
  /**
   * Station id, when it already exists and the profile can upload covers
   * (Navidrome): the chosen image goes straight to the server. When creating
   * there's no id yet, so it stays "pending" and the parent uploads it once
   * the server assigns one.
   */
  coverId?: string;
  /** The station's current image on the server. */
  serverCoverUri?: string;
  /** The profile can change station covers (Navidrome only). When it can't,
   *  the image is still shown, just not editable. */
  coverEditable?: boolean;
  onCancel: () => void;
  onSave: (changes: RadioEdit, pendingCoverUri?: string) => void;
}

export function RadioEditSheet({
  visible,
  initial,
  editing,
  coverId,
  serverCoverUri,
  coverEditable,
  onCancel,
  onSave,
}: Props) {
  const t = useT();
  const [name, setName] = useState(initial.name);
  const [streamUrl, setStreamUrl] = useState(initial.streamUrl);
  const [homePageUrl, setHomePageUrl] = useState(initial.homePageUrl);

  // The cover lives on the server, so it's the same for every client and for
  // Navidrome's own web UI. Editing an existing station uploads right away;
  // while creating there's no id yet, so the pick waits in `pendingCover` and
  // the parent uploads it once the server hands out the id.
  const cover = useServerCover({ kind: 'radio', coverUploadId: coverId });
  const { reset: resetCover } = cover;
  const [pendingCover, setPendingCover] = useState<string | null>(null);
  const coverBusy = cover.uploading;
  // `pickedUri` is the image just uploaded: shown right away instead of
  // waiting for the server to re-serve it under the same URL.
  const shownCover = cover.pickedUri ?? (coverId ? serverCoverUri : (pendingCover ?? undefined));
  const canRemove = !!coverEditable && (coverId ? !!shownCover : !!pendingCover);

  async function pickCover() {
    if (coverId) {
      await cover.pickAndUpload();
      return;
    }
    const res = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsEditing: true,
      aspect: [1, 1],
      quality: 0.9,
    });
    const asset = res.assets?.[0];
    if (res.canceled || !asset) return;
    setPendingCover(asset.uri);
  }

  async function clearCover() {
    if (!coverId) {
      setPendingCover(null);
      return;
    }
    await cover.removeCover();
  }

  // Resets fields every time it opens (or when what it opened on changes under
  // it). While rendering rather than from an effect, so the old values never
  // get a frame on screen first.
  const [opened, setOpened] = useState({ visible, ...initial });
  if (
    opened.visible !== visible ||
    opened.name !== initial.name ||
    opened.streamUrl !== initial.streamUrl ||
    opened.homePageUrl !== initial.homePageUrl
  ) {
    setOpened({ visible, ...initial });
    if (visible) {
      setName(initial.name);
      setStreamUrl(initial.streamUrl);
      setHomePageUrl(initial.homePageUrl);
      setPendingCover(null);
      resetCover();
    }
  }

  const urlOk = /^https?:\/\//i.test(streamUrl.trim());
  const showUrlError = streamUrl.trim().length > 0 && !urlOk;
  const canSave = name.trim().length > 0 && urlOk;

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
          <Text style={styles.title}>{editing ? t('Edit station') : t('Add station')}</Text>
          <Pressable
            hitSlop={12}
            disabled={!canSave}
            onPress={() =>
              onSave(
                {
                  name: name.trim(),
                  streamUrl: streamUrl.trim(),
                  homePageUrl: homePageUrl.trim(),
                },
                coverId ? undefined : (pendingCover ?? undefined),
              )
            }
          >
            <Text
              style={[styles.headerAction, { color: colors.accent }, !canSave && styles.disabled]}
            >
              {t('Save')}
            </Text>
          </Pressable>
        </View>

        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
            {/* Nothing to show and no way to add one: skip it entirely. */}
            {coverEditable || shownCover ? (
            <View style={styles.coverWrap}>
              <Pressable
                onPress={() => void pickCover()}
                disabled={coverBusy || !coverEditable}
                accessibilityRole="button"
                accessibilityLabel={t('Change cover')}
                style={({ pressed }) => pressed && { opacity: 0.7 }}
              >
                <Cover uri={shownCover} size={160} placeholderIcon="radio" />
                {coverBusy ? (
                  <View style={styles.coverOverlay}>
                    <ActivityIndicator color={colors.onArtwork} />
                  </View>
                ) : !coverEditable ? null : (
                  <View style={styles.coverBadges}>
                    <View style={styles.coverBadge}>
                      <Ionicons name="camera" size={16} color={colors.onArtwork} />
                    </View>
                    {canRemove ? (
                      <Pressable
                        hitSlop={6}
                        accessibilityRole="button"
                        accessibilityLabel={t('Remove cover')}
                        onPress={() => void clearCover()}
                        style={({ pressed }) => [styles.coverBadge, pressed && { opacity: 0.7 }]}
                      >
                        <Ionicons name="trash-outline" size={16} color={colors.onArtwork} />
                      </Pressable>
                    ) : null}
                  </View>
                )}
              </Pressable>
              {cover.error ? <Text style={styles.coverError}>{cover.error}</Text> : null}
            </View>
            ) : null}

            <Text style={styles.label}>{t('Name')}</Text>
            <TextInput
              style={styles.input}
              value={name}
              onChangeText={setName}
              placeholder={t('Station name')}
              placeholderTextColor={colors.textMuted}
              autoFocus
            />

            <Text style={styles.label}>{t('Stream URL')}</Text>
            <TextInput
              style={styles.input}
              value={streamUrl}
              onChangeText={setStreamUrl}
              placeholder="https://…"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              inputMode="url"
            />
            {showUrlError ? (
              <Text style={styles.error}>
                {t('The stream URL must start with http:// or https://')}
              </Text>
            ) : null}

            <Text style={styles.label}>{t('Website (optional)')}</Text>
            <TextInput
              style={styles.input}
              value={homePageUrl}
              onChangeText={setHomePageUrl}
              placeholder="https://…"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              inputMode="url"
            />
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>

      {/* Profiles created before the password was stored: uploading needs
          Navidrome's own API, which asks for it. */}
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
  // Inline, not a toast: a toast would be hidden under this Modal.
  coverError: {
    color: colors.danger,
    fontSize: fontSize.sm,
    marginTop: spacing.sm,
    textAlign: 'center',
  },
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
  error: { color: colors.danger, fontSize: fontSize.sm, marginTop: spacing.xs },
}));
