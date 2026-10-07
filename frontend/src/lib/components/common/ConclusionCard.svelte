<script lang="ts">
  /**
   * 漂移结论卡片：
   * - 上方展示「当前生效结论」（没复核前沿用旧结论）；
   * - 环境改动后出现待复核新结论，实时趋势/建议立即重算并提示确认；
   * - 已确认的旧结论仍保留在历史时间轴里。
   */
  import DriftBadge from '$lib/components/common/DriftBadge.svelte';
  import type { ConclusionRow } from '$lib/utils/db';
  import type { DriftAnalysis } from '$lib/utils/drift';

  interface Props {
    live: DriftAnalysis;
    effective: ConclusionRow | null;
    /** 是否有待复核草稿 */
    pending: ConclusionRow | null;
    onconfirm: (id: string) => void;
    ondismiss: (id: string) => void;
  }
  let { live, effective, pending, onconfirm, ondismiss }: Props = $props();

  function fmtTime(ts: number): string {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
  }
</script>

<div class="space-y-3">
  {#if pending}
    <div class="rounded-xl border-2 border-dashed border-amber-300 bg-amber-50/70 p-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <span class="rounded-full bg-amber-200 px-2 py-0.5 text-xs font-semibold text-amber-900">待复核 · 最新重算</span>
          <DriftBadge level={pending.level} magnitude={Math.abs(pending.driftCentsPer30Days)} />
        </div>
        <div class="flex gap-2">
          <button type="button" class="btn !px-3 !py-1 text-xs" onclick={() => ondismiss(pending.id)}>暂不采纳</button>
          <button type="button" class="btn-primary !px-3 !py-1 text-xs" onclick={() => onconfirm(pending.id)}>确认结论</button>
        </div>
      </div>
      <p class="mt-2 text-sm text-stone-800">{pending.summary}</p>
      <ul class="mt-2 list-disc space-y-1 pl-5 text-xs text-stone-600">
        {#each pending.advice as item, i (i)}
          <li>{item}</li>
        {/each}
      </ul>
      {#if pending.suggestedCycleMonths}
        <p class="mt-2 text-xs text-amber-800">建议调律周期：{pending.suggestedCycleMonths} 个月（确认后可到周期提醒页一键套用）</p>
      {/if}
      <p class="mt-2 text-[11px] text-amber-700">
        琴房环境有改动，旧结论已失效；复核确认前，周期提醒与导出仍按下方已确认的旧结论执行。
      </p>
    </div>
  {/if}

  {#if effective && (!pending || effective.id !== pending.id)}
    <div class="rounded-xl border border-stone-200 bg-white p-4 ring-1 ring-emerald-200">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <span
            class="rounded-full px-2 py-0.5 text-xs font-semibold {effective.status === '已确认'
              ? 'bg-emerald-100 text-emerald-800'
              : 'bg-stone-100 text-stone-600'}"
          >
            {effective.status === '已确认' ? '已确认 · 生效中' : '当前结论'}
          </span>
          <DriftBadge level={effective.level} magnitude={Math.abs(effective.driftCentsPer30Days)} />
          <span class="text-xs text-stone-400">走向：{effective.trend}</span>
        </div>
        <span class="text-[11px] text-stone-400">
          {effective.reviewedAt ? `复核于 ${fmtTime(effective.reviewedAt)}` : `生成于 ${fmtTime(effective.createdAt)}`}
        </span>
      </div>
      <p class="mt-2 text-sm text-stone-800">{effective.summary}</p>
      <ul class="mt-2 list-disc space-y-1 pl-5 text-xs text-stone-600">
        {#each effective.advice as item, i (i)}
          <li>{item}</li>
        {/each}
      </ul>
    </div>
  {:else if !pending}
    <div class="rounded-xl border border-dashed border-stone-300 bg-stone-50 p-4 text-sm text-stone-500">
      暂无结论。录入至少两次调律（并确认并发记录）后会自动生成第一条待复核结论。
    </div>
  {/if}

  {#if live.insufficient}
    <div class="rounded-xl border border-stone-200 bg-white p-4 text-sm text-stone-500">{live.summary}</div>
  {/if}
</div>
