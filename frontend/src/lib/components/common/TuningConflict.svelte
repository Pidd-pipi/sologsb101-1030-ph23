<script lang="ts">
  /**
   * TuningConflict：多标签页并发保存冲突的裁决面板。
   * 同一天保存了不同内容的调律，两边都保留在这里，等人确认保留哪一条；
   * 未裁决前两条都不会互相覆盖，也不计入趋势与提醒。
   */
  import CentsTag from './CentsTag.svelte';
  import type { TuningConflictGroup } from '$lib/hooks/useTuningConflicts';
  import { centsFromStandardPitch, formatCents } from '$lib/utils/cents';

  let {
    group,
    pianoLabel,
    onResolve,
    onDiscard
  }: {
    group: TuningConflictGroup;
    pianoLabel: (pianoId: string) => string;
    onResolve: (groupId: string, keptId: string) => void;
    onDiscard: (id: string) => void;
  } = $props();
</script>

<div class="rounded-xl border border-amber-300 bg-amber-50/70 p-4">
  <div class="mb-3 flex items-start gap-2">
    <span class="mt-0.5 text-amber-600" aria-hidden="true">⚠️</span>
    <div>
      <div class="text-sm font-semibold text-amber-800">
        {pianoLabel(group.pianoId)} · {group.date} 存在 {group.members.length} 条待确认调律
      </div>
      <div class="muted mt-0.5 text-amber-700">{group.reason}</div>
    </div>
  </div>

  <div class="grid gap-3 md:grid-cols-2">
    {#each group.members as member (member.id)}
      <div class="rounded-lg border border-amber-200 bg-white p-3">
        <div class="mb-2 flex items-center justify-between">
          <span class="text-xs font-medium text-stone-500">
            {member.technician || '未填调律师'} · 保存于 {new Date(member.updatedAt).toLocaleString('zh-CN')}
          </span>
          <span class="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] text-amber-700">待确认</span>
        </div>
        <dl class="grid grid-cols-2 gap-y-1 text-xs text-stone-600">
          <dt>基准音高</dt>
          <dd class="tabular-nums">{member.basePitchHz} Hz（{formatCents(centsFromStandardPitch(member.basePitchHz))}）</dd>
          <dt>平均偏差</dt>
          <dd><CentsTag cents={member.avgDeviationCents} size="sm" showBand={false} /></dd>
          <dt>最大偏差</dt>
          <dd><CentsTag cents={member.maxDeviationCents} size="sm" showBand={false} /></dd>
          <dt>低 / 中 / 高</dt>
          <dd class="tabular-nums">{member.zones.bass} / {member.zones.mid} / {member.zones.treble}</dd>
        </dl>
        <div class="mt-3 flex gap-2">
          <button type="button" class="btn-primary !py-1 text-xs" onclick={() => onResolve(group.groupId, member.id)}>保留这条</button>
          <button type="button" class="btn-danger !py-1 text-xs" onclick={() => onDiscard(member.id)}>丢弃</button>
        </div>
      </div>
    {/each}
  </div>
</div>
