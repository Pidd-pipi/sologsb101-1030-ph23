/**
 * usePitchLedger：把一台琴的实时漂移、结论历史、生效结论与「待复核」状态收敛到一起。
 * 被音准账页、调律记录页与提醒页消费。
 */
import { derived, type Readable } from 'svelte/store';
import type { ConclusionRow, EnvironmentRow, TuningRow } from '$lib/utils/db';
import { analyzeDrift, type DriftAnalysis } from '$lib/utils/drift';
import { effectiveConclusion, isStale, liveDrift } from '$lib/stores/ledgerStore';

export interface PitchLedger {
  /** 实时漂移分析（环境一改立即变） */
  live: DriftAnalysis;
  /** 结论历史（最新在前） */
  history: ConclusionRow[];
  /** 当前生效结论（没复核前沿用旧结论） */
  effective: ConclusionRow | null;
  /** 是否有待复核的新结论（环境改动后为 true，直到人工确认） */
  stale: boolean;
}

export function usePitchLedger(
  tunings: Readable<TuningRow[]>,
  environments: Readable<EnvironmentRow[]>,
  conclusions: Readable<ConclusionRow[]>,
  pianoId: Readable<string>
): Readable<PitchLedger> {
  const live = liveDrift(tunings, environments, pianoId);
  const effective = effectiveConclusion(conclusions, pianoId);
  const stale = isStale(live, conclusions, pianoId);

  return derived([live, effective, stale, conclusions, pianoId], ([$live, $effective, $stale, $conclusions, $pianoId]) => ({
    live: $live as DriftAnalysis,
    history: $conclusions
      .filter((c) => c.pianoId === $pianoId)
      .sort((a, b) => b.createdAt - a.createdAt),
    effective: $effective as ConclusionRow | null,
    stale: $stale as boolean
  }));
}

/** 非响应式纯函数版（导出 / 测试场景直接调用） */
export function computeLedger(
  pianoId: string,
  tunings: TuningRow[],
  environments: EnvironmentRow[],
  conclusions: ConclusionRow[]
): { live: DriftAnalysis; effective: ConclusionRow | null } {
  const live = analyzeDrift(pianoId, tunings, environments);
  const rows = conclusions
    .filter((c) => c.pianoId === pianoId)
    .sort((a, b) => b.createdAt - a.createdAt);
  const effective = rows.find((c) => c.status === '已确认') ?? rows.find((c) => c.status === '待复核') ?? null;
  return { live, effective };
}
