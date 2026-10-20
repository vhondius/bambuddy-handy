import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Loader2, X } from 'lucide-react';
import { api } from '../api/client';
import type { LocalPreset } from '../api/client';
import type { SettingValue } from '../types/slicerSettings';
import { Button } from './Button';
import SlicerSettingsPanel from './SlicerSettingsPanel';
import { useToast } from '../contexts/ToastContext';

const SETTINGS_ID_KEYS = ['print_settings_id', 'filament_settings_id', 'printer_settings_id'];

/**
 * Edit or duplicate a local preset. Process presets get the OrcaSlicer-style
 * settings panel, with the raw JSON one tab away; filament and printer
 * presets have no option schema here, so they are JSON only.
 */
export function LocalPresetEditModal({
  preset,
  mode,
  onClose,
}: {
  preset: LocalPreset;
  mode: 'edit' | 'duplicate';
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const isProcess = preset.preset_type === 'process';

  const { data: detail } = useQuery({
    queryKey: ['localPresetDetail', preset.id],
    queryFn: () => api.getLocalPresetDetail(preset.id),
  });
  const { data: presetValues, isLoading: valuesLoading, isError: valuesError } = useQuery({
    queryKey: ['slicer-preset-values', 'local', String(preset.id)],
    queryFn: () => api.getSlicerPresetValues({ source: 'local', id: String(preset.id) }),
    enabled: isProcess,
  });

  const [name, setName] = useState(
    mode === 'duplicate' ? t('profiles.localProfiles.copyName', { name: preset.name }) : preset.name,
  );
  const [tab, setTab] = useState<'settings' | 'json'>(isProcess ? 'settings' : 'json');
  const [setting, setSetting] = useState<Record<string, unknown> | null>(null);
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  // The panel's edits on top of `setting`, folded in on save or tab switch.
  const [values, setValues] = useState<Record<string, SettingValue>>({});
  const [serialized, setSerialized] = useState<Record<string, string | string[]>>({});

  useEffect(() => {
    if (detail && setting === null) {
      setSetting(detail.setting);
      setJsonText(JSON.stringify(detail.setting, null, 2));
    }
  }, [detail, setting]);

  // The stored setting is already flattened, in the same string forms the
  // sidecar returns, so it overlays the sidecar's values as the baseline —
  // which also keeps the panel in step with edits made on the JSON tab.
  const baseline = useMemo(
    () => ({ ...(presetValues?.values ?? {}), ...(setting ?? {}) }) as Record<string, SettingValue>,
    [presetValues, setting],
  );

  const folded = () => ({ ...(setting ?? {}), ...serialized });

  const switchTab = (next: 'settings' | 'json') => {
    if (next === tab) return;
    if (next === 'json') {
      const merged = folded();
      setSetting(merged);
      setJsonText(JSON.stringify(merged, null, 2));
      setValues({});
      setSerialized({});
    }
    setTab(next);
  };

  const onJsonChange = (text: string) => {
    setJsonText(text);
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('not an object');
      setSetting(parsed);
      setJsonError(null);
    } catch (e) {
      setJsonError((e as Error).message);
    }
  };

  // "Save as new" from Edit leaves the original as it was.
  const save = useMutation({
    mutationFn: (asNew: boolean) => {
      // Two presets of one name can't be told apart in the slice dialog.
      const finalName = asNew && name === preset.name ? t('profiles.localProfiles.copyName', { name }) : name;
      const final: Record<string, unknown> = { ...folded(), name: finalName };
      // The preset's own name is repeated in its *_settings_id; keep it in step.
      for (const key of SETTINGS_ID_KEYS) {
        if (key in final) final[key] = Array.isArray(final[key]) ? [finalName] : finalName;
      }
      return asNew
        ? api.createLocalPreset({ name: finalName, preset_type: preset.preset_type, setting: final })
        : api.updateLocalPreset(preset.id, { name: finalName, setting: final });
    },
    onSuccess: (_, asNew) => {
      queryClient.invalidateQueries({ queryKey: ['localPresets'] });
      queryClient.invalidateQueries({ queryKey: ['slicerPresets'] });
      queryClient.removeQueries({ queryKey: ['localPresetDetail', preset.id] });
      queryClient.removeQueries({ queryKey: ['slicer-preset-values', 'local', String(preset.id)] });
      showToast(t(asNew ? 'profiles.localProfiles.toast.created' : 'profiles.localProfiles.toast.updated'));
      onClose();
    },
    onError: (err: Error) => showToast(err.message, 'error'),
  });

  const canSave = setting !== null && !jsonError && !!name.trim() && !save.isPending;

  const tabClass = (on: boolean) =>
    `px-3 py-1.5 text-sm border-b-2 ${on ? 'text-bambu-green border-bambu-green' : 'text-bambu-gray border-transparent hover:text-white'}`;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-bambu-dark-secondary border border-bambu-dark-tertiary w-full h-full md:h-auto md:max-h-[90vh] md:max-w-4xl md:rounded-lg flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-bambu-dark-tertiary">
          <h3 className="text-white font-medium">
            {t(mode === 'edit' ? 'profiles.localProfiles.editTitle' : 'profiles.localProfiles.duplicateTitle')}
          </h3>
          <button onClick={onClose} className="p-1 text-bambu-gray hover:text-white" aria-label={t('profiles.localProfiles.cancel')}>
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <label className="block">
            <span className="block text-xs text-bambu-gray mb-1">{t('profiles.localProfiles.name')}</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2 rounded-md bg-bambu-dark border border-bambu-dark-tertiary text-white text-sm focus:outline-none focus:border-bambu-green"
            />
          </label>

          {setting === null ? (
            <div className="flex justify-center py-8">
              <Loader2 className="w-6 h-6 text-bambu-green animate-spin" />
            </div>
          ) : (
            <>
              {isProcess && (
                <div className="flex gap-1 border-b border-bambu-dark-tertiary">
                  <button className={tabClass(tab === 'settings')} onClick={() => switchTab('settings')} disabled={!!jsonError}>
                    {t('profiles.localProfiles.tabSettings')}
                  </button>
                  <button className={tabClass(tab === 'json')} onClick={() => switchTab('json')}>
                    {t('profiles.localProfiles.tabJson')}
                  </button>
                </div>
              )}
              {tab === 'settings' ? (
                <SlicerSettingsPanel
                  values={values}
                  onChange={(v, s) => {
                    setValues(v);
                    setSerialized(s);
                  }}
                  presetValues={baseline}
                  presetValuesResolved={presetValues?.resolved ?? valuesLoading}
                  presetValuesReason={presetValues?.reason ?? (valuesError ? 'sidecar_unavailable' : undefined)}
                />
              ) : (
                <div>
                  <textarea
                    value={jsonText}
                    onChange={(e) => onJsonChange(e.target.value)}
                    spellCheck={false}
                    className="w-full h-[50vh] px-3 py-2 rounded-md bg-bambu-dark border border-bambu-dark-tertiary text-white text-xs font-mono focus:outline-none focus:border-bambu-green"
                  />
                  {jsonError && (
                    <p className="text-red-400 text-xs mt-1">{t('profiles.localProfiles.invalidJson', { error: jsonError })}</p>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 p-4 border-t border-bambu-dark-tertiary">
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t('profiles.localProfiles.cancel')}
          </Button>
          {mode === 'edit' && (
            <Button variant="secondary" size="sm" onClick={() => save.mutate(true)} disabled={!canSave}>
              {t('profiles.localProfiles.saveAsNew')}
            </Button>
          )}
          <Button size="sm" onClick={() => save.mutate(mode === 'duplicate')} disabled={!canSave}>
            {save.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
            {t('profiles.localProfiles.save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
