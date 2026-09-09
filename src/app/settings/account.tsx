/**
 * Settings › Account: who is signed in, changing the password, and the share
 * links this account has handed out.
 *
 * All three are things Navidrome's own web page does, and that page is one
 * somebody who only ever opens this app never sees: they signed in once, on
 * the phone, and the password they were given is the one they still have. So
 * the same edits its page makes are here, through the server's own API, and
 * the share links come through Subsonic, which any server that mints them can
 * list and revoke.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, ScrollView, Share, Text, TextInput, View } from 'react-native';

import { deleteShare, getShares, type Share as ShareLink } from '@/api/data';
import { changePassword, getAccount, NavidromeError, WRONG_CURRENT_PASSWORD } from '@/api/navidrome';
import { Dialog } from '@/components/Dialog';
import { Field, SettingRow, SettingsPage, settingsStyles } from '@/components/SettingsUI';
import { useCanShare } from '@/hooks/useCanShare';
import { useT } from '@/i18n';
import { useAuthStore } from '@/store/auth';
import { useSettings } from '@/store/settings';
import { useToast } from '@/store/toast';
import { colors, spacing, useTheme } from '@/theme';

export default function AccountSettings() {
  // Repaints on a change of appearance or accent: a stack keeps this screen
  // mounted while you are on another one, out of reach of anything else.
  useTheme();
  const t = useT();
  const auth = useAuthStore((s) => s.auth);
  const offline = useAuthStore((s) => s.offline);
  const navidrome = auth?.serverType === 'navidrome';
  // Navidrome's own API wants the password in the clear, which a Navidrome
  // profile keeps from login on; one from before that gets a line saying to
  // sign in again rather than a box asking for it here.
  const canAsk = !!auth && navidrome && !offline && !!(auth.ndPassword ?? auth.password);

  const account = useQuery({
    queryKey: ['account'],
    queryFn: () => getAccount(auth!),
    enabled: canAsk,
    retry: false,
  });

  if (!auth) {
    return (
      <SettingsPage title={t('Account')}>
        <ScrollView contentContainerStyle={settingsStyles.content}>
          <Text style={settingsStyles.sectionDescription}>
            {t('A local profile has no account: sign in to a server to see one.')}
          </Text>
        </ScrollView>
      </SettingsPage>
    );
  }

  return (
    <SettingsPage title={t('Account')}>
      {/* Taps land on the button while the keyboard is up for the password
          fields, instead of first dismissing it. */}
      <ScrollView contentContainerStyle={settingsStyles.content} keyboardShouldPersistTaps="handled">
        <Field label={t('Username')} value={auth.username} />
        {/* Only Navidrome tells us, and only once it has answered. An empty
            one is left out rather than shown as a blank row. */}
        {account.data?.email ? <Field label={t('E-mail')} value={account.data.email} /> : null}
        <Field label={t('Server')} value={auth.serverUrl.replace(/^https?:\/\//, '')} />

        <Text style={settingsStyles.sectionTitle}>{t('Password')}</Text>
        {!navidrome ? (
          <Text style={settingsStyles.sectionDescription}>
            {t('Your password is changed on the server, not from here.')}
          </Text>
        ) : !canAsk ? (
          <Text style={settingsStyles.sectionDescription}>
            {offline
              ? t('Changing the password needs the server: come back online first.')
              : t('Sign in to this profile again to change the password from here.')}
          </Text>
        ) : (
          <PasswordChange />
        )}

        <Shares />
      </ScrollView>
    </SettingsPage>
  );
}

/** Room for a long passphrase; nothing sensible is longer. */
const PASSWORD_MAX = 128;

/**
 * The three fields and the button. Fields rather than a dialog: the dialog
 * takes one line, and a new password is typed twice on purpose, so that a slip
 * of the thumb does not lock the account with a password nobody knows.
 */
function PasswordChange() {
  const t = useT();
  const toast = useToast((s) => s.show);
  const auth = useAuthStore((s) => s.auth);
  const savePassword = useAuthStore((s) => s.savePassword);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const ready = current.length > 0 && next.length > 0 && confirm.length > 0 && !busy;

  const submit = async () => {
    if (!auth || !ready) return;
    // Checked here and not on the server: the server takes whatever it is
    // sent, and the whole point of typing it twice is to catch this.
    if (next !== confirm) {
      toast(t("The new passwords don't match"));
      return;
    }
    setBusy(true);
    try {
      await changePassword(auth, current, next);
      // The server has the new one: what the profile keeps has to follow, or
      // the very next request signs the account out.
      await savePassword(next);
      setCurrent('');
      setNext('');
      setConfirm('');
      toast(t('Password changed'));
    } catch (e) {
      const fallback = t("Couldn't change the password");
      if (!(e instanceof NavidromeError)) {
        toast(fallback);
      } else if (e.message.includes(WRONG_CURRENT_PASSWORD)) {
        toast(t('The current password is wrong'));
      } else if (e.kind === 'forbidden') {
        toast(t("This server doesn't let you edit your own account"));
      } else {
        toast(e.kind === 'other' ? `${fallback} (${e.message})` : fallback);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SecretRow
        label={t('Current password')}
        value={current}
        onChange={setCurrent}
        contentType="password"
      />
      <SecretRow
        label={t('New password')}
        value={next}
        onChange={setNext}
        contentType="newPassword"
      />
      <SecretRow
        label={t('Confirm new password')}
        value={confirm}
        onChange={setConfirm}
        contentType="newPassword"
        onSubmit={() => void submit()}
      />
      <SettingRow
        icon="key-outline"
        label={busy ? t('Changing…') : t('Change password')}
        onPress={ready ? () => void submit() : undefined}
      />
    </>
  );
}

/**
 * A `TextRow` for a password: the same box, the field hidden. Its own because
 * `TextRow` has no reason to know about secrets, and a counter of characters
 * over a hidden field would be telling the person looking over a shoulder
 * exactly how long it is.
 */
function SecretRow({
  label,
  value,
  onChange,
  contentType,
  onSubmit,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  /** What the password manager is told the field is, so it offers the right
   *  thing: the saved password for the current, a made-up one for the new. */
  contentType: 'password' | 'newPassword';
  onSubmit?: () => void;
}) {
  return (
    <View style={[settingsStyles.cardBox, settingsStyles.textRow]}>
      <Text style={settingsStyles.rowLabel}>{label}</Text>
      <TextInput
        style={settingsStyles.textInput}
        value={value}
        onChangeText={onChange}
        secureTextEntry
        textContentType={contentType}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={PASSWORD_MAX}
        returnKeyType={onSubmit ? 'done' : 'next'}
        onSubmitEditing={onSubmit}
      />
    </View>
  );
}

/** What a share link is called in the list: what was typed when sharing, or
 *  failing that what is behind it. */
function shareTitle(share: ShareLink, fallback: string): string {
  if (share.description) return share.description;
  const first = share.entry?.[0];
  return first?.title || first?.name || first?.album || fallback;
}

/**
 * The account's share links, newest first, each with how many times it was
 * opened and when it stops working. Tapping one hands the link to the system
 * share sheet again; the bin next to it takes the link back, after asking.
 */
function Shares() {
  const t = useT();
  const toast = useToast((s) => s.show);
  const queryClient = useQueryClient();
  const lang = useSettings((s) => s.language);
  const offline = useAuthStore((s) => s.offline);
  const canShare = useCanShare();
  const [deleting, setDeleting] = useState<ShareLink | null>(null);
  const [busy, setBusy] = useState(false);

  const shares = useQuery({
    queryKey: ['shares'],
    queryFn: getShares,
    enabled: canShare,
  });

  const remove = async (share: ShareLink) => {
    setDeleting(null);
    if (busy) return;
    setBusy(true);
    try {
      await deleteShare(share.id);
      await queryClient.invalidateQueries({ queryKey: ['shares'] });
      toast(t('Link deleted'));
    } catch {
      toast(t("Couldn't delete the link"));
    } finally {
      setBusy(false);
    }
  };

  /** "3 visits · expires 12 Oct 2026", with the halves the link has. */
  const detail = (share: ShareLink): string => {
    const n = share.visitCount ?? 0;
    const visits = n === 1 ? t('1 visit') : t('{count} visits', { count: n });
    if (!share.expires) return `${visits} · ${t('never expires')}`;
    const when = new Date(share.expires);
    const date = when.toLocaleDateString(lang, { day: 'numeric', month: 'short', year: 'numeric' });
    // Against the moment the list was fetched, which is what the list is a
    // picture of; a link that expires while the screen is open is caught on
    // the next fetch, like everything else about it.
    const gone = when.getTime() < shares.dataUpdatedAt;
    return `${visits} · ${gone ? t('expired {date}', { date }) : t('expires {date}', { date })}`;
  };

  return (
    <>
      <Text style={settingsStyles.sectionTitle}>{t('Share links')}</Text>
      {offline ? (
        <Text style={settingsStyles.sectionDescription}>
          {t('Share links live on the server: come back online to see them.')}
        </Text>
      ) : !canShare ? (
        <Text style={settingsStyles.sectionDescription}>
          {t('Sharing is turned off on this server, or not allowed for this account.')}
        </Text>
      ) : shares.isError ? (
        <Text style={settingsStyles.sectionDescription}>{t("Couldn't load the share links.")}</Text>
      ) : shares.data && shares.data.length === 0 ? (
        <Text style={settingsStyles.sectionDescription}>
          {t('Nothing shared yet. Share a song, an album or a playlist and it shows up here.')}
        </Text>
      ) : shares.data ? (
        <View style={settingsStyles.cardBox}>
          {shares.data.map((share, i) => (
            <Pressable
              key={share.id}
              style={({ pressed }) => [
                settingsStyles.row,
                i > 0 && settingsStyles.rowBorder,
                pressed && { opacity: 0.6 },
              ]}
              // As `message` and not `url`, for the reason `lib/share` gives:
              // Android's sheet ignores `url`.
              onPress={() => void Share.share({ message: share.url }).catch(() => {})}
            >
              <Ionicons name="link-outline" size={20} color={colors.text} />
              <View style={settingsStyles.rowLabelBox}>
                <Text style={settingsStyles.rowLabel} numberOfLines={1}>
                  {shareTitle(share, t('Share'))}
                </Text>
                <Text style={settingsStyles.rowDescription}>{detail(share)}</Text>
              </View>
              <Pressable
                hitSlop={ACTION_SLOP}
                onPress={() => setDeleting(share)}
                style={({ pressed }) => pressed && { opacity: 0.6 }}
              >
                <Ionicons name="trash-outline" size={20} color={colors.danger} />
              </Pressable>
            </Pressable>
          ))}
        </View>
      ) : null}

      <Dialog
        visible={deleting !== null}
        title={t('Delete share link')}
        message={t('The link stops working for everyone who has it.')}
        confirmLabel={t('Delete')}
        destructive
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting) void remove(deleting);
        }}
      />
    </>
  );
}

/** Taller than the icon, so the bin is easier to hit than it looks. */
const ACTION_SLOP = { top: 12, bottom: 12, left: spacing.sm, right: spacing.sm };
