import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, Loader2, Printer as PrinterIcon, X } from 'lucide-react';
import {
  api,
  ApiError,
  type MakerworldPlateObject,
  type MakerworldPrintResult,
  type PresetRef,
  type SliceJobState,
} from '../api/client';
import { buildAmsMapping, buildFilamentComparison, buildLoadedFilaments } from '../hooks/useFilamentMapping';
import { getCurrencySymbol } from '../utils/currency';
import type { SettingValue } from '../types/slicerSettings';
import SlicerSettingsPanel from './SlicerSettingsPanel';
import { findPreset } from '../utils/slicePresetPicker';
import { buildCompatibilityIndex } from '../utils/slicerPrinterMatch';
import { useToast } from '../contexts/ToastContext';
import { formatDuration } from '../utils/date';
import { Button } from './Button';
import { GcodeToolpathViewer } from './GcodeToolpathViewer';
import { PrintModal } from './PrintModal';
import { FilamentMapping } from './PrintModal/FilamentMapping';
import { BedTypeDropdown, PresetDropdown, SliceModal, type SliceSource } from './SliceModal';

declare global {
  interface Window {
    /** Set by the Bambuddy Handy Android app. */
    BambuddyHandyApp?: { closeFlow: () => void };
    /** Called by the app's Back button; true when the flow handled it. */
    BambuddyHandyBack?: () => boolean;
  }
}

interface PrinterChoice {
  id: number;
  name: string;
  model: string | null;
}

type Step =
  | { kind: 'starting' }
  | { kind: 'pickPrinter'; printers: PrinterChoice[] }
  | { kind: 'slicing'; jobId: number; job: SliceJobState | null }
  | { kind: 'preview'; result: MakerworldPrintResult }
  | { kind: 'editSettings'; result: MakerworldPrintResult }
  | { kind: 'error'; message: string; handover?: Handover };

/** Where the flow hands over instead of guessing (requirement D): the
 *  printer settings (no go-to profile), the Slice dialog (unsliced model),
 *  or the Print dialog (sliced, but the AMS match needs a human). */
type Handover =
  | { to: 'printerSettings' }
  | { to: 'slice'; source: SliceSource }
  | { to: 'print'; libraryFileId: number; name: string; printerId: number };

interface MakerworldPrintFlowProps {
  /** MakerWorld model URL, including any #profileId-… fragment. */
  url: string;
  printerId?: number | null;
  /** Resume an already-started flow (e.g. back from the G-code preview)
   *  instead of importing and slicing again. */
  jobId?: number | null;
  /** Called once the slice job exists, so the page can put it in the URL. */
  onJobStarted?: (jobId: number) => void;
  onClose: () => void;
}

/** "Edit settings" on the preview: the panel's state, and what the re-slice sends. */
interface Edits {
  values: Record<string, SettingValue>;
  serialized: Record<string, string | string[]>;
  designKeys: string[];
  /** Null for a slot: picked to suit the chosen tray. */
  filaments: (PresetRef | null)[];
  bedType: string | null;
  slotTrays?: (number | null)[];
  /** Objects left out, as "object_id:instance_id". */
  excludedObjects?: string[];
}

/** Tray per project slot from the preview's picks, per plate. The plate on
 *  screen wins when two plates chose differently for one slot. */
function slotTraysFromPicks(picks: Record<number, Record<number, number>>, plate: number): (number | null)[] {
  const merged: Record<number, number> = {};
  for (const plateNum of Object.keys(picks)) Object.assign(merged, picks[Number(plateNum)]);
  Object.assign(merged, picks[plate]);
  const slots = Object.keys(merged).map(Number);
  if (slots.length === 0) return [];
  return Array.from({ length: Math.max(...slots) }, (_, i) => merged[i + 1] ?? null);
}

/**
 * One-tap "print from a MakerWorld link": resolve → import → slice (a
 * background slice job, progress over the WebSocket) → preview → queue on
 * confirm. Full-screen on phones, a centred sheet from `md` up.
 */
export function MakerworldPrintFlow({ url, printerId, jobId: resumeJobId, onJobStarted, onClose }: MakerworldPrintFlowProps) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const [step, setStep] = useState<Step>(
    resumeJobId ? { kind: 'slicing', jobId: resumeJobId, job: null } : { kind: 'starting' },
  );
  const [openDialog, setOpenDialog] = useState<Handover | null>(null);
  // In the Bambuddy Handy app the flow is a sheet over the MakerWorld tab it
  // was started from: closing it goes back there rather than leaving the user
  // in the rest of Bambuddy.
  const closeFlow = () => {
    onClose();
    window.BambuddyHandyApp?.closeFlow();
  };
  // The G-code preview opens over the flow rather than on Bambuddy's viewer
  // page, so leaving it comes back here instead of into the rest of the app.
  const [showGcode, setShowGcode] = useState(false);

  // The app's Back button steps out of the flow one layer at a time — the
  // G-code preview, a hand-over dialog, the settings editor — and only then
  // closes it, instead of walking the page history into the rest of
  // Bambuddy. The app asks through this hook and falls back to its own Back
  // when it is absent or returns false.
  const backRef = useRef<() => boolean>(() => false);
  backRef.current = () => {
    if (showGcode) setShowGcode(false);
    else if (openDialog) setOpenDialog(null);
    else if (step.kind === 'editSettings') setStep({ kind: 'preview', result: step.result });
    else closeFlow();
    return true;
  };
  useEffect(() => {
    window.BambuddyHandyBack = () => backRef.current();
    return () => {
      delete window.BambuddyHandyBack;
    };
  }, []);
  // Kept across re-slices so a second edit starts from the first one.
  const [edits, setEdits] = useState<Edits | null>(null);
  // Also kept across re-slices: the plate on screen and the trays picked per plate.
  const [plateIdx, setPlateIdx] = useState(0);
  const [trayPicks, setTrayPicks] = useState<Record<number, Record<number, number>>>({});
  const [resliceNote, setResliceNote] = useState<string | null>(null);
  const handOver = (h: Handover) => {
    if (h.to === 'printerSettings') {
      onClose();
      navigate('/printers');
    } else {
      setOpenDialog(h);
    }
  };

  const start = useCallback(
    async (chosenPrinterId?: number | null, withEdits: Edits | null = null) => {
      setStep({ kind: 'starting' });
      try {
        const started = await api.startMakerworldPrint(
          url,
          chosenPrinterId,
          withEdits && {
            process_overrides: withEdits.serialized,
            design_overrides: withEdits.designKeys,
            filament_presets: withEdits.filaments,
            bed_type: withEdits.bedType,
            ...(withEdits.slotTrays?.length ? { slot_trays: withEdits.slotTrays } : {}),
            ...(withEdits.excludedObjects?.length ? { excluded_objects: withEdits.excludedObjects } : {}),
          },
        );
        setStep({ kind: 'slicing', jobId: started.job_id, job: null });
        onJobStarted?.(started.job_id);
      } catch (err) {
        if (err instanceof ApiError && err.code === 'printer_required') {
          setStep({ kind: 'pickPrinter', printers: (err.detail?.printers as PrinterChoice[]) ?? [] });
        } else if (err instanceof ApiError && err.code === 'goto_profile_missing') {
          setStep({ kind: 'error', message: t('makerworld.printFlow.gotoMissing'), handover: { to: 'printerSettings' } });
        } else if (err instanceof ApiError && err.code === 'slicer_unreachable') {
          setStep({ kind: 'error', message: `${t('makerworld.printFlow.slicerUnreachable')}\n${err.message}` });
        } else {
          setStep({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
        }
      }
    },
    [url, onJobStarted, t],
  );

  useEffect(() => {
    if (!resumeJobId) start(printerId);
    // Mount-only: a resumed job id must not restart the flow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const jobId = step.kind === 'slicing' ? step.jobId : null;
  useEffect(() => {
    if (jobId === null) return;
    const apply = (job: SliceJobState) => {
      if (job.job_id !== jobId) return;
      setStep((prev) => {
        if (prev.kind !== 'slicing') return prev;
        if (job.status === 'completed') {
          const result = job.result as MakerworldPrintResult;
          if (result.block === 'bed_overflow' || result.block === 'no_filament_preset') {
            // Nothing sliced (and never scaled): the model goes to the Slice dialog.
            return {
              kind: 'error',
              message: t(`makerworld.printFlow.blocks.${result.block}`),
              handover: {
                to: 'slice',
                source: {
                  kind: 'libraryFile',
                  id: result.source_library_file_id,
                  filename: result.source_filename ?? '',
                },
              },
            };
          }
          return { kind: 'preview', result };
        }
        if (job.status === 'failed') {
          return { kind: 'error', message: job.error_detail ?? t('makerworld.printFlow.sliceFailed') };
        }
        return { ...prev, job };
      });
    };
    const onEvent = (e: Event) => apply((e as CustomEvent<SliceJobState>).detail);
    window.addEventListener('bambuddy:slice-job', onEvent);
    // One fetch covers a job that finished before the listener was attached;
    // the slow poll only matters when the WebSocket is down.
    const poll = () =>
      api
        .getSliceJob(jobId)
        .then(apply)
        .catch((err) => {
          // Gone (the server restarted, or it finished long ago): say so
          // instead of waiting forever. Other errors are retried by the poll.
          if (err instanceof ApiError && err.status === 404) {
            setStep((prev) =>
              prev.kind === 'slicing' && prev.jobId === jobId
                ? { kind: 'error', message: t('makerworld.printFlow.jobLost') }
                : prev,
            );
          }
        });
    poll();
    const id = window.setInterval(poll, 10000);
    return () => {
      window.removeEventListener('bambuddy:slice-job', onEvent);
      window.clearInterval(id);
    };
  }, [jobId, t]);

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex md:items-center md:justify-center md:p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('makerworld.printFlow.title')}
        className={`bg-bambu-dark-secondary w-full h-full md:h-auto md:max-h-[90vh] ${step.kind === 'editSettings' ? 'md:max-w-4xl' : 'md:max-w-lg'} md:rounded-xl overflow-y-auto flex flex-col`}
      >
        <div className="flex items-center justify-between p-4 border-b border-bambu-dark-tertiary">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <PrinterIcon className="w-5 h-5 text-bambu-green" />
            {t('makerworld.printFlow.title')}
          </h2>
          <button type="button" onClick={closeFlow} className="p-2 text-bambu-gray hover:text-white" aria-label={t('common.close')}>
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-4 flex-1">
          {(step.kind === 'starting' || step.kind === 'slicing') && resliceNote && (
            <p className="text-sm text-center text-bambu-gray">{resliceNote}</p>
          )}
          {step.kind === 'starting' && <Busy label={t('makerworld.printFlow.preparing')} />}
          {step.kind === 'slicing' && (
            <Busy
              // The job downloads the model before the slicer reports stages.
              label={step.job?.progress?.stage ?? t('makerworld.printFlow.preparing')}
              percent={step.job?.progress?.total_percent}
            />
          )}
          {step.kind === 'pickPrinter' && (
            <div className="space-y-2">
              <p className="text-sm text-bambu-gray">{t('makerworld.printFlow.pickPrinter')}</p>
              {step.printers.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => start(p.id)}
                  className="w-full text-left p-3 rounded-lg bg-bambu-dark hover:bg-bambu-dark-tertiary text-white"
                >
                  {p.name}
                  {p.model && <span className="text-bambu-gray text-sm"> · {p.model}</span>}
                </button>
              ))}
            </div>
          )}
          {step.kind === 'error' && (
            <div className="space-y-4">
              <p className="text-red-400 text-sm whitespace-pre-line break-words">{step.message}</p>
              <div className="flex flex-wrap gap-2">
                {step.handover && (
                  <Button onClick={() => handOver(step.handover!)}>{handoverLabel(step.handover, t)}</Button>
                )}
                <Button variant="secondary" onClick={() => start(printerId, edits)}>
                  {t('makerworld.printFlow.retry')}
                </Button>
              </div>
            </div>
          )}
          {step.kind === 'editSettings' && (
            <EditSettings
              result={step.result}
              plate={step.result.plates[plateIdx]?.plate ?? 1}
              edits={edits}
              onCancel={() => setStep({ kind: 'preview', result: step.result })}
              onSave={(next) => {
                const withTrays = {
                  ...next,
                  slotTrays: slotTraysFromPicks(trayPicks, step.result.plates[plateIdx]?.plate ?? 1),
                };
                setEdits(withTrays);
                setResliceNote(null);
                start(step.result.printer_id, withTrays);
              }}
            />
          )}
          {step.kind === 'preview' && (
            <Preview
              result={step.result}
              plateIdx={plateIdx}
              setPlateIdx={setPlateIdx}
              trayPicks={trayPicks}
              onPick={(plate, picks) => setTrayPicks((prev) => ({ ...prev, [plate]: picks }))}
              onResliceForSpool={(plate, picks, slotId, material) => {
                const allPicks = { ...trayPicks, [plate]: picks };
                const filaments = [...(edits?.filaments ?? step.result.filament_presets ?? [])];
                filaments[slotId - 1] = null;
                const next: Edits = {
                  values: edits?.values ?? {},
                  serialized: edits?.serialized ?? {},
                  designKeys: edits?.designKeys ?? step.result.design_overrides ?? [],
                  bedType: edits ? edits.bedType : (step.result.bed_type ?? null),
                  filaments,
                  slotTrays: slotTraysFromPicks(allPicks, plate),
                  excludedObjects: edits?.excludedObjects ?? step.result.excluded_objects,
                };
                setTrayPicks(allPicks);
                setEdits(next);
                setResliceNote(t('makerworld.printFlow.reslicingFor', { material }));
                start(step.result.printer_id, next);
              }}
              onHandOver={handOver}
              onEditSettings={() => setStep({ kind: 'editSettings', result: step.result })}
              showGcode={showGcode}
              setShowGcode={setShowGcode}
              onDone={() => {
                showToast(t('makerworld.printFlow.queued'), 'success');
                onClose();
              }}
            />
          )}
        </div>
      </div>
      {openDialog?.to === 'slice' && <SliceModal source={openDialog.source} onClose={() => setOpenDialog(null)} />}
      {openDialog?.to === 'print' && (
        <PrintModal
          mode="create"
          libraryFileId={openDialog.libraryFileId}
          archiveName={openDialog.name}
          initialSelectedPrinterIds={[openDialog.printerId]}
          onClose={() => setOpenDialog(null)}
          onSuccess={closeFlow}
        />
      )}
    </div>
  );
}

function handoverLabel(h: Handover, t: (key: string) => string): string {
  if (h.to === 'printerSettings') return t('makerworld.printFlow.openPrinterSettings');
  if (h.to === 'slice') return t('makerworld.printFlow.openSliceDialog');
  return t('makerworld.printFlow.openPrintDialog');
}

function Busy({ label, percent }: { label: string; percent?: number }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-12 text-bambu-gray">
      <Loader2 className="w-8 h-8 animate-spin text-bambu-green" />
      <span className="text-sm text-center">
        {label}
        {percent != null && percent > 0 && ` (${Math.round(percent)}%)`}
      </span>
    </div>
  );
}

function Preview({
  result,
  plateIdx,
  setPlateIdx,
  trayPicks,
  onPick,
  onResliceForSpool,
  onDone,
  onHandOver,
  onEditSettings,
  showGcode,
  setShowGcode,
}: {
  result: MakerworldPrintResult;
  plateIdx: number;
  setPlateIdx: (idx: number) => void;
  trayPicks: Record<number, Record<number, number>>;
  onPick: (plate: number, picks: Record<number, number>) => void;
  onResliceForSpool: (plate: number, picks: Record<number, number>, slotId: number, material: string) => void;
  onDone: () => void;
  onHandOver: (h: Handover) => void;
  onEditSettings: () => void;
  showGcode: boolean;
  setShowGcode: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [queueing, setQueueing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: platesData } = useQuery({
    queryKey: ['library-file-plates', result.library_file_id],
    queryFn: () => api.getLibraryFilePlates(result.library_file_id),
  });
  const { data: status } = useQuery({
    queryKey: ['printerStatus', result.printer_id],
    queryFn: () => api.getPrinterStatus(result.printer_id),
  });

  const flowPlate = result.plates[plateIdx] ?? result.plates[0];
  const plateNum = flowPlate?.plate ?? 1;
  const meta = platesData?.plates.find((p) => p.index === plateNum);
  const { data: settings } = useQuery({ queryKey: ['settings'], queryFn: api.getSettings });
  const { data: filamentReqs, isLoading: reqsLoading } = useQuery({
    queryKey: ['library-file-filament-reqs', result.library_file_id, plateNum],
    queryFn: () => api.getLibraryFileFilamentRequirements(result.library_file_id, plateNum),
  });
  const loaded = useMemo(() => buildLoadedFilaments(status), [status]);
  // The trays on screen: what the user picked, else what the slice mapped.
  const picks = useMemo(() => {
    const chosen = trayPicks[plateNum];
    if (chosen) return chosen;
    const seeded: Record<number, number> = {};
    for (const f of filamentReqs?.filaments ?? []) {
      const tray = flowPlate?.ams_mapping?.[f.slot_id - 1];
      if (tray != null && tray >= 0) seeded[f.slot_id] = tray;
    }
    return seeded;
  }, [trayPicks, plateNum, filamentReqs, flowPlate]);
  const comparison = useMemo(
    () =>
      buildFilamentComparison(filamentReqs, loaded, picks, false, undefined, status?.fila_switch?.installed === true),
    [filamentReqs, loaded, picks, status],
  );
  const mapping = filamentReqs ? buildAmsMapping(comparison) : flowPlate?.ams_mapping;
  const trayMissing = comparison.some((f) => !f.loaded);

  const changePicks = (next: Record<number, number>) => {
    const changed = filamentReqs?.filaments.find((f) => next[f.slot_id] !== picks[f.slot_id]);
    const tray = changed && loaded.find((l) => l.globalTrayId === next[changed.slot_id]);
    // Another tray of the same filament prints the same; another material or
    // product needs its own preset and temperatures.
    const needsReslice =
      changed &&
      tray &&
      (tray.type.toUpperCase() !== changed.type.toUpperCase() ||
        (!!tray.trayInfoIdx && !!changed.tray_info_idx && tray.trayInfoIdx !== changed.tray_info_idx));
    if (needsReslice) onResliceForSpool(plateNum, next, changed.slot_id, tray.type);
    else onPick(plateNum, next);
  };

  const queue = async () => {
    setQueueing(true);
    setError(null);
    try {
      await api.addToQueue({
        printer_id: result.printer_id,
        library_file_id: result.library_file_id,
        plate_id: plateNum,
        ams_mapping: mapping ?? null,
      });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setQueueing(false);
    }
  };

  const block = flowPlate?.block ?? null;
  // slot_id is 1-based, the G-code's tools 0-based.
  const gcodeColors: string[] = [];
  for (const f of meta?.filaments ?? []) if (f.color) gcodeColors[Math.max(0, f.slot_id - 1)] = f.color;

  return (
    <div className="space-y-4">
      {showGcode && (
        <div className="fixed inset-0 z-[60] bg-bambu-dark-secondary flex flex-col">
          <div className="flex-shrink-0 p-2 border-b border-bambu-dark-tertiary">
            <button
              type="button"
              onClick={() => setShowGcode(false)}
              className="inline-flex items-center gap-1.5 p-2 text-sm text-gray-300 hover:text-white"
            >
              <ArrowLeft className="w-4 h-4" />
              {t('makerworld.printFlow.backToPreview')}
            </button>
          </div>
          <GcodeToolpathViewer
            gcodeUrl={`${api.getLibraryFileGcodeUrl(result.library_file_id)}?plate=${plateNum}`}
            filamentColors={gcodeColors.length > 0 ? gcodeColors : undefined}
            className="flex-1 min-h-0"
          />
        </div>
      )}
      {result.notice === 'creator_printer_settings_not_used' && (
        <p className="text-sm rounded-lg p-3 bg-amber-500/10 text-amber-300">
          {t('makerworld.printFlow.creatorPrinterSettingsNotUsed')}
        </p>
      )}
      {result.plates.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {result.plates.map((p, i) => (
            <button
              key={p.plate}
              type="button"
              onClick={() => setPlateIdx(i)}
              className={`px-3 py-1 rounded-full text-sm ${i === plateIdx ? 'bg-bambu-green text-white' : 'bg-bambu-dark text-bambu-gray'}`}
            >
              {t('makerworld.printFlow.plate', { n: p.plate })}
            </button>
          ))}
        </div>
      )}
      <img
        src={api.getLibraryFilePlateThumbnail(result.library_file_id, plateNum)}
        alt={t('makerworld.printFlow.plate', { n: plateNum })}
        className="w-full max-w-xs mx-auto aspect-square object-contain rounded-lg bg-bambu-dark"
      />
      <dl className="grid grid-cols-2 gap-2 text-sm">
        <dt className="text-bambu-gray">{t('makerworld.printFlow.printTime')}</dt>
        <dd className="text-white text-right">{formatDuration(meta?.print_time_seconds ?? result.print_time_seconds)}</dd>
        <dt className="text-bambu-gray">{t('makerworld.printFlow.plateType')}</dt>
        <dd className="text-white text-right break-words">{meta?.bed_type ?? '—'}</dd>
      </dl>
      <FilamentMapping
        printerId={result.printer_id}
        filamentReqs={filamentReqs}
        manualMappings={picks}
        onManualMappingChange={changePicks}
        defaultExpanded
        currencySymbol={getCurrencySymbol(settings?.currency || 'USD')}
        defaultCostPerKg={settings?.default_filament_cost ?? 0}
      />
      {error && <p className="text-red-400 text-sm break-words">{error}</p>}
      {block && <p className="text-sm rounded-lg p-3 bg-red-500/10 text-red-300">{t(`makerworld.printFlow.blocks.${block}`)}</p>}
      <div className="flex flex-wrap gap-2 pt-2">
        <Button
          variant="secondary"
          className="flex-1 min-w-[8rem]"
          onClick={() => setShowGcode(true)}
        >
          {t('makerworld.printFlow.gcodePreview')}
        </Button>
        {result.process_preset && (
          <Button variant="secondary" className="flex-1 min-w-[8rem]" onClick={onEditSettings}>
            {t('makerworld.printFlow.editSettings')}
          </Button>
        )}
        {block ? (
          <Button
            className="flex-1 min-w-[8rem]"
            onClick={() =>
              onHandOver({
                to: 'print',
                libraryFileId: result.library_file_id,
                name: result.name,
                printerId: result.printer_id,
              })
            }
          >
            {t('makerworld.printFlow.openPrintDialog')}
          </Button>
        ) : (
          <Button className="flex-1 min-w-[8rem]" onClick={queue} disabled={queueing || reqsLoading || trayMissing}>
            {queueing ? <Loader2 className="w-4 h-4 animate-spin" /> : t('makerworld.printFlow.print')}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The Slice dialog's process editor on the go-to process preset: values that
 * differ from it are marked, the creator's changes show as "from file" with
 * the ones in use ticked. Saving re-slices.
 */
function EditSettings({
  result,
  plate,
  edits,
  onCancel,
  onSave,
}: {
  result: MakerworldPrintResult;
  plate: number;
  edits: Edits | null;
  onCancel: () => void;
  onSave: (edits: Edits) => void;
}) {
  const { t } = useTranslation();
  const [values, setValues] = useState<Record<string, SettingValue>>(edits?.values ?? {});
  const [serialized, setSerialized] = useState<Record<string, string | string[]>>(edits?.serialized ?? {});
  const [designKeys, setDesignKeys] = useState<Set<string>>(
    () => new Set(edits?.designKeys ?? result.design_overrides ?? []),
  );
  // A slot left for the backend to pick shows what it picked.
  const [filaments, setFilaments] = useState<(PresetRef | null)[]>(() =>
    (edits?.filaments ?? result.filament_presets ?? []).map((f, i) => f ?? result.filament_presets?.[i] ?? null),
  );
  const [bedType, setBedType] = useState<string | null>(edits?.bedType ?? result.bed_type ?? null);
  const [pickingObjects, setPickingObjects] = useState(false);
  const excluded = edits?.excludedObjects ?? result.excluded_objects ?? [];
  const plateObjects = (result.objects ?? []).filter((o) => o.plate === plate);
  const save = (excludedObjects: string[]) =>
    onSave({ values, serialized, designKeys: [...designKeys], filaments, bedType, excludedObjects });
  const process = result.process_preset!;
  const presetsQuery = useQuery({ queryKey: ['slicerPresets'], queryFn: () => api.getSlicerPresets() });
  const printerModelsQuery = useQuery({
    queryKey: ['slicerPrinterModels'],
    queryFn: api.getSlicerPrinterModels,
    staleTime: Infinity,
  });
  const compatIndex = useMemo(() => buildCompatibilityIndex(printerModelsQuery.data ?? {}), [printerModelsQuery.data]);
  const printerName =
    presetsQuery.data && result.printer_preset
      ? (findPreset(presetsQuery.data, result.printer_preset, 'printer')?.name ?? null)
      : null;
  const presetValuesQuery = useQuery({
    queryKey: ['slicer-preset-values', process.source, process.id],
    queryFn: () => api.getSlicerPresetValues(process),
    staleTime: 5 * 60_000,
  });
  // The creator's changes are read from the unsliced source file.
  const { data: sourcePlates } = useQuery({
    queryKey: ['library-file-plates', result.source_library_file_id],
    queryFn: () => api.getLibraryFilePlates(result.source_library_file_id),
  });

  if (pickingObjects) {
    return (
      <ObjectChecklist
        objects={plateObjects}
        excluded={excluded}
        onCancel={() => setPickingObjects(false)}
        onDone={(next) => {
          // Only a changed selection is worth a re-slice.
          if (next.length === excluded.length && next.every((key) => excluded.includes(key))) setPickingObjects(false);
          else save(next);
        }}
      />
    );
  }

  return (
    <div className="space-y-4">
      {plateObjects.length >= 2 && (
        <Button variant="secondary" className="w-full" onClick={() => setPickingObjects(true)}>
          {t('makerworld.printFlow.deselectObjects')}
        </Button>
      )}
      <BedTypeDropdown value={bedType} onChange={setBedType} />
      {presetsQuery.data && filaments.length > 0 && (
        <div className="space-y-3">
          {filaments.map((ref, i) => (
            <PresetDropdown
              key={i}
              label={t('makerworld.printFlow.filamentSlot', { n: i + 1 })}
              slot="filament"
              data={presetsQuery.data}
              value={ref}
              onChange={(next) => setFilaments((prev) => prev.map((f, j) => (j === i ? next : f)))}
              selectedPrinterName={printerName}
              compatIndex={compatIndex}
            />
          ))}
        </div>
      )}
      <SlicerSettingsPanel
        values={values}
        onChange={(v, s) => {
          setValues(v);
          setSerialized(s);
        }}
        presetValues={presetValuesQuery.data?.values as Record<string, SettingValue> | undefined}
        presetValuesResolved={presetValuesQuery.data?.resolved ?? presetValuesQuery.isLoading}
        presetValuesReason={presetValuesQuery.data?.reason ?? (presetValuesQuery.isError ? 'sidecar_unavailable' : undefined)}
        sourceOverrides={sourcePlates?.design_overrides ?? []}
        sourceSelected={designKeys}
        onToggleSource={(key, on) =>
          setDesignKeys((prev) => {
            const next = new Set(prev);
            if (on) next.add(key);
            else next.delete(key);
            return next;
          })
        }
      />
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" className="flex-1 min-w-[8rem]" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button
          className="flex-1 min-w-[8rem]"
          disabled={filaments.some((f) => f == null)}
          onClick={() => save(excluded)}
        >
          {t('makerworld.printFlow.saveAndReslice')}
        </Button>
      </div>
    </div>
  );
}

/** Tick list of one plate's objects. Unticked ones are left out of the slice;
 *  the last one stays, because the slicer rejects an empty plate. */
function ObjectChecklist({
  objects,
  excluded,
  onCancel,
  onDone,
}: {
  objects: MakerworldPlateObject[];
  excluded: string[];
  onCancel: () => void;
  onDone: (excluded: string[]) => void;
}) {
  const { t } = useTranslation();
  const keyOf = (o: MakerworldPlateObject) => `${o.object_id}:${o.instance_id}`;
  const [unticked, setUnticked] = useState(() => new Set(excluded));
  const ticked = objects.filter((o) => !unticked.has(keyOf(o)));
  const totals = new Map<string, number>();
  for (const o of objects) totals.set(o.name, (totals.get(o.name) ?? 0) + 1);
  const seen = new Map<string, number>();
  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-medium text-white">{t('makerworld.printFlow.deselectObjects')}</h3>
        <p className="text-sm text-bambu-gray mt-1">{t('makerworld.printFlow.objectsHint')}</p>
      </div>
      <ul className="space-y-1">
        {objects.map((o) => {
          const key = keyOf(o);
          const isTicked = !unticked.has(key);
          const copy = (seen.get(o.name) ?? 0) + 1;
          seen.set(o.name, copy);
          return (
            <li key={key}>
              <label className="flex items-center gap-3 p-2 rounded-lg bg-bambu-dark text-sm text-white cursor-pointer has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60">
                <input
                  type="checkbox"
                  className="accent-bambu-green w-4 h-4 shrink-0"
                  checked={isTicked}
                  disabled={isTicked && ticked.length === 1}
                  onChange={(e) =>
                    setUnticked((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.delete(key);
                      else next.add(key);
                      return next;
                    })
                  }
                />
                <span className="min-w-0 break-words">
                  {(totals.get(o.name) ?? 0) > 1 ? `${o.name} #${copy}` : o.name}
                </span>
              </label>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" className="flex-1 min-w-[8rem]" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button className="flex-1 min-w-[8rem]" onClick={() => onDone([...unticked])}>
          {t('makerworld.printFlow.objectsDone')}
        </Button>
      </div>
    </div>
  );
}
