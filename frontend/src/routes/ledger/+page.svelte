<script lang="ts">
  /**
   * /ledger 音准账：按时间顺序串起每次调律的音区偏差与当时温湿度，
   * 实时估算漂移快慢并给出复调 / 换弦建议；环境一改，趋势与结论立即失效重算，
   * 已确认旧结论留在历史，没复核前提醒 / 导出照旧用旧结论。
   */
  import { onMount } from 'svelte';
  import { writable } from 'svelte/store';
  import { push, router } from '$lib/router';
  import StatBadge from '$lib/components/common/StatBadge.svelte';
  import EmptyPanel from '$lib/components/common/EmptyPanel.svelte';
  import PitchTimeline from '$lib/components/common/PitchTimeline.svelte';
  import ConclusionCard from '$lib/components/common/ConclusionCard.svelte';
  import DriftBadge from '$lib/components/common/DriftBadge.svelte';
  import { useIdbTable } from '$lib/hooks/useIdbTable';
  import {
    db,
    type ConclusionRow,
    type EnvironmentRow,
    type PianoRow,
    type TuningRow
  } from '$lib/utils/db';
  import { liveDrift, effectiveConclusion, confirmConclusion, dismissConclusion } from '$lib/stores/ledgerStore';
  import { formatCents } from '$lib/utils/cents';

  const pianos = useIdbTable<PianoRow>(db.pianos, (a, b) => a.brand.localeCompare(b.brand, 'zh-Hans-CN'));
  const tunings = useIdbTable<TuningRow>(db.tunings, (a, b) => b.date.localeCompare(a.date));
  const environments = useIdbTable<EnvironmentRow>(db.environments, (a, b) => b.date.localeCompare(a.date));
  const conclusions = useIdbTable<ConclusionRow>(db.conclusions, (a, b) => b.createdAt - a.createdAt);

  /** 当前选中的钢琴 id（单独 writable，便于喂给 store 版派生） */
  const selectedPiano = writable('');
  let selectedId = $state('');

  const live = liveDrift(tunings, environments, selectedPiano);
  const effective = effectiveConclusion(conclusions, selectedPiano);

  const piano = $derived($pianos.find((p) => p.id === selectedId) ?? null);
  const ownTunings = $derived($tunings.filter((t) => t.pianoId === selectedId));
  const ownEnvs = $derived($environments.filter((e) => e.pianoId === selectedId));
  const history = $derived(
    $conclusions
      .filter((c) => c.pianoId === selectedId)
      .sort((a, b) => b.createdAt - a.createdAt)
  );
  const pending = $derived(history.find((c) => c.status === '待复核') ?? null);
  const pendingPianos = $derived(
    new Set($conclusions.filter((c) => c.status === '待复核').map((c) => c.pianoId))
  );

  function selectPiano(id: string): void {
    selectedId = id;
    selectedPiano.set(id);
    void push(`/ledger?piano=${encodeURIComponent(id)}`);
  }

  async function onConfirm(id: string): Promise<void> {
    await confirmConclusion(id);
  }
  async function onDismiss(id: string): Promise<void> {
    await dismissConclusion(id);
  }

  function fmtTime(ts: number): string {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
  }

  onMount(() => {
    const params = new URLSearchParams(router.querystring ?? '');
    const queryPiano = params.get('piano') ?? '';
    selectedId = queryPiano && $pianos.some((p) => p.id === queryPiano) ? queryPiano : ($pianos[0]?.id ?? '');
    selectedPiano.set(selectedId);
  });

  // pianos 异步到达后补一次默认选中
  $effect(() => {
    if (!selectedId && $pianos.length > 0) {
      selectedId = $pianos[0].id;
      selectedPiano.set(selectedId);
    }
  });
</script>

<div class="page">
  <div class="page-head">
    <div>
      <h2 class="page-title">音准账</h2>
      <p class="page-subtitle">
        按时间顺序串联每次调律的音区偏差与当时温湿度，自动估算漂移快慢；环境记录一改动，趋势与结论立即重算并标记待复核。
      </p>
    </div>
    <button type="button" class="btn" onclick={() => push('/tunings')}>去录入调律 →</button>
  </div>

  <div class="badge-row">
    <StatBadge label="建档钢琴" value={$pianos.length} suffix="台" tone="walnut" icon="🎹" />
    <StatBadge label="待复核结论" value={pendingPianos.size} suffix="台" tone="amber" icon="!" />
    <StatBadge
      label="本琴调律次数"
      value={$live.sampleCount}
      suffix="次"
      tone="brass"
      icon="🎼"
    />
    <StatBadge label="覆盖跨度" value={Math.round($live.spanDays / 30.4)} suffix="个月" tone="slate" icon="📅" />
  </div>

  {#if $pianos.length === 0}
    <EmptyPanel
      title="还没有钢琴档案"
      description="先在钢琴档案页建一台琴，再录两次调律，音准账就能算出漂移快慢。"
      showCreate={true}
      createText="去建琴档"
      oncreate={() => push('/pianos')}
    />
  {:else}
    <div class="flex flex-wrap gap-2">
      {#each $pianos as p (p.id)}
        <button
          type="button"
          class="rounded-full border px-3 py-1 text-xs transition {p.id === selectedId
            ? 'border-walnut bg-walnut text-white'
            : 'border-stone-300 bg-white text-stone-600 hover:border-walnut'}"
          onclick={() => selectPiano(p.id)}
        >
          {p.brand} {p.model}
          {#if pendingPianos.has(p.id)}<span class="ml-1 text-amber-300">●</span>{/if}
        </button>
      {/each}
    </div>

    {#if piano}
      <div class="grid gap-4 xl:grid-cols-3">
        <div class="space-y-4 xl:col-span-2">
          <div class="card">
            <div class="card-title mb-3">
              <span>漂移分析（实时）</span>
              <DriftBadge level={$live.level} magnitude={$live.driftMagnitude} />
            </div>
            {#if $live.insufficient}
              <p class="text-sm text-stone-500">{$live.summary}</p>
            {:else}
              <p class="text-sm text-stone-700">{$live.summary}</p>
              <div class="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
                <div class="rounded-lg bg-stone-50 p-2.5">
                  <div class="muted">综合漂移</div>
                  <div class="text-sm font-semibold tabular-nums">
                    {formatCents($live.driftCentsPer30Days)}<span class="muted"> /30天</span>
                  </div>
                </div>
                <div class="rounded-lg bg-stone-50 p-2.5">
                  <div class="muted">总体走向</div>
                  <div class="text-sm font-semibold">{$live.trend}</div>
                </div>
                <div class="rounded-lg bg-stone-50 p-2.5">
                  <div class="muted">最重音区</div>
                  <div class="text-sm font-semibold">{$live.worstZone}</div>
                </div>
                <div class="rounded-lg bg-stone-50 p-2.5">
                  <div class="muted">最近最大偏差</div>
                  <div class="text-sm font-semibold tabular-nums">{formatCents($live.latestMaxCents)}</div>
                </div>
              </div>

              <div class="mt-4">
                <div class="mb-2 text-xs font-semibold text-stone-500">各音区漂移速度（音分 / 30 天）</div>
                <div class="space-y-2">
                  {#each $live.zones as z (z.zone)}
                    <div class="flex items-center gap-3">
                      <span class="w-14 text-xs text-stone-500">{z.label}</span>
                      <div class="relative h-3 flex-1 rounded bg-stone-100">
                        <div
                          class="absolute top-0 h-3 rounded {z.centsPer30Days >= 0 ? 'bg-rose-400' : 'bg-sky-400'}"
                          style="width: {Math.min(100, (z.magnitude / 12) * 100)}%"
                        ></div>
                      </div>
                      <span class="w-24 text-right text-xs tabular-nums text-stone-600">
                        {formatCents(z.centsPer30Days)}
                      </span>
                    </div>
                  {/each}
                </div>
              </div>

              <div class="mt-4 overflow-x-auto">
                <div class="mb-2 text-xs font-semibold text-stone-500">相邻调律间漂移</div>
                <table class="w-full text-xs">
                  <thead class="text-left text-stone-400">
                    <tr>
                      <th class="py-1">区间</th>
                      <th class="py-1">间隔</th>
                      <th class="py-1">平均偏差变化</th>
                      <th class="py-1">速度(/30天)</th>
                      <th class="py-1">当时温湿度</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each $live.segments as seg (seg.fromTuningId + seg.toTuningId)}
                      <tr class="border-t border-stone-100">
                        <td class="py-1.5 tabular-nums">{seg.fromDate} → {seg.toDate}</td>
                        <td class="py-1.5 tabular-nums">{seg.days} 天</td>
                        <td class="py-1.5 tabular-nums">{formatCents(seg.avgDeltaCents)}</td>
                        <td class="py-1.5 font-semibold tabular-nums">{formatCents(seg.avgCentsPer30Days)}</td>
                        <td class="py-1.5">
                          {#if seg.tempC !== null}
                            {seg.tempC}℃ / {seg.humidityPct}%
                            {#if seg.backfilled}<span class="text-sky-600">（回填）</span>{/if}
                          {:else}
                            <span class="text-stone-400">—</span>
                          {/if}
                        </td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
            {/if}
            {#if $live.pendingCount > 0}
              <div class="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
                有 {$live.pendingCount} 条并发补录的调律待确认，当前测速未计入，请到调律记录页处理。
              </div>
            {/if}
          </div>

          <div class="card">
            <div class="card-title mb-3">
              <span>调律与温湿度时间轴</span>
              <span class="muted">旧 → 新</span>
            </div>
            <PitchTimeline tunings={ownTunings} />
          </div>
        </div>

        <div class="space-y-4">
          <ConclusionCard
            live={$live}
            effective={$effective}
            {pending}
            onconfirm={onConfirm}
            ondismiss={onDismiss}
          />

          <div class="card">
            <div class="card-title mb-3">
              <span>结论历史</span>
              <span class="muted">已确认旧结论永久留存</span>
            </div>
            {#if history.length === 0}
              <p class="muted text-sm">暂无结论历史。</p>
            {:else}
              <ul class="space-y-2">
                {#each history as c (c.id)}
                  <li class="rounded-lg border border-stone-200 p-2.5 text-xs">
                    <div class="flex items-center justify-between gap-2">
                      <span
                        class="rounded-full px-2 py-0.5 text-[10px] {c.status === '已确认'
                          ? 'bg-emerald-100 text-emerald-700'
                          : c.status === '待复核'
                            ? 'bg-amber-100 text-amber-800'
                            : 'bg-stone-100 text-stone-500'}"
                      >
                        {c.status}
                      </span>
                      <DriftBadge level={c.level} magnitude={Math.abs(c.driftCentsPer30Days)} />
                    </div>
                    <p class="mt-1.5 leading-relaxed text-stone-600">{c.summary}</p>
                    <div class="mt-1 text-[10px] text-stone-400">
                      {c.reviewedAt ? `复核 ${fmtTime(c.reviewedAt)}` : `生成 ${fmtTime(c.createdAt)}`}
                    </div>
                  </li>
                {/each}
              </ul>
            {/if}
          </div>

          <div class="card">
            <div class="card-title mb-3">
              <span>琴房环境（{ownEnvs.length}）</span>
              <button type="button" class="btn !px-2 !py-0.5 text-xs" onclick={() => push('/environments')}>管理</button>
            </div>
            <ul class="space-y-1.5 text-xs">
              {#each ownEnvs.slice(0, 6) as env (env.id)}
                <li class="flex items-center justify-between rounded-lg bg-stone-50 px-2.5 py-1.5">
                  <span class="tabular-nums text-stone-500">{env.date}</span>
                  <span class="tabular-nums {env.abnormal ? 'font-semibold text-rose-600' : 'text-stone-700'}">
                    {env.tempC}℃ / {env.humidityPct}%
                  </span>
                </li>
              {:else}
                <li class="muted">暂无环境记录</li>
              {/each}
            </ul>
          </div>
        </div>
      </div>
    {/if}
  {/if}
</div>
