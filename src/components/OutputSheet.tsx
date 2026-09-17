/**
 * Audio output picker (Spotify Connect style): this phone, the server's own
 * speakers, a UPnP/DLNA renderer or a Google Cast receiver on the network, a
 * media player Home Assistant knows about, or one of Music Assistant's own.
 * When opened it searches for all of them and keeps searching while it is up.
 *
 * Sonos speakers are the reason this is more than a list. They arrive one per
 * room and can be played as a group, so while a Sonos session is on, the list
 * turns into the rooms of that system with a control each to bring a room into
 * the group or take it out; the rest of the time each group is one row, named
 * after its rooms. All of that is worked out below and none of it changes what
 * a row looks like: a row is an icon, a name, and a tick when it is the one
 * playing, the same as in every other sheet in the app.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import Slider from '@react-native-community/slider';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';

import { Dialog } from '@/components/Dialog';
import { ActivityIndicator, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAccent } from '@/hooks/useAccent';
import { useBottomSheetAnim } from '@/hooks/useBottomSheetAnim';
import { useT } from '@/i18n';
import {
  audioOutputAvailable,
  openSystemOutputPicker,
  setMediaVolume,
  useAudioOutput,
  type AudioOutputDevice,
} from '@/lib/audioOutput';
import { formatGroupedDeviceLabel, normalizeOutputDisplayName } from '@/lib/format';
import type { HaPlayer } from '@/lib/homeAssistant';
import type { MaPlayer } from '@/lib/musicAssistant';
import {
  castConnect,
  castDisconnect,
  castSearch,
  googleCastAvailable,
  useGoogleCast,
  type CastDevice,
} from '@/store/googleCast';
import { useAuthStore } from '@/store/auth';
import { haConnect, haDisconnect, haSearch, useHomeAssistant } from '@/store/homeAssistant';
import { linkPlayAvailable, type LinkPlayDevice } from '@/lib/linkplay';
import {
  linkPlayAdd,
  linkPlayConnect,
  linkPlayDisconnect,
  linkPlayForget,
  linkPlayJoin,
  linkPlayLeave,
  linkPlaySearch,
  useLinkPlay,
} from '@/store/linkplay';
import { listJams, type OpenJam } from '@/lib/jam';
import { useJam } from '@/store/jam';
import { maConnect, maDisconnect, maSearch, useMusicAssistant } from '@/store/musicAssistant';
import {
  jukeboxConnect,
  jukeboxDisconnect,
  refreshJukeboxAvailability,
  useJukebox,
} from '@/store/jukebox';
import { useSettings } from '@/store/settings';
import { useToast } from '@/store/toast';
import {
  upnpAvailable,
  upnpConnect,
  upnpDisconnect,
  upnpJoinDevice,
  upnpSearch,
  upnpUngroupDevice,
  useUpnp,
  type UpnpDevice,
} from '@/store/upnp';
import { colors, fontSize, radius, SHEET_MAX_WIDTH, spacing, themed } from '@/theme';

/**
 * Whether a speaker found another way keeps its row: not when LinkPlay lists
 * one of that name, unless it is the one playing, whose row is the way to
 * stop it.
 */
function notOnLinkPlay(lpNames: Set<string>, name: string, active: boolean): boolean {
  return active || !lpNames.has(normalizeOutputDisplayName(name).toLowerCase());
}

/** Every discovery at once: they are five answers to the same question. */
function searchAll() {
  void upnpSearch();
  void castSearch();
  void haSearch();
  void maSearch();
  void linkPlaySearch();
}

export function OutputSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const t = useT();
  const router = useRouter();
  const toast = useToast((s) => s.show);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const upnpId = useUpnp((s) => (s.connected ? s.deviceId : null));
  const allUpnpDevices = useUpnp((s) => s.devices);
  const scanning = useUpnp((s) => s.scanning);
  const jukeboxActive = useJukebox((s) => s.active);
  const jukeboxAvailable = useJukebox((s) => s.available);
  const castId = useGoogleCast((s) => (s.connected ? s.deviceId : null));
  const allCastDevices = useGoogleCast((s) => s.devices);
  const castScanning = useGoogleCast((s) => s.scanning);
  const haId = useHomeAssistant((s) => (s.connected ? s.entityId : null));
  const allHaPlayers = useHomeAssistant((s) => s.players);
  const haSearching = useHomeAssistant((s) => s.searching);
  const haOn = useHomeAssistant((s) => s.enabled);
  const haReady = useHomeAssistant((s) => s.enabled && !!s.url && !!s.token);
  const maId = useMusicAssistant((s) => (s.connected ? s.playerId : null));
  const allMaPlayers = useMusicAssistant((s) => s.players);
  const maSearching = useMusicAssistant((s) => s.searching);
  const maOn = useMusicAssistant((s) => s.enabled);
  const maReady = useMusicAssistant((s) => s.enabled && !!s.url && !!s.username);
  const lpHost = useLinkPlay((s) => (s.connected ? s.host : null));
  const lpDevices = useLinkPlay((s) => s.devices);
  const lpSlaves = useLinkPlay((s) => s.slaves);
  const lpSearching = useLinkPlay((s) => s.searching);
  // Typing a speaker's address, for a network that swallows the announcement.
  const [addingLinkPlay, setAddingLinkPlay] = useState(false);
  // A speaker LinkPlay reaches directly is the same speaker a Cast search, a
  // UPnP search or the house's assistants find under the same name, and one
  // row is enough: it goes under LinkPlay, where its group is, and nowhere
  // else. The one already playing through another route stays, since its
  // row is the way to stop it.
  const lpNames = useMemo(
    () => new Set(lpDevices.map((d) => normalizeOutputDisplayName(d.name).toLowerCase())),
    [lpDevices],
  );
  const devices = useMemo(
    () => allUpnpDevices.filter((d) => notOnLinkPlay(lpNames, d.name, d.id === upnpId)),
    [allUpnpDevices, lpNames, upnpId],
  );
  const castDevices = useMemo(
    () => allCastDevices.filter((d) => notOnLinkPlay(lpNames, d.name, d.id === castId)),
    [allCastDevices, lpNames, castId],
  );
  const haPlayers = useMemo(
    () => allHaPlayers.filter((p) => notOnLinkPlay(lpNames, p.name, p.entityId === haId)),
    [allHaPlayers, lpNames, haId],
  );
  const maPlayers = useMemo(
    () => allMaPlayers.filter((p) => notOnLinkPlay(lpNames, p.name, p.playerId === maId)),
    [allMaPlayers, lpNames, maId],
  );
  const phoneActive = !upnpId && !jukeboxActive && !castId && !haId && !maId && !lpHost;
  // The phone's own outputs and its media volume, only while the phone is the
  // one playing: a remote output has a volume of its own and the phone's
  // outputs are nothing to it.
  const { outputs, volume } = useAudioOutput(visible && phoneActive);
  const accent = useAccent();
  // The slider's value while a finger is on it: the volume it reports comes
  // back from the system a moment later, and handing the slider that stale
  // number mid-drag makes the thumb hop.
  const [liveVolume, setLiveVolume] = useState<number | null>(null);
  const { dismiss, pan, backdropStyle, sheetStyle, onSheetLayout } = useBottomSheetAnim(
    visible,
    onClose,
  );
  // Animated close: the sheet slides down and then notifies the parent (which hides the Modal).
  const close = () => dismiss(onClose);
  // The list scrolls once there are a few speakers on the network, so the drag
  // that dismisses the sheet only takes over at the top of it — the same deal
  // the song menu makes, and for the same reason: otherwise the two gestures
  // fight and scrolling up pulls the sheet down with it.
  const [atTop, setAtTop] = useState(true);

  const activeUpnpDevice = useMemo(
    () => (upnpId ? devices.find((device) => device.id === upnpId) ?? null : null),
    [devices, upnpId],
  );
  const activeGroupKey = activeUpnpDevice?.isSonos ? activeUpnpDevice.groupId ?? activeUpnpDevice.id : null;
  const activeCoordinatorId = activeUpnpDevice?.coordinatorId ?? activeUpnpDevice?.id ?? null;
  const isSonosSession = !!activeUpnpDevice?.isSonos;

  const activeGroupMembers = activeGroupKey
    ? devices.filter((device) => device.isSonos && (device.groupId ?? device.id) === activeGroupKey)
    : [];
  const activeSonosGroupMode = activeGroupMembers.length > 1;

  const groupedUpnpRows = useMemo(() => {
    const rows: {
      key: string;
      label: string;
      device: UpnpDevice;
      active: boolean;
      groupSize: number;
    }[] = [];
    const coveredIds = new Set<string>();
    const groups = new Map<string, UpnpDevice[]>();

    for (const device of devices) {
      if (!device.isSonos) continue;
      const groupKey = device.groupId ?? device.id;
      const group = groups.get(groupKey) ?? [];
      group.push(device);
      groups.set(groupKey, group);
    }

    for (const [groupKey, groupDevices] of groups) {
      if (groupDevices.length === 0) continue;
      groupDevices.forEach((device) => coveredIds.add(device.id));
      const coordinator = groupDevices.find((device) => device.id === device.coordinatorId) ?? groupDevices[0];
      const label =
        groupDevices.length > 1
          ? formatGroupedDeviceLabel(groupDevices.map((device) => device.name))
          : normalizeOutputDisplayName(groupDevices[0].name);
      rows.push({
        key: `sonos-group:${groupKey}`,
        label,
        device: coordinator,
        active: !!upnpId && groupDevices.some((device) => device.id === upnpId),
        groupSize: groupDevices.length,
      });
    }

    for (const device of devices) {
      if (coveredIds.has(device.id)) continue;
      rows.push({
        key: `upnp:${device.id}`,
        label: normalizeOutputDisplayName(device.name),
        device,
        active: device.id === upnpId,
        groupSize: 1,
      });
    }

    return rows.sort((a, b) => a.label.localeCompare(b.label));
  }, [devices, upnpId]);

  const sortedIndividualRows = useMemo(() => {
    if (!isSonosSession) return [] as UpnpDevice[];
    return devices
      .filter((device) => device.isSonos && (activeSonosGroupMode || device.id !== upnpId))
      .sort((a, b) => normalizeOutputDisplayName(a.name).localeCompare(normalizeOutputDisplayName(b.name)));
  }, [activeSonosGroupMode, devices, isSonosSession, upnpId]);

  const activeCastDevice = castId ? castDevices.find((device) => device.id === castId) ?? null : null;
  const activeHaPlayer = haId ? haPlayers.find((player) => player.entityId === haId) ?? null : null;
  const activeMaPlayer = maId ? maPlayers.find((player) => player.playerId === maId) ?? null : null;

  /**
   * One of the phone's outputs by name. Only the Bluetooth ones have a name of
   * their own; for the rest the product name is the phone's model, which says
   * nothing about the output, so the kind names it.
   */
  const localOutputLabel = (device: AudioOutputDevice) => {
    if (device.kind === 'speaker') return t('Phone speaker');
    if (device.kind === 'wired') return t('Wired headphones');
    if (device.kind === 'usb') return device.name || t('USB audio');
    if (device.kind === 'hearingAid') return device.name || t('Hearing aid');
    return device.name;
  };

  const activeLocalOutput = phoneActive
    ? outputs.devices.find((device) => device.id === outputs.activeId) ?? null
    : null;

  /** What the phone is playing through, named the way the row would name it. */
  const currentLabel = phoneActive
    ? activeLocalOutput && activeLocalOutput.kind !== 'speaker'
      ? `${t('This phone')} · ${localOutputLabel(activeLocalOutput)}`
      : t('This phone')
    : jukeboxActive
      ? t('Server speakers (Jukebox)')
      : activeCastDevice
        ? activeCastDevice.name
        : activeHaPlayer
          ? activeHaPlayer.name
          : activeMaPlayer
          ? activeMaPlayer.name
          : lpHost
          ? formatGroupedDeviceLabel([
              lpDevices.find((d) => d.host === lpHost)?.name ?? lpHost,
              ...lpSlaves.map((s) => s.name),
            ]) || lpHost
          : activeSonosGroupMode
          ? formatGroupedDeviceLabel(activeGroupMembers.map((device) => device.name))
          : activeUpnpDevice
            ? normalizeOutputDisplayName(activeUpnpDevice.name)
            : t('This phone');

  useEffect(() => {
    if (!visible) return;
    searchAll();
    void refreshJukeboxAvailability();
    // Re-scan periodically while the sheet is open: SSDP is lossy, so repeating
    // the search lets renderers that missed the first round appear on their own
    // (each search merges results and no-ops if a scan is still running).
    const id = setInterval(searchAll, 10000);
    return () => clearInterval(id);
  }, [visible]);

  async function pickPhone() {
    if (upnpId) await upnpDisconnect();
    else if (jukeboxActive) await jukeboxDisconnect();
    else if (castId) await castDisconnect();
    else if (haId) await haDisconnect();
    else if (maId) await maDisconnect();
    else if (lpHost) await linkPlayDisconnect();
  }

  /** Every other remote output let go quietly, before this one takes over. */
  async function leaveOtherRemotes(keep: 'upnp' | 'jukebox' | 'cast' | 'ha' | 'ma' | 'linkplay') {
    if (upnpId && keep !== 'upnp') await upnpDisconnect(true);
    if (jukeboxActive && keep !== 'jukebox') await jukeboxDisconnect(true);
    if (castId && keep !== 'cast') await castDisconnect(true);
    if (haId && keep !== 'ha') await haDisconnect(true);
    if (maId && keep !== 'ma') await maDisconnect(true);
    if (lpHost && keep !== 'linkplay') await linkPlayDisconnect(true);
  }

  async function pickLinkPlay(device: LinkPlayDevice) {
    if (device.host === lpHost) return;
    await leaveOtherRemotes('linkplay');
    const ok = await linkPlayConnect(device);
    if (!ok) toast(t("Couldn't complete the action"));
  }

  /** A speaker typed in by address: read, kept, and played on straight away. */
  async function addLinkPlay(address: string) {
    setAddingLinkPlay(false);
    if (!address.trim()) return;
    const device = await linkPlayAdd(address);
    if (!device) {
      toast(t('Nothing at that address answers as a LinkPlay speaker'));
      return;
    }
    await pickLinkPlay(device);
  }

  /**
   * Choosing one of the phone's outputs is the system's to do, not the app's
   * (see `src/lib/audioOutput.ts`), so a tap on one opens the system's own
   * media output dialog, where the same list is waiting with the same tick.
   */
  function openLocalPicker() {
    if (!openSystemOutputPicker()) toast(t("Couldn't complete the action"));
  }

  async function pickDevice(device: UpnpDevice) {
    if (device.id === upnpId) return;
    // Silent handoff between remote outputs (does not resume on local in between).
    if (castId) await castDisconnect(true);
    if (haId) await haDisconnect(true);
    if (maId) await maDisconnect(true);
    const ok = await upnpConnect(device);
    if (!ok) toast(t("Couldn't complete the action"));
  }

  async function pickJukebox() {
    if (jukeboxActive) return;
    // Silent handoff between remote outputs (does not resume on local in between).
    if (upnpId) await upnpDisconnect(true);
    if (castId) await castDisconnect(true);
    if (haId) await haDisconnect(true);
    if (maId) await maDisconnect(true);
    const ok = await jukeboxConnect();
    if (!ok) toast(t("Couldn't complete the action"));
  }

  async function pickCastDevice(device: CastDevice) {
    if (device.id === castId) return;
    // Silent handoff between remote outputs (does not resume on local in between).
    if (upnpId) await upnpDisconnect(true);
    if (jukeboxActive) await jukeboxDisconnect(true);
    if (haId) await haDisconnect(true);
    if (maId) await maDisconnect(true);
    const ok = await castConnect(device);
    if (!ok) toast(t("Couldn't complete the action"));
  }

  async function pickHaPlayer(player: HaPlayer) {
    if (player.entityId === haId) return;
    // Silent handoff between remote outputs (does not resume on local in between).
    await leaveOtherRemotes('ha');
    const ok = await haConnect(player);
    if (!ok) toast(t("Couldn't complete the action"));
  }

  async function pickMaPlayer(player: MaPlayer) {
    if (player.playerId === maId) return;
    // Silent handoff between remote outputs (does not resume on local in between).
    await leaveOtherRemotes('ma');
    const ok = await maConnect(player);
    if (!ok) toast(t("Couldn't complete the action"));
  }

  const jamCode = useJam((s) => s.session?.code ?? null);
  const jamOffered = useSettings((s) => s.navifind);
  // A session under way in the house, named on the row while this phone is
  // in none: asked once each time the sheet opens, which is when it matters.
  const [jamUnderWay, setJamUnderWay] = useState<OpenJam | null>(null);
  const jamAuth = useAuthStore((s) => s.auth);
  useEffect(() => {
    if (!visible || !jamOffered || jamCode || !jamAuth) return;
    let live = true;
    listJams(jamAuth)
      .then((jams) => {
        if (live) setJamUnderWay(jams[0] ?? null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [visible, jamOffered, jamCode, jamAuth]);

  /** The Jam screen: a session to open or join, or the one under way. */
  function openJam() {
    close();
    router.push('/jam');
  }

  /** Nothing to pick from until Home Assistant has an address and a token: the row goes there. */
  function openHaSettings() {
    close();
    router.push('/settings/home-assistant');
  }

  /** The same for Music Assistant, which needs an address and an account. */
  function openMaSettings() {
    close();
    router.push('/settings/music-assistant');
  }

  async function runGroupAction(key: string, action: () => Promise<boolean>) {
    setBusyAction(key);
    try {
      const ok = await action();
      if (!ok) {
        toast(t("Couldn't complete the action"));
        return;
      }
      await upnpSearch();
    } finally {
      setBusyAction(null);
    }
  }

  async function joinToCurrent(deviceId: string) {
    if (!activeCoordinatorId || deviceId === activeCoordinatorId) return;
    await runGroupAction(`join:${deviceId}`, () => upnpJoinDevice(deviceId, activeCoordinatorId));
  }

  async function ungroupDevice(deviceId: string) {
    await runGroupAction(`ungroup:${deviceId}`, () => upnpUngroupDevice(deviceId));
  }

  async function switchToSonosDevice(device: UpnpDevice) {
    if (!device.isSonos || !isSonosSession) {
      await pickDevice(device);
      return;
    }
    if (device.groupId !== activeGroupKey) {
      await pickDevice(device);
      return;
    }
    await runGroupAction(`switch:${device.id}`, async () => {
      const ungroupOk = await upnpUngroupDevice(device.id);
      if (!ungroupOk) return false;
      return upnpConnect(device);
    });
  }

  /** The icon for an output, by what it is. */
  const outputIcon = (
    kind: 'phone' | 'server' | 'group' | 'tv' | 'speaker' | 'cast' | 'home' | 'music',
    active?: boolean,
  ) => {
    const color = active ? colors.accent : colors.text;
    if (kind === 'phone') return <Ionicons name="phone-portrait-outline" size={22} color={color} />;
    if (kind === 'home') return <Ionicons name="home-outline" size={22} color={color} />;
    if (kind === 'server') return <Ionicons name="server-outline" size={22} color={color} />;
    if (kind === 'group') return <MaterialIcons name="speaker-group" size={22} color={color} />;
    if (kind === 'tv') return <Ionicons name="tv-outline" size={22} color={color} />;
    if (kind === 'cast') return <Ionicons name="logo-google" size={22} color={color} />;
    if (kind === 'music') return <Ionicons name="musical-notes-outline" size={22} color={color} />;
    return <MaterialIcons name="speaker" size={22} color={color} />;
  };

  /** The icon for one of the phone's outputs, by what it is. */
  const localOutputIcon = (kind: AudioOutputDevice['kind'], active: boolean) => {
    const color = active ? colors.accent : colors.text;
    if (kind === 'speaker') return <Ionicons name="volume-high-outline" size={22} color={color} />;
    if (kind === 'wired') return <Ionicons name="headset-outline" size={22} color={color} />;
    if (kind === 'bluetooth') return <Ionicons name="bluetooth-outline" size={22} color={color} />;
    if (kind === 'usb') return <Ionicons name="hardware-chip-outline" size={22} color={color} />;
    return <Ionicons name="ear-outline" size={22} color={color} />;
  };

  const showLocalOutputs = phoneActive && audioOutputAvailable && outputs.devices.length > 0;

  return (
    <>
    <Modal transparent visible={visible} animationType="none" onRequestClose={close}>
      {/* Gestures inside an RN Modal need a root view of their own: the
          Modal renders in a native hierarchy outside the app's. */}
      <GestureHandlerRootView style={StyleSheet.absoluteFill}>
        <Animated.View style={[styles.backdrop, backdropStyle]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={close} />
        </Animated.View>
        <GestureDetector gesture={pan.enabled(atTop)}>
          <Animated.View
            style={[styles.sheet, { paddingBottom: insets.bottom + spacing.md }, sheetStyle]}
            onLayout={onSheetLayout}
          >
            {/* Spotify-style grabber: the visual cue that the sheet can be
                dragged down to dismiss. */}
            <View style={styles.grabber} />
            {/* The title says what the sheet is; the line under it says where the
                sound is going, which is the one thing you came to check and the
                answer is a whole sentence for a Sonos group. The list below
                still marks it, so this is a summary and not the only mark. */}
            <Text style={styles.sheetTitle}>{t('Output')}</Text>
            <Text style={styles.currentLine} numberOfLines={1}>
              {t('Currently playing on')}: {currentLabel}
            </Text>

            <ScrollView
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.content}
              onScroll={(e) => setAtTop(e.nativeEvent.contentOffset.y <= 4)}
              scrollEventThrottle={16}
              bounces={false}
            >
              {/* First, above every output: not where the sound goes but who
                  else hears it, everybody in the session, each on their own
                  device. Only with the proxy that keeps sessions. */}
              {jamOffered ? (
                <>
                  <Text style={styles.sectionTitle}>{t('Listen together')}</Text>
                  <Row
                    icon={<Ionicons name="people-outline" size={22} color={jamCode ? colors.accent : colors.text} />}
                    label={
                      jamCode
                        ? t('Jam {code}', { code: jamCode })
                        : jamUnderWay
                          ? t("Join {name}'s Jam", { name: jamUnderWay.host })
                          : t('Start or join a Jam')
                    }
                    active={!!jamCode}
                    onPress={openJam}
                    action={<Ionicons name="chevron-forward" size={20} color={colors.textMuted} />}
                  />
                </>
              ) : null}

              <Row
                icon={outputIcon('phone', phoneActive)}
                label={t('This phone')}
                active={phoneActive}
                onPress={phoneActive ? undefined : () => void pickPhone()}
              />

              {/* The phone's own outputs, under the phone and indented to it,
                  with the one media is going to ticked. Only while the phone is
                  playing: the tick, the volume and the outputs themselves are
                  all the phone's, and a remote output has none of them. The
                  rows open the system's dialog rather than switch on their own,
                  for the reason `openLocalPicker` gives. */}
              {showLocalOutputs ? (
                <View style={styles.localOutputs}>
                  {outputs.devices.map((device) => {
                    const active = device.id === outputs.activeId;
                    return (
                      <Row
                        key={`local:${device.id}`}
                        icon={localOutputIcon(device.kind, active)}
                        label={localOutputLabel(device)}
                        active={active}
                        onPress={active ? undefined : openLocalPicker}
                      />
                    );
                  })}
                  <Text style={styles.hint}>{t("Change the output from the system's media output picker")}</Text>
                  <Pressable
                    style={({ pressed }) => [styles.action, pressed && { opacity: 0.6 }]}
                    onPress={openLocalPicker}
                  >
                    <Ionicons name="open-outline" size={20} color={colors.textSecondary} />
                    <Text style={[styles.actionText, { color: colors.textSecondary }]}>
                      {t('Open system output picker')}
                    </Text>
                  </Pressable>
                </View>
              ) : null}

              {/* The media volume, in the system's own steps so it lands on
                  the same notches as the hardware keys, and following them
                  when they are pressed. */}
              {phoneActive && audioOutputAvailable && volume.max > 0 ? (
                <View style={styles.volumeRow}>
                  <Ionicons name="volume-low-outline" size={20} color={colors.textSecondary} />
                  <Slider
                    style={styles.volumeSlider}
                    accessibilityLabel={t('Media volume')}
                    minimumValue={0}
                    maximumValue={volume.max}
                    step={1}
                    value={liveVolume ?? volume.value}
                    onValueChange={(v) => {
                      setLiveVolume(v);
                      setMediaVolume(v);
                    }}
                    onSlidingComplete={(v) => {
                      setMediaVolume(v);
                      setLiveVolume(null);
                    }}
                    minimumTrackTintColor={accent}
                    maximumTrackTintColor={colors.control}
                    thumbTintColor={colors.knob}
                  />
                  <Ionicons name="volume-high-outline" size={20} color={colors.textSecondary} />
                </View>
              ) : null}

              {/* LinkPlay speakers, WiiM among them, over their own API, and
                  first among the outputs: it is the direct way to a speaker a
                  Cast search also finds, and the only way to a WiiM Mini. With one
                  playing, the others carry a control each to bring them into its
                  multiroom group or take them out, the way the Sonos rooms do.
                  A speaker the network keeps from announcing itself is typed in
                  by address, and kept. */}
              {linkPlayAvailable() && (lpDevices.length > 0 || lpHost) ? (
                <>
                  <Text style={styles.sectionTitle}>{t('LinkPlay')}</Text>
                  {lpDevices.map((device) => {
                    const active = device.host === lpHost;
                    const following = lpSlaves.some((s) => s.host === device.host);
                    const actionKey = `lp:${device.host}`;
                    const action =
                      lpHost && !active ? (
                        <Pressable
                          hitSlop={10}
                          style={({ pressed }) => [pressed && { opacity: 0.6 }]}
                          disabled={busyAction != null}
                          accessibilityRole="button"
                          accessibilityLabel={following ? t('Remove from the group') : t('Add to the group')}
                          onPress={(event) => {
                            event.stopPropagation();
                            void runGroupAction(actionKey, () =>
                              following ? linkPlayLeave(device.host) : linkPlayJoin(device.host),
                            );
                          }}
                        >
                          {busyAction === actionKey ? (
                            <ActivityIndicator size="small" color={colors.textSecondary} />
                          ) : (
                            <Ionicons
                              name={following ? 'remove-circle-outline' : 'add-circle-outline'}
                              size={22}
                              color={colors.textSecondary}
                            />
                          )}
                        </Pressable>
                      ) : device.manual && !active ? (
                        <Pressable
                          hitSlop={10}
                          accessibilityRole="button"
                          accessibilityLabel={t('Forget')}
                          onPress={(event) => {
                            event.stopPropagation();
                            linkPlayForget(device.host);
                          }}
                        >
                          <Ionicons name="close-circle-outline" size={22} color={colors.textMuted} />
                        </Pressable>
                      ) : undefined;
                    return (
                      <Row
                        key={`lp:${device.host}`}
                        icon={outputIcon('speaker', active || following)}
                        label={following ? `${device.name} · ${t('in the group')}` : device.name}
                        active={active || following}
                        onPress={active || following ? undefined : () => void pickLinkPlay(device)}
                        action={action}
                      />
                    );
                  })}
                </>
              ) : null}
              {linkPlayAvailable() ? (
                <Row
                  icon={outputIcon('speaker')}
                  label={t('Add a LinkPlay speaker by address…')}
                  onPress={() => setAddingLinkPlay(true)}
                  action={<Ionicons name="chevron-forward" size={20} color={colors.textMuted} />}
                />
              ) : null}

              {jukeboxAvailable ? (
                <Row
                  icon={outputIcon('server', jukeboxActive)}
                  label={t('Server speakers (Jukebox)')}
                  active={jukeboxActive}
                  onPress={jukeboxActive ? undefined : () => void pickJukebox()}
                />
              ) : null}

              {upnpAvailable
                ? isSonosSession
                  ? sortedIndividualRows.map((device) => {
                      const active = device.id === upnpId;
                      const inActiveGroup = device.groupId === activeGroupKey;
                      const isActiveCoordinator = !!activeCoordinatorId && device.id === activeCoordinatorId;
                      const canJoin = !!activeGroupKey && !inActiveGroup && device.id !== activeCoordinatorId;
                      const canUngroup = inActiveGroup && (activeSonosGroupMode || !isActiveCoordinator);
                      const actionKey = canJoin ? `join:${device.id}` : `ungroup:${device.id}`;
                      const actionBusy = busyAction === actionKey;
                      // Secondary to the row it sits on: pressing the name moves
                      // the music, pressing this only changes who else is in the
                      // group, so it is drawn the way every other secondary
                      // action in the app is and not in a colour of its own.
                      const action = device.isSonos && (canJoin || canUngroup) ? (
                        <Pressable
                          hitSlop={10}
                          style={({ pressed }) => [pressed && { opacity: 0.6 }]}
                          disabled={busyAction != null}
                          accessibilityRole="button"
                          accessibilityLabel={canJoin ? t('Add to the group') : t('Remove from the group')}
                          onPress={(event) => {
                            event.stopPropagation();
                            if (canJoin) {
                              void joinToCurrent(device.id);
                              return;
                            }
                            if (!canUngroup) return;
                            void ungroupDevice(device.id);
                          }}
                        >
                          {actionBusy ? (
                            <ActivityIndicator size="small" color={colors.textSecondary} />
                          ) : (
                            <Ionicons
                              name={canJoin ? 'add-circle-outline' : 'remove-circle-outline'}
                              size={22}
                              color={colors.textSecondary}
                            />
                          )}
                        </Pressable>
                      ) : undefined;

                      return (
                        <Row
                          key={device.id}
                          icon={outputIcon(device.isTV ? 'tv' : 'speaker', active)}
                          label={normalizeOutputDisplayName(device.name)}
                          active={active}
                          onPress={() => void switchToSonosDevice(device)}
                          action={action}
                        />
                      );
                    })
                  : groupedUpnpRows.map((row) => (
                      <Row
                        key={row.key}
                        icon={outputIcon(
                          row.groupSize > 1 ? 'group' : row.device.isTV ? 'tv' : 'speaker',
                          row.active,
                        )}
                        label={row.label}
                        active={row.active}
                        onPress={() => void pickDevice(row.device)}
                      />
                    ))
                : null}

              {/* Cast receivers under a heading of their own: a TV shows up
                  here and, as a DLNA renderer, in the list above as well, and
                  the heading is what says which of the two rows is which. Only
                  while there is something under it. */}
              {googleCastAvailable && castDevices.length > 0 ? (
                <>
                  <Text style={styles.sectionTitle}>{t('Google Cast')}</Text>
                  {castDevices.map((device) => {
                    const active = device.id === castId;
                    return (
                      <Row
                        key={`cast:${device.id}`}
                        icon={outputIcon('cast', active)}
                        label={device.name}
                        active={active}
                        onPress={() => void pickCastDevice(device)}
                      />
                    );
                  })}
                </>
              ) : null}

              {/* The house's players, under a heading of their own like the Cast
                  receivers: a Chromecast or a Sonos is in one of the lists above
                  as well, and the heading says which way it is being reached.
                  Without an address and a token there is nothing to list, and
                  the one row is the way to the screen that takes them. */}
              {haOn ? (
                <>
              <Text style={styles.sectionTitle}>{t('Home Assistant')}</Text>
              {!haReady ? (
                <Row
                  icon={outputIcon('home')}
                  label={t('Set up Home Assistant')}
                  onPress={openHaSettings}
                  action={<Ionicons name="chevron-forward" size={20} color={colors.textMuted} />}
                />
              ) : haPlayers.length > 0 ? (
                haPlayers.map((player) => {
                  const active = player.entityId === haId;
                  return (
                    <Row
                      key={`ha:${player.entityId}`}
                      icon={outputIcon('home', active)}
                      label={player.name}
                      active={active}
                      onPress={() => void pickHaPlayer(player)}
                    />
                  );
                })
              ) : haSearching ? null : (
                <Text style={styles.scanText}>{t('No media players in Home Assistant')}</Text>
              )}
                </>
              ) : null}

              {/* Music Assistant, spoken to directly rather than through Home
                  Assistant: the same speaker can be in both lists, and the
                  heading says which way it is being reached. This one plays
                  from the server's own library, so nothing is served from the
                  phone and the phone can go to sleep. Without an address and
                  an account there is nothing to list, and the one row is the
                  way to the screen that takes them. */}
              {maOn ? (
                <>
                  <Text style={styles.sectionTitle}>{t('Music Assistant')}</Text>
                  {!maReady ? (
                    <Row
                      icon={outputIcon('music')}
                      label={t('Set up Music Assistant')}
                      onPress={openMaSettings}
                      action={<Ionicons name="chevron-forward" size={20} color={colors.textMuted} />}
                    />
                  ) : maPlayers.length > 0 ? (
                    maPlayers.map((player) => {
                      const active = player.playerId === maId;
                      return (
                        <Row
                          key={`ma:${player.playerId}`}
                          icon={outputIcon('music', active)}
                          label={player.name}
                          active={active}
                          onPress={() => void pickMaPlayer(player)}
                        />
                      );
                    })
                  ) : maSearching ? null : (
                    <Text style={styles.scanText}>{t('No players in Music Assistant')}</Text>
                  )}
                </>
              ) : null}

              {/* What the search is doing, and only while it is doing it: a line
                  that says it is searching whether or not it is says nothing at
                  all. When it has finished and found nothing, that is the news,
                  and the way to try again goes with it. */}
              {scanning || castScanning || haSearching || maSearching || lpSearching ? (
                <View style={styles.scanRow}>
                  <ActivityIndicator size="small" color={colors.textSecondary} />
                  <Text style={styles.scanText}>{t('Searching for devices…')}</Text>
                </View>
              ) : upnpAvailable || googleCastAvailable ? (
                <>
                  {devices.length === 0 && castDevices.length === 0 ? (
                    <Text style={styles.scanText}>{t('No devices found')}</Text>
                  ) : null}
                  <Pressable
                    style={({ pressed }) => [styles.action, pressed && { opacity: 0.6 }]}
                    onPress={searchAll}
                  >
                    <Ionicons name="refresh" size={20} color={colors.textSecondary} />
                    <Text style={[styles.actionText, { color: colors.textSecondary }]}>
                      {t('Search again')}
                    </Text>
                  </Pressable>
                </>
              ) : null}
            </ScrollView>
          </Animated.View>
        </GestureDetector>
      </GestureHandlerRootView>
    </Modal>
      <Dialog
        visible={addingLinkPlay}
        title={t('Add a LinkPlay speaker by address…')}
        message={t("The speaker's IP address on your network, as its own app shows it.")}
        input={{ placeholder: '192.168.1.20' }}
        confirmLabel={t('Add')}
        onCancel={() => setAddingLinkPlay(false)}
        onConfirm={(value) => void addLinkPlay(value)}
      />
    </>
  );
}

/**
 * One output. The tick and the accent name the one that is playing, which is
 * how every list in the app says "this one"; `action` is the extra control a
 * Sonos room gets, and it sits where the tick would be because a room that
 * can be grouped is never the room already playing.
 */
function Row({
  icon,
  label,
  active,
  onPress,
  action,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onPress?: () => void;
  action?: React.ReactNode;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.action, pressed && !!onPress && { opacity: 0.6 }]}
      disabled={!onPress}
      onPress={onPress}
    >
      {icon}
      <Text style={[styles.actionText, active && { color: colors.accent }]} numberOfLines={1}>
        {label}
      </Text>
      <View style={styles.trailing}>
        {action ?? (active ? <Ionicons name="checkmark" size={20} color={colors.accent} /> : null)}
      </View>
    </Pressable>
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
    maxHeight: '84%',
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.xxl,
    borderTopRightRadius: radius.xxl,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.textMuted,
    opacity: 0.5,
    marginBottom: spacing.md,
  },
  sheetTitle: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: '700',
  },
  currentLine: {
    color: colors.textMuted,
    fontSize: fontSize.sm,
    marginTop: 2,
    marginBottom: spacing.sm,
  },
  content: { paddingBottom: spacing.sm },
  sectionTitle: {
    color: colors.textSecondary,
    fontSize: fontSize.sm,
    fontWeight: '700',
    marginTop: spacing.sm,
  },
  action: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    minHeight: 34,
  },
  actionText: { color: colors.text, fontSize: fontSize.md, flexShrink: 1 },
  // Indented by the phone row's icon and gap, so the outputs read as its own.
  localOutputs: { paddingLeft: 22 + spacing.md },
  hint: { color: colors.textMuted, fontSize: fontSize.sm, paddingTop: spacing.xs },
  volumeRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.xs,
  },
  volumeSlider: { flex: 1, height: 32 },
  // Fixed width so the ticks and the group controls line up down the sheet
  // whatever the names are, and the names all get cut at the same place.
  trailing: { marginLeft: 'auto', minWidth: 22, alignItems: 'flex-end' },
  scanRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  scanText: { color: colors.textSecondary, fontSize: fontSize.sm },
}));
