/**
 * Writing a smart playlist: its name, its rules and the order it comes out in.
 * Opened with `?id=` for one that exists, without for a new one.
 */
import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { getGenres } from '@/api/data';
import { SelectList, SettingRow, SettingsPage, settingsStyles, TextRow } from '@/components/SettingsUI';
import { useAccent } from '@/hooks/useAccent';
import { useT } from '@/i18n';
import {
  defaultOp,
  naturalDir,
  OPS_FOR_KIND,
  RULE_FIELDS,
  RULE_KIND,
  SORT_FIELDS,
  type Rule,
  type RuleField,
  type RuleOp,
  type SmartPlaylist,
  type SortField,
} from '@/lib/smartPlaylists';
import { useAuthStore } from '@/store/auth';
import { newSmartPlaylistId, useSmartPlaylists } from '@/store/smartPlaylists';
import { fontSize, radius, spacing, themed, useTheme } from '@/theme';

const NAME_MAX = 60;
const NUMBER_MAX = 6;
const TEXT_MAX = 80;

/** What each field is called on screen. Keys, translated where they are read. */
const FIELD_LABEL: Record<RuleField, string> = {
  rating: 'Rating',
  starred: 'Favourite',
  genre: 'Genre',
  year: 'Year',
  playCount: 'Play count',
  lastPlayed: 'Last played',
  added: 'Date added',
  duration: 'Duration',
  format: 'Format',
  artist: 'Artist',
  album: 'Album',
  title: 'Title',
};

const OP_LABEL: Record<RuleOp, string> = {
  gte: 'is at least',
  lte: 'is at most',
  eq: 'is exactly',
  within: 'in the last … days',
  notWithin: 'not in the last … days',
  is: 'is',
  isNot: 'is not',
  contains: 'contains',
  notContains: 'does not contain',
};

const SORT_LABEL: Record<SortField, string> = {
  title: 'Title',
  artist: 'Artist',
  album: 'Album',
  year: 'Year',
  added: 'Date added',
  playCount: 'Play count',
  rating: 'Rating',
  duration: 'Duration',
  random: 'Random',
};

/** What the value box asks for, by field. */
function valueHint(field: RuleField): string {
  if (field === 'added' || field === 'lastPlayed') return 'Days';
  if (field === 'duration') return 'Seconds';
  if (field === 'year') return 'Year';
  if (field === 'playCount') return 'Plays';
  if (field === 'format') return 'flac, mp3…';
  return 'Value';
}

function digits(v: string): string {
  return v.replace(/[^0-9]/g, '');
}

export default function SmartPlaylistEditScreen() {
  // Repaints on a change of appearance or accent: a stack keeps this screen
  // mounted while you are on another one, out of reach of anything else.
  useTheme();
  const t = useT();
  const accent = useAccent();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const existing = useSmartPlaylists((s) => s.lists.find((l) => l.id === id));
  const save = useSmartPlaylists((s) => s.save);
  const canFetch = useAuthStore((s) => !!s.auth || s.offline);

  const [name, setName] = useState(existing?.name ?? '');
  const [match, setMatch] = useState<SmartPlaylist['match']>(existing?.match ?? 'all');
  const [rules, setRules] = useState<Rule[]>(existing?.rules ?? [{ field: 'rating', op: 'gte', value: '4' }]);
  const [sort, setSort] = useState<SortField>(existing?.sort ?? 'random');
  const [dir, setDir] = useState<'asc' | 'desc'>(existing?.dir ?? naturalDir('random'));
  const [limit, setLimit] = useState(existing?.limit ? String(existing.limit) : '');

  // The server's genres, so a genre rule is picked off a list and never
  // misspelt: a rule that names a genre nobody tagged matches nothing and
  // says nothing about why.
  const { data: genres } = useQuery({ queryKey: ['genres'], queryFn: () => getGenres(), enabled: canFetch });
  const genreOptions = (genres ?? []).map((g) => ({ value: g.value, label: g.value }));

  const setRule = (i: number, patch: Partial<Rule>) =>
    setRules((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const changeField = (i: number, field: RuleField) =>
    setRule(i, { field, op: defaultOp(field), value: field === 'rating' ? '4' : '' });

  const done = () => {
    const list: SmartPlaylist = {
      id: existing?.id ?? newSmartPlaylistId(),
      name: name.trim() || t('Unnamed'),
      match,
      rules: rules.filter((r) => RULE_KIND[r.field] === 'flag' || r.value.trim() !== ''),
      sort,
      dir,
      limit: Number(limit) > 0 ? Number(limit) : undefined,
      createdAt: existing?.createdAt ?? Date.now(),
    };
    save(list);
    if (existing) router.back();
    else router.replace(`/smart-playlist/${list.id}`);
  };

  return (
    <SettingsPage title={existing ? t('Edit smart playlist') : t('New smart playlist')}>
      <ScrollView contentContainerStyle={settingsStyles.content} keyboardShouldPersistTaps="handled">
        <TextRow label={t('Name')} value={name} placeholder={t('Smart playlist')} maxLength={NAME_MAX} onChange={setName} />

        <Text style={settingsStyles.sectionTitle}>{t('Rules')}</Text>
        <SelectList<SmartPlaylist['match']>
          options={[
            { value: 'all', label: t('All rules must match') },
            { value: 'any', label: t('Any rule can match') },
          ]}
          value={match}
          onChange={setMatch}
        />
        {rules.map((rule, i) => {
          const kind = RULE_KIND[rule.field];
          return (
            <View key={i} style={styles.rule}>
              <Text style={styles.ruleTitle}>{t('Rule {n}', { n: i + 1 })}</Text>
              <SelectList<RuleField>
                options={RULE_FIELDS.map((f) => ({ value: f, label: t(FIELD_LABEL[f]) }))}
                value={rule.field}
                onChange={(f) => changeField(i, f)}
              />
              <SelectList<RuleOp>
                options={OPS_FOR_KIND[kind].map((op) => ({
                  value: op,
                  label: kind === 'flag' ? (op === 'is' ? t('Yes') : t('No')) : t(OP_LABEL[op]),
                }))}
                value={rule.op}
                onChange={(op) => setRule(i, { op })}
              />
              {kind === 'flag' ? null : rule.field === 'rating' ? (
                <SelectList<string>
                  options={['1', '2', '3', '4', '5'].map((v) => ({ value: v, label: '★'.repeat(Number(v)) }))}
                  value={rule.value || '4'}
                  onChange={(v) => setRule(i, { value: v })}
                />
              ) : rule.field === 'genre' && genreOptions.length > 0 && (rule.op === 'is' || rule.op === 'isNot') ? (
                <SelectList<string>
                  options={genreOptions}
                  value={rule.value}
                  onChange={(v) => setRule(i, { value: v })}
                  label={t('Genre')}
                />
              ) : (
                <TextRow
                  label={t(valueHint(rule.field))}
                  value={rule.value}
                  maxLength={kind === 'text' ? TEXT_MAX : NUMBER_MAX}
                  onChange={(v) => setRule(i, { value: kind === 'text' ? v : digits(v) })}
                />
              )}
              <SettingRow
                label={t('Remove rule')}
                icon="trash-outline"
                destructive
                onPress={() => setRules((rs) => rs.filter((_, j) => j !== i))}
              />
            </View>
          );
        })}
        <SettingRow
          label={t('Add rule')}
          icon="add"
          onPress={() => setRules((rs) => [...rs, { field: 'genre', op: 'is', value: '' }])}
        />

        <Text style={settingsStyles.sectionTitle}>{t('Order')}</Text>
        <SelectList<SortField>
          label={t('Sort by')}
          options={SORT_FIELDS.map((f) => ({ value: f, label: t(SORT_LABEL[f]) }))}
          value={sort}
          onChange={(f) => {
            setSort(f);
            setDir(naturalDir(f));
          }}
        />
        {sort === 'random' ? null : (
          <SelectList<'asc' | 'desc'>
            options={[
              { value: 'asc', label: t('Ascending') },
              { value: 'desc', label: t('Descending') },
            ]}
            value={dir}
            onChange={setDir}
          />
        )}
        <TextRow
          label={t('Limit')}
          description={t('At most this many songs. Empty means all of them.')}
          value={limit}
          placeholder={t('No limit')}
          maxLength={NUMBER_MAX}
          onChange={(v) => setLimit(digits(v))}
        />

        <Pressable
          style={({ pressed }) => [styles.save, { backgroundColor: accent }, pressed && { opacity: 0.7 }]}
          accessibilityRole="button"
          onPress={done}
        >
          <Text style={styles.saveText}>{t('Save')}</Text>
        </Pressable>
      </ScrollView>
    </SettingsPage>
  );
}

const styles = themed((colors) => ({
  rule: {
    gap: spacing.sm,
    padding: spacing.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
  },
  ruleTitle: { color: colors.textSecondary, fontSize: fontSize.xs, fontWeight: '700', textTransform: 'uppercase' },
  save: {
    alignSelf: 'center',
    marginTop: spacing.lg,
    borderRadius: radius.pill,
    paddingVertical: spacing.md,
    paddingHorizontal: spacing.xxl,
  },
  saveText: { color: colors.onAccent, fontSize: fontSize.md, fontWeight: '700' },
}));
