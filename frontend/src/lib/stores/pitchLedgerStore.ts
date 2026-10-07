/**
 * 音准账 store：把调律记录、琴房环境与周期提醒接成一条音准账。
 *
 * - 趋势（漂移快慢 / 建议）为纯派生：环境记录一改动，entries 与 trend 立即重算；
 * - 已确认结论持久化保留全部历史：最新一条已确认结论若指纹落后于当前环境，标记「待复核」；
 * - 在人工复核确认前，提醒与导出照旧使用最新一条已确认结论（effectiveConcluded = true）。
 */
import { derived, type Readable } from 'svelte/store';
import type { TuningRow, EnvironmentRow, ConclusionRow } from '$lib/utils/db';
import { putConclusion, removeConclusion } from '$lib/utils/db';
import { buildRow } from '$lib/hooks/useIdbTable';
import type { AdviceLevel, DriftLevel, PitchConclusion } from '$lib/types/pitchLedger';
import { buildLedgerEntries, calcDriftTrend, envFingerprint, type LedgerEntry } from '$lib/utils/ledger';

/** 复核状态：有已确认结论且指纹有效 / 环境已改需复核 / 还没有结论 */
export type LedgerStatus = '已确认' | '待复核' | '无结论';

/** 提醒与导出实际采用的结论来源 */
export type EffectiveSource = '已确认结论' | '当前测算（尚未确认）';

/** 单台琴的音准账 */
export interface PianoLedger {
  pianoId: string;
  /** 时间升序的账面条目（调律 + 温湿度） */
  entries: LedgerEntry[];
  /** 实时测算的漂移趋势（环境一改即重算） */
  live: ReturnType<typeof calcDriftTrend>;
  /** 结论历史（最新确认的在前） */
  conclusions: ConclusionRow[];
  /** 最新一条已确认结论（可能已因环境改动而待复核） */
  latestConclusion: ConclusionRow | null;
  status: LedgerStatus;
  /** 提醒 / 导出实际使用的漂移档位 */
  effectiveLevel: DriftLevel;
  /** 提醒 / 导出实际使用的建议等级 */
  effectiveAdviceLevel: AdviceLevel;
  effectiveAdviceText: string;
  effectiveDriftCentsPerMonth: number;
  effectiveSource: EffectiveSource;
}

/** 纯函数：汇总一台琴的音准账 */
export function buildPianoLedger(
  pianoId: string,
  tunings: TuningRow[],
  environments: EnvironmentRow[],
  conclusions: ConclusionRow[]
): PianoLedger {
  const ownTunings = tunings.filter((item) => item.pianoId === pianoId);
  const ownEnvs = environments.filter((item) => item.pianoId === pianoId);
  const ownConclusions = conclusions
    .filter((item) => item.pianoId === pianoId)
    .sort((a, b) => b.confirmedAt.localeCompare(a.confirmedAt));
  const latest = ownConclusions[0] ?? null;

  // 待确认的并发冲突记录暂不参与趋势测算，等人工裁决后入账
  const confirmedTunings = ownTunings.filter((item) => !item.pendingReview);
  const entries = buildLedgerEntries(confirmedTunings, ownEnvs);
  const live = calcDriftTrend(pianoId, entries, ownEnvs);
  const currentFingerprint = envFingerprint(ownEnvs, pianoId);

  let status: LedgerStatus = '无结论';
  if (latest) {
    status = latest.envFingerprint === currentFingerprint ? '已确认' : '待复核';
  }

  // 未复核前（含待复核）提醒与导出照旧用旧结论；没有任何结论时才用当前测算
  const useConclusion = latest !== null;
  return {
    pianoId,
    entries,
    live,
    conclusions: ownConclusions,
    latestConclusion: latest,
    status,
    effectiveLevel: useConclusion ? latest.level : live.level,
    effectiveAdviceLevel: useConclusion ? latest.adviceLevel : live.adviceLevel,
    effectiveAdviceText: useConclusion ? latest.adviceText : live.adviceText,
    effectiveDriftCentsPerMonth: useConclusion ? latest.driftCentsPerMonth : live.driftCentsPerMonth,
    effectiveSource: useConclusion ? '已确认结论' : '当前测算（尚未确认）'
  };
}

/** 全部琴的音准账（按钢琴 id 索引） */
export function usePitchLedgers(
  tunings: Readable<TuningRow[]>,
  environments: Readable<EnvironmentRow[]>,
  conclusions: Readable<ConclusionRow[]>
): Readable<Map<string, PianoLedger>> {
  return derived([tunings, environments, conclusions], ([$tunings, $envs, $conclusions]) => {
    const pianoIds = new Set<string>([
      ...$tunings.map((item) => item.pianoId),
      ...$envs.map((item) => item.pianoId),
      ...$conclusions.map((item) => item.pianoId)
    ]);
    const map = new Map<string, PianoLedger>();
    for (const pianoId of pianoIds) {
      map.set(pianoId, buildPianoLedger(pianoId, $tunings, $envs, $conclusions));
    }
    return map;
  });
}

/** 单台琴的音准账（pianoId 变化自动重算） */
export function usePianoPitchLedger(
  tunings: Readable<TuningRow[]>,
  environments: Readable<EnvironmentRow[]>,
  conclusions: Readable<ConclusionRow[]>,
  pianoId: Readable<string | null>
): Readable<PianoLedger | null> {
  return derived(
    [tunings, environments, conclusions, pianoId],
    ([$tunings, $envs, $conclusions, $pianoId]) =>
      $pianoId ? buildPianoLedger($pianoId, $tunings, $envs, $conclusions) : null
  );
}

/** 确认输入：通常直接采用当前测算结果 */
export interface ConfirmConclusionInput {
  pianoId: string;
  confirmer: string;
  driftCentsPerMonth: number;
  level: DriftLevel;
  envFingerprint: string;
  adviceLevel: AdviceLevel;
  adviceText: string;
  note?: string;
}

/** 确认一条新结论（旧结论永久保留在历史里） */
export async function confirmPitchConclusion(input: ConfirmConclusionInput): Promise<string> {
  const payload: Omit<PitchConclusion, 'id'> = {
    pianoId: input.pianoId,
    confirmedAt: new Date().toISOString(),
    confirmer: input.confirmer,
    driftCentsPerMonth: input.driftCentsPerMonth,
    level: input.level,
    envFingerprint: input.envFingerprint,
    adviceLevel: input.adviceLevel,
    adviceText: input.adviceText,
    status: '已确认',
    note: input.note ?? ''
  };
  const row = buildRow(payload, 'pc');
  await putConclusion(row);
  return row.id;
}

export async function deletePitchConclusion(id: string): Promise<void> {
  await removeConclusion(id);
}
