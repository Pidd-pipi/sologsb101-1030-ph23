/**
 * 调律 store：维护调律记录、基准音高与音分偏差派生值。
 * 保存时自动挂接同期温湿度；多标签页并发保存同一天调律时不互相覆盖，双方都保留待确认。
 */
import { writable, type Writable } from 'svelte/store';
import type { FilterModel } from '$lib/types/filter';
import type { Tuning } from '$lib/types/tuning';
import {
  db,
  discardTuningReview as discardReviewRow,
  listEnvironments,
  putTuning,
  relinkTuningEnvironments,
  resolveTuningReview as resolveReviewRow,
  removeTuning,
  updateTuning as updateTuningRow
} from '$lib/utils/db';
import { buildRow } from '$lib/hooks/useIdbTable';
import { linkEnvironment } from '$lib/utils/ledger';
import { createId } from '$lib/utils/uuid';

export const TUNING_FILTER_KEYS = ['pianoIds', 'pitchRaisedOnly'];

/** 调律记录筛选条件（含「仅看需复调」开关） */
export const tuningFilters: Writable<FilterModel> = writable({
  keyword: '',
  pianoIds: [],
  switch: false
});

export function setTuningFilters(next: FilterModel): void {
  tuningFilters.set(next);
}

export function resetTuningFilters(): void {
  tuningFilters.set({ keyword: '', pianoIds: [], switch: false });
}

/** 保存结果：是否落入待确认冲突组 */
export interface TuningSaveResult {
  id: string;
  pendingReview: boolean;
}

/**
 * 新增调律（并发安全）：
 * - 先按同期最近一条环境记录挂温湿度；
 * - 若同台琴同一天已有调律（另一标签页刚补录），不覆盖任何一方：
 *   两条都打上同一 reviewGroupId 待确认标记，等人裁决。
 */
export async function createTuning(payload: Omit<Tuning, 'id'>): Promise<TuningSaveResult> {
  const environments = await listEnvironments();
  const env = linkEnvironment({ ...payload, env: null } as Tuning, environments);
  const row = buildRow({ ...payload, env }, 'tuning');

  const sameDay = await db.tunings
    .where('pianoId')
    .equals(row.pianoId)
    .filter((item) => item.date === row.date)
    .toArray();
  const others = sameDay.filter((item) => item.id !== row.id);

  if (others.length > 0) {
    const existingGroup = others.find((item) => item.pendingReview && item.reviewGroupId)?.reviewGroupId;
    const groupId = existingGroup || createId('rv');
    row.pendingReview = true;
    row.reviewGroupId = groupId;
    row.reviewReason = '检测到另一标签页在同一天保存了调律，两条都先保留，待人工确认。';
    const now = Date.now();
    await db.transaction('rw', db.tunings, async () => {
      await db.tunings.put(row);
      for (const other of others) {
        if (!other.pendingReview || other.reviewGroupId !== groupId) {
          await db.tunings.update(other.id, {
            pendingReview: true,
            reviewGroupId: groupId,
            reviewReason: '检测到另一标签页在同一天保存了调律，两条都先保留，待人工确认。',
            updatedAt: now
          } as never);
        }
      }
    });
    return { id: row.id, pendingReview: true };
  }

  await putTuning(row);
  return { id: row.id, pendingReview: false };
}

/** 编辑调律：日期 / 琴变化后按最新环境重新挂接温湿度 */
export async function editTuning(id: string, patch: Partial<Tuning>): Promise<void> {
  await updateTuningRow(id, patch);
  await relinkTuningEnvironments();
}

export async function deleteTuning(id: string): Promise<void> {
  await removeTuning(id);
}

/** 冲突裁决：保留某一条，删除同组其余记录 */
export async function resolveTuningConflict(groupId: string, keptId: string): Promise<void> {
  await resolveReviewRow(groupId, keptId);
}

/** 丢弃某条待确认记录（组内只剩一条时自动转正） */
export async function discardTuningConflict(id: string): Promise<void> {
  await discardReviewRow(id);
}
