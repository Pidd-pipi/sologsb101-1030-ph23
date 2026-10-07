/**
 * 音准账 store：漂移结论的查询 / 确认 / 放弃，以及生效结论的选取。
 * 趋势本身由页面用 analyzeDrift 实时派生；这里只管「结论快照」的生命周期。
 */
import { derived, type Readable } from 'svelte/store';
import type { ConclusionRow, TuningRow, EnvironmentRow } from '$lib/utils/db';
import {
  confirmConclusion as confirmConclusionRow,
  dismissConclusion as dismissConclusionRow,
  getEffectiveConclusion
} from '$lib/utils/db';
import { analyzeDrift } from '$lib/utils/drift';

/** 实时漂移（每次调律或环境变动立即重算，不代表已确认结论） */
export function liveDrift(
  tunings: Readable<TuningRow[]>,
  environments: Readable<EnvironmentRow[]>,
  pianoId: Readable<string>
): Readable<ReturnType<typeof analyzeDrift>> {
  return derived([tunings, environments, pianoId], ([$tunings, $environments, $pianoId]) =>
    analyzeDrift(
      $pianoId,
      $tunings.filter((t) => t.pianoId === $pianoId),
      $environments.filter((e) => e.pianoId === $pianoId)
    )
  );
}

/**
 * 当前应生效的结论（响应式）：优先最近「已确认」；没有则回退最近「待复核」。
 * 没复核前提醒与导出都以本函数结果为准——即用旧结论。
 */
export function effectiveConclusion(
  conclusions: Readable<ConclusionRow[]>,
  pianoId: Readable<string>
): Readable<ConclusionRow | null> {
  return derived([conclusions, pianoId], ([$conclusions, $pianoId]) => {
    const rows = $conclusions
      .filter((c) => c.pianoId === $pianoId)
      .sort((a, b) => b.createdAt - a.createdAt);
    return rows.find((c) => c.status === '已确认') ?? rows.find((c) => c.status === '待复核') ?? null;
  });
}

/** 有「待复核」结论的琴数（用于侧栏 / 提醒徽标） */
export const pendingConclusionPianoCount = (conclusions: Readable<ConclusionRow[]>): Readable<number> =>
  derived(conclusions, ($conclusions) => new Set($conclusions.filter((c) => c.status === '待复核').map((c) => c.pianoId)).size);

/** 实时漂移相对最新结论是否已发生变化（环境改动后提示「待复核」） */
export function isStale(
  live: Readable<ReturnType<typeof analyzeDrift>>,
  conclusions: Readable<ConclusionRow[]>,
  pianoId: Readable<string>
): Readable<boolean> {
  return derived([live, conclusions, pianoId], ([$live, $conclusions, $pianoId]) => {
    const latest = $conclusions
      .filter((c) => c.pianoId === $pianoId)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!latest) return $live.sampleCount > 0;
    return latest.envFingerprint !== $live.envFingerprint || latest.status === '已失效';
  });
}

export async function confirmConclusion(id: string): Promise<void> {
  await confirmConclusionRow(id);
}

export async function dismissConclusion(id: string): Promise<void> {
  await dismissConclusionRow(id);
}

/** 异步取生效结论（导出 / 提醒页非响应式场景使用） */
export async function fetchEffectiveConclusion(pianoId: string): Promise<ConclusionRow | null> {
  return getEffectiveConclusion(pianoId);
}
