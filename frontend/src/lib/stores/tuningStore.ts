/**
 * 调律 store：维护调律记录、基准音高与音分偏差派生值。
 * 保存走 commitTuning：自动接同期温湿度、检测双标签页并发撞车、重算音准账。
 */
import { writable, type Writable } from 'svelte/store';
import type { FilterModel } from '$lib/types/filter';
import type { Tuning } from '$lib/types/tuning';
import {
  commitTuning,
  removeTuning,
  resolveTuningConflict,
  updateTuningAndRecompute,
  type SaveTuningResult
} from '$lib/utils/db';
import { buildRow } from '$lib/hooks/useIdbTable';

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

export async function createTuning(payload: Omit<Tuning, 'id'>): Promise<SaveTuningResult> {
  const row = buildRow(payload, 'tuning');
  return commitTuning(row);
}

export async function editTuning(id: string, patch: Partial<Tuning>): Promise<void> {
  await updateTuningAndRecompute(id, patch);
}

/** 处理两个标签页并发保存产生的待确认重复组 */
export async function resolveConflict(id: string, action: 'adopt' | 'ignore'): Promise<void> {
  await resolveTuningConflict(id, action);
}

export async function deleteTuning(id: string): Promise<void> {
  await removeTuning(id);
}
