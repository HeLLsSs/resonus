/**
 * Settings › Navigation bar: which tabs are at the bottom, and in what order.
 *
 * The same draggable list the Home chips and the Home sections use, with
 * one rule they do not have: **Home has no switch**. Every other list here can
 * be emptied and the thing it feeds simply disappears; empty this one and the
 * app has no way out of wherever you happen to be standing.
 *
 * A tab that is off is still a route — anything already pointing at it still
 * opens it, and the back arrow still knows where it came from. What goes is
 * the way in from the bar.
 *
 * Not every profile is offered the same list: the YouTube tab is the Navifind
 * proxy answering for a YouTube account, and a profile without the proxy has
 * no such row here at all.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, Switch, Text, View } from 'react-native';
import ReorderableList, {
  useReorderableDrag,
  type ReorderableListReorderEvent,
} from 'react-native-reorderable-list';

import { ScreenHeader, SettingsSafeArea } from '@/components/SettingsUI';
import { useAccent } from '@/hooks/useAccent';
import { useScreenBottomPadding } from '@/hooks/useScreenBottomPadding';
import { centredPadding, useScreenSize } from '@/hooks/useScreenSize';
import { useT } from '@/i18n';
import { reorderUsable, usableTabs } from '@/lib/bottomTabs';
import { haptic } from '@/lib/haptics';
import { TABS } from '@/lib/tabOrigin';
import { useSettings, type BottomTab } from '@/store/settings';
import {
  colors,
  fontSize,
  radius,
  spacing,
  SCREEN_BOTTOM_PADDING,
  themed,
  useTheme,
} from '@/theme';

function TabRow({ tab }: { tab: BottomTab }) {
  const t = useT();
  const drag = useReorderableDrag();
  const setBottomTab = useSettings((s) => s.setBottomTab);
  const accent = useAccent();
  const label = TABS.find((x) => x.segment === tab.key)?.label ?? tab.key;
  // Home stays. Its row is still draggable, because where it sits is a
  // preference like any other; whether it is there at all is not.
  const fixed = tab.key === 'index';
  return (
    <View style={styles.row}>
      <Pressable
        hitSlop={8}
        onPressIn={() => {
          haptic('medium');
          drag();
        }}
        accessibilityRole="button"
        accessibilityLabel={t('Reorder')}
      >
        <Ionicons name="reorder-two" size={24} color={colors.textSecondary} />
      </Pressable>
      <Text style={styles.label}>{t(label)}</Text>
      {fixed ? (
        <Text style={styles.fixed}>{t('Always shown')}</Text>
      ) : (
        <Switch
          value={tab.enabled}
          onValueChange={(v) => setBottomTab(tab.key, v)}
          trackColor={{ false: colors.control, true: accent }}
          thumbColor={colors.knob}
        />
      )}
    </View>
  );
}

export default function NavigationBarSettings() {
  // Repaints on a change of appearance or accent: a stack keeps this screen
  // mounted while you are on another one, out of reach of anything else.
  useTheme();
  const bottomPad = useScreenBottomPadding();
  const { width } = useScreenSize();
  const t = useT();
  const bottomTabs = useSettings((s) => s.bottomTabs);
  const setBottomTabs = useSettings((s) => s.setBottomTabs);
  // A tab this profile has nothing behind is not a choice to offer: the
  // YouTube one belongs to the Navifind proxy, and without it a switch here
  // would turn on a tab that could not be opened (see `lib/bottomTabs.ts`).
  const navifind = useSettings((s) => s.navifind);
  const rows = usableTabs(bottomTabs, navifind);
  return (
    <SettingsSafeArea>
      <ScreenHeader title={t('Navigation bar')} />
      <Text style={styles.hint}>{t('Drag to reorder, toggle to show or hide.')}</Text>
      <ReorderableList
        data={rows}
        keyExtractor={(item) => item.key}
        renderItem={({ item }) => <TabRow tab={item} />}
        onReorder={({ from, to }: ReorderableListReorderEvent) =>
          setBottomTabs(reorderUsable(bottomTabs, navifind, from, to))
        }
        contentContainerStyle={[
          styles.list,
          // Centred once the screen is wider than a list wants to be, like
          // every other settings screen (#131).
          { paddingBottom: bottomPad, paddingHorizontal: centredPadding(width, spacing.lg) },
        ]}
      />
    </SettingsSafeArea>
  );
}

const styles = themed((colors) => ({
  hint: {
    color: colors.textMuted,
    fontSize: fontSize.xs,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.sm,
  },
  list: { paddingHorizontal: spacing.lg, paddingBottom: SCREEN_BOTTOM_PADDING },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
  },
  label: { flex: 1, color: colors.text, fontSize: fontSize.md },
  // Where the switch would be, in the voice of something that is not a
  // control: it is an answer to "why can I not turn this one off".
  fixed: { color: colors.textMuted, fontSize: fontSize.xs },
}));
