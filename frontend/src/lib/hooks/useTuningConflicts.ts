/**
 * 多标签页并发保存冲突分组。
 * 同一 reviewGroupId 下的调律记录为一组，两边都保留，等待人工确认保留哪一条。
 */
import { derived, type Readable } from 'svelte/store';
import type { TuningRow } from '$lib/utils/db';

export interface TuningConflictGroup {
  groupId: string;
  reason: string;
  pianoId: string;
  date: string;
  members: TuningRow[];
}

/** 纯函数：把待确认调律按 reviewGroupId 聚成冲突组（组内按更新时间倒序） */
export function groupConflicts(tunings: TuningRow[]): TuningConflictGroup[] {
  const map = new Map<string, TuningRow[]>();
  for (const tuning of tunings) {
    if (!tuning.pendingReview || !tuning.reviewGroupId) continue;
    const list = map.get(tuning.reviewGroupId) ?? [];
    list.push(tuning);
    map.set(tuning.reviewGroupId, list);
  }
  const groups: TuningConflictGroup[] = [];
  for (const [groupId, members] of map) {
    const sorted = members.sort((a, b) => b.updatedAt - a.updatedAt);
    const first = sorted[0];
    groups.push({
      groupId,
      reason: first.reviewReason || '两条同一天的调律记录需要人工确认。',
      pianoId: first.pianoId,
      date: first.date,
      members: sorted
    });
  }
  return groups.sort((a, b) => b.date.localeCompare(a.date));
}

/** Store 版：响应式冲突分组 */
export function useTuningConflicts(tunings: Readable<TuningRow[]>): Readable<TuningConflictGroup[]> {
  return derived(tunings, ($tunings) => groupConflicts($tunings));
}
