<script lang="ts">
  /**
   * 音准账时间轴：按时间顺序（旧 → 新）列出每次调律的音区偏差与当时温湿度。
   * 参与统计的为「正常 / 已采纳」；待确认与已忽略分别用描边 / 置灰标出。
   */
  import type { TuningRow } from '$lib/utils/db';
  import { ZONE_LABELS } from '$lib/types/tuning';
  import { formatCents } from '$lib/utils/cents';

  interface Props {
    tunings: TuningRow[];
  }
  let { tunings }: Props = $props();

  const ordered = $derived(
    [...tunings].sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt)
  );

  function sourceClass(source: '实测' | '回填' | '无'): string {
    if (source === '实测') return 'bg-emerald-50 text-emerald-700 ring-emerald-200';
    if (source === '回填') return 'bg-sky-50 text-sky-700 ring-sky-200';
    return 'bg-stone-100 text-stone-500 ring-stone-200';
  }
</script>

{#if ordered.length === 0}
  <div class="muted px-1 py-6 text-center text-sm">这台琴还没有调律记录</div>
{:else}
  <ol class="relative ml-3 border-l-2 border-stone-200">
    {#each ordered as tuning, index (tuning.id)}
      {@const counted = tuning.status !== '待确认' && tuning.status !== '已忽略'}
      <li class="mb-4 ml-5 {counted ? '' : 'opacity-60'}">
        <span
          class="absolute -left-[7px] mt-1 h-3 w-3 rounded-full ring-2 ring-white {counted
            ? 'bg-brass'
            : tuning.status === '待确认'
              ? 'bg-amber-400'
              : 'bg-stone-300'}"
        ></span>
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-sm font-semibold text-stone-700">{tuning.date}</span>
          <span class="text-xs text-stone-400">第 {index + 1} 次</span>
          {#if tuning.status === '待确认'}
            <span class="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] text-amber-800">待确认·不参与测速</span>
          {:else if tuning.status === '已忽略'}
            <span class="rounded-full bg-stone-200 px-2 py-0.5 text-[10px] text-stone-500">已忽略</span>
          {:else if tuning.status === '已采纳'}
            <span class="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] text-emerald-700">已采纳</span>
          {/if}
          {#if tuning.pitchRaised}
            <span class="rounded-full bg-rose-100 px-2 py-0.5 text-[10px] text-rose-700">需复调</span>
          {/if}
        </div>

        <div class="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-stone-600">
          <span>基准 {tuning.basePitchHz} Hz</span>
          <span>平均 {formatCents(tuning.avgDeviationCents)}</span>
          <span>最大 {formatCents(tuning.maxDeviationCents)}</span>
          <span class="text-stone-400">{tuning.technician || '未填调律师'}</span>
        </div>

        <div class="mt-2 flex flex-wrap gap-2">
          {#each ZONE_LABELS as zone (zone.key)}
            <div class="rounded-lg bg-stone-50 px-2.5 py-1 text-[11px] text-stone-600 ring-1 ring-stone-200">
              {zone.label}
              <span class="ml-1 font-semibold tabular-nums">{formatCents(tuning.zones[zone.key])}</span>
            </div>
          {/each}
          {#if tuning.envRef && tuning.envRef.source !== '无'}
            <span class="rounded-lg px-2.5 py-1 text-[11px] ring-1 {sourceClass(tuning.envRef.source)}">
              🌡 {tuning.envRef.tempC}℃ / {tuning.envRef.humidityPct}%
              {#if tuning.envRef.source === '实测'}
                · 实测
              {:else}
                · 回填({tuning.envRef.envDate}，差{tuning.envRef.gapDays}天)
              {/if}
            </span>
          {:else}
            <span class="rounded-lg px-2.5 py-1 text-[11px] ring-1 {sourceClass('无')}">🌡 无同期温湿度</span>
          {/if}
        </div>
      </li>
    {/each}
  </ol>
{/if}
