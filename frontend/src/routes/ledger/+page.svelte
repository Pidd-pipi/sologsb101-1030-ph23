<script lang="ts">
  /**
   * /ledger 音准账：按时间顺序串起每次调律的音区偏差与当时温湿度，
   * 测算这台琴的漂移快慢并给出复调 / 换弦建议。
   * - 环境记录一改动，趋势立即按最新数据重算；
   * - 已确认结论留在历史里，最新一条若与当前环境不符则提示待复核；未复核前提醒 / 导出照旧用旧结论；
   * - 多标签页并发保存的冲突调律双方都保留，等人确认。
   */
  import { useIdbTable } from '$lib/hooks/useIdbTable';
  import StatBadge from '$lib/components/common/StatBadge.svelte';
  import EmptyPanel from '$lib/components/common/EmptyPanel.svelte';
  import TuningConflict from '$lib/components/common/TuningConflict.svelte';
  import {
    db,
    type ConclusionRow,
    type EnvironmentRow,
    type PianoRow,
    type TuningRow
  } from '$lib/utils/db';
  import { useTuningConflicts } from '$lib/hooks/useTuningConflicts';
  import {
    confirmPitchConclusion,
    deletePitchConclusion,
    usePitchLedgers
  } from '$lib/stores/pitchLedgerStore';
  import { discardTuningConflict, resolveTuningConflict } from '$lib/stores/tuningStore';
  import type { LedgerEntry } from '$lib/utils/ledger';
  import { bandColor, formatCents } from '$lib/utils/cents';
  import { onMount } from 'svelte';
  import { push, router } from '$lib/router';

  const pianos = useIdbTable<PianoRow>(db.pianos, (a, b) => a.brand.localeCompare(b.brand, 'zh-Hans-CN'));
  const tunings = useIdbTable<TuningRow>(db.tunings, (a, b) => b.date.localeCompare(a.date));
  const environments = useIdbTable<EnvironmentRow>(db.environments, (a, b) => b.date.localeCompare(a.date));
  const conclusions = useIdbTable<ConclusionRow>(db.conclusions, (a, b) => b.confirmedAt.localeCompare(a.confirmedAt));

  const ledgers = usePitchLedgers(tunings, environments, conclusions);
  const conflicts = useTuningConflicts(tunings);

  let selectedId = $state<string>('');
  let confirmer = $state<string>('陆师傅');
  let confirmNote = $state<string>('');
  let busy = $state(false);

  const pianoOptions = $derived($pianos.map((p) => ({ id: p.id, label: `${p.brand} ${p.model}` })));
  const currentPianoId = $derived(selectedId || pianoOptions[0]?.id || '');
  const ledger = $derived($ledgers.get(currentPianoId) ?? null);
  /** 时间升序展示，最近一次在最下，漂移随时间一眼看清 */
  const timeline = $derived<LedgerEntry[]>(ledger ? ledger.entries : []);
  const pianoConflicts = $derived($conflicts.filter((g) => g.pianoId === currentPianoId));
  const pendingReviewPianos = $derived(
    $conflicts.reduce<Set<string>>((set, g) => set.add(g.pianoId), new Set())
  );

  function pianoLabel(pianoId: string): string {
    const piano = $pianos.find((item) => item.id === pianoId);
    return piano ? `${piano.brand} ${piano.model}` : '钢琴已删除';
  }

  function selectPiano(id: string): void {
    selectedId = id;
    void push(id ? `/ledger?pianoId=${encodeURIComponent(id)}` : '/ledger');
  }

  onMount(() => {
    const id = new URLSearchParams(router.querystring ?? '').get('pianoId');
    if (id) selectedId = id;
  });

  function levelClass(level: string): string {
    if (level === '过快') return 'bg-rose-100 text-rose-700';
    if (level === '偏快') return 'bg-amber-100 text-amber-700';
    return 'bg-emerald-100 text-emerald-700';
  }

  function adviceClass(level: string): string {
    if (level === 'restring') return 'bg-rose-100 text-rose-700 ring-rose-300';
    if (level === 'retune') return 'bg-amber-100 text-amber-700 ring-amber-300';
    return 'bg-emerald-100 text-emerald-700 ring-emerald-300';
  }

  async function keepOne(groupId: string, keptId: string): Promise<void> {
    if (!window.confirm('保留这一条并删除同组其余调律？删除后仅保留所选记录。')) return;
    await resolveTuningConflict(groupId, keptId);
  }

  async function discardOne(id: string): Promise<void> {
    if (!window.confirm('丢弃这条待确认调律？')) return;
    await discardTuningConflict(id);
  }

  async function confirmCurrent(): Promise<void> {
    if (!ledger || busy) return;
    busy = true;
    try {
      await confirmPitchConclusion({
        pianoId: currentPianoId,
        confirmer: confirmer.trim() || '调律师',
        driftCentsPerMonth: ledger.live.driftCentsPerMonth,
        level: ledger.live.level,
        envFingerprint: ledger.live.envFingerprint,
        adviceLevel: ledger.live.adviceLevel,
        adviceText: ledger.live.adviceText,
        note: confirmNote.trim()
      });
      confirmNote = '';
    } finally {
      busy = false;
    }
  }

  async function removeConclusion(row: ConclusionRow): Promise<void> {
    if (!window.confirm(`删除 ${row.confirmedAt.slice(0, 10)} 确认的这条历史结论？`)) return;
    await deletePitchConclusion(row.id);
  }
</script>

<div class="page">
  <div class="page-head">
    <div>
      <h2 class="page-title">音准账</h2>
      <p class="page-subtitle">
        按时间串起每次调律的音区偏差与当时温湿度，测算漂移快慢并给出复调 / 换弦建议；环境记录一改，趋势立即失效重算。
      </p>
    </div>
    <select class="field max-w-xs" value={currentPianoId} onchange={(e) => selectPiano(e.currentTarget.value)}>
      {#each pianoOptions as option (option.id)}
        <option value={option.id}>
          {option.label}{pendingReviewPianos.has(option.id) ? '（有待确认）' : ''}
        </option>
      {/each}
    </select>
  </div>

  {#if pianoOptions.length === 0}
    <EmptyPanel
      title="还没有钢琴档案"
      description="先在钢琴档案里建一台琴，再录调律与环境记录，这里就能生成音准账。"
      createText="去建琴档"
      oncreate={() => push('/pianos')}
    />
  {:else if !ledger}
    <EmptyPanel title="该琴还没有调律或环境记录" description="录至少一次调律与一条琴房温湿度，即可测算漂移。" />
  {:else}
    {#each pianoConflicts as group (group.groupId)}
      <TuningConflict {group} {pianoLabel} onResolve={keepOne} onDiscard={discardOne} />
    {/each}

    <!-- 结论状态条 -->
    <div
      class="flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 {ledger.status === '待复核'
        ? 'border-amber-300 bg-amber-50'
        : ledger.status === '已确认'
          ? 'border-emerald-200 bg-emerald-50'
          : 'border-stone-200 bg-stone-50'}"
    >
      <div class="text-sm">
        {#if ledger.status === '待复核'}
          <span class="font-semibold text-amber-800">⚠️ 琴房环境已改动，当前趋势与旧结论不符（待复核）</span>
          <div class="muted mt-0.5 text-amber-700">
            新测算：{ledger.live.level} · {ledger.live.driftCentsPerMonth} 音分/30 天 · {ledger.live.adviceText}；
            在复核确认前，提醒与导出仍采用旧结论。
          </div>
        {:else if ledger.status === '已确认'}
          <span class="font-semibold text-emerald-800">✓ 结论已确认且环境未再变化</span>
          <div class="muted mt-0.5">
            采用结论：{ledger.effectiveLevel} · {ledger.effectiveDriftCentsPerMonth} 音分/30 天 · {ledger.effectiveAdviceText}
          </div>
        {:else}
          <span class="font-semibold text-stone-700">还没有确认过结论</span>
          <div class="muted mt-0.5">当前测算结果可确认入库；确认前提醒与导出按当前测算走。</div>
        {/if}
      </div>
      <div class="flex items-center gap-2">
        <input class="field w-28" bind:value={confirmer} placeholder="确认人" />
        <input class="field w-44" bind:value={confirmNote} placeholder="备注（可选）" />
        <button type="button" class="btn-primary" onclick={confirmCurrent} disabled={busy}>
          {ledger.status === '待复核' ? '复核并确认新结论' : '确认当前结论'}
        </button>
      </div>
    </div>

    <div class="badge-row">
      <StatBadge label="调律入账" value={ledger.entries.length} suffix="次" tone="walnut" icon="🎼" />
      <StatBadge label="漂移快慢" value={ledger.live.driftCentsPerMonth} suffix="¢/30天" tone="brass" icon="≈" />
      <StatBadge
        label="最近一段"
        value={ledger.live.latestCentsPerMonth}
        suffix="¢/30天"
        tone="slate"
        icon="↗"
      />
      <StatBadge label="环境超标占比" value={Math.round(ledger.live.abnormalRatio * 100)} percent={Math.round(ledger.live.abnormalRatio * 100)} showPercent suffix="%" tone="rose" icon="!" />
    </div>

    <div class="grid gap-4 lg:grid-cols-3">
      <!-- 漂移档位 + 建议 -->
      <div class="card flex flex-col gap-3">
        <div class="card-title"><span>漂移快慢</span><span class="muted">{ledger.live.envStability}</span></div>
        <div class="flex items-center gap-2">
          <span class="rounded-full px-3 py-1 text-sm font-semibold {levelClass(ledger.live.level)}">
            {ledger.live.level}
          </span>
          <span class="text-sm tabular-nums text-stone-600">
            {ledger.live.driftCentsPerMonth} 音分 / 30 天
          </span>
        </div>
        <div class="rounded-xl p-3 ring-1 {adviceClass(ledger.live.adviceLevel)}">
          <div class="text-sm font-semibold">{ledger.live.adviceText}</div>
        </div>
        <ul class="flex flex-col gap-1.5 text-xs text-stone-600">
          {#each ledger.live.reasons as reason (reason)}
            <li class="flex gap-1.5"><span aria-hidden="true">·</span><span>{reason}</span></li>
          {/each}
        </ul>
      </div>

      <!-- 时间序列 -->
      <div class="card lg:col-span-2">
        <div class="card-title mb-3">
          <span>调律 × 温湿度 时间序列</span>
          <span class="muted">按时间升序，柱高为平均偏差（满格 ±40 音分），柱下为当时温湿度</span>
        </div>
        {#if timeline.length === 0}
          <EmptyPanel title="暂无可入账的调律" description="待确认的冲突调律裁决后才计入趋势。" />
        {:else}
          <div class="flex items-end gap-4 overflow-x-auto pb-2">
            {#each timeline as entry (entry.tuning.id)}
              <div class="flex w-28 shrink-0 flex-col items-center gap-1">
                <span class="text-xs tabular-nums text-stone-500">{formatCents(entry.tuning.avgDeviationCents)}</span>
                <div class="flex h-36 w-full items-end justify-center rounded-lg bg-stone-100 p-1">
                  <div
                    class="w-2/3 rounded-t {entry.env?.source === '迁移回填' ? 'opacity-70' : ''}"
                    style="height: {Math.max(4, Math.min(100, Math.round((Math.abs(entry.tuning.avgDeviationCents) / 40) * 100)))}%; background-color: {bandColor(entry.tuning.avgDeviationCents)}"
                    title="平均偏差"
                  ></div>
                </div>
                <span class="text-[11px] text-stone-500">{entry.tuning.date}</span>
                <span class="text-[11px] tabular-nums text-stone-400">
                  {entry.env ? `${entry.env.tempC}℃ ${entry.env.humidityPct}%` : '无环境'}
                </span>
                {#if entry.env && entry.env.source === '迁移回填'}
                  <span class="rounded-full bg-sky-100 px-1.5 py-0.5 text-[10px] text-sky-700" title="按同期最近一条回填（环境日期 {entry.env.envDate}，相差 {entry.env.dayGap} 天）">
                    回填±{entry.env.dayGap}d
                  </span>
                {:else if entry.env}
                  <span class="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700">实测</span>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </div>

    <!-- 明细分录 -->
    <div class="card overflow-x-auto">
      <div class="card-title mb-3"><span>音准账分录</span><span class="muted">每次调律的音区偏差与当时温湿度</span></div>
      <table class="w-full text-sm">
        <thead class="border-b border-stone-200 text-left text-xs text-stone-500">
          <tr>
            <th class="py-2">日期</th>
            <th class="py-2">调律师</th>
            <th class="py-2">平均偏差</th>
            <th class="py-2">低 / 中 / 高音区</th>
            <th class="py-2">温度 ℃</th>
            <th class="py-2">湿度 %</th>
            <th class="py-2">温湿度来源</th>
          </tr>
        </thead>
        <tbody>
          {#each [...timeline].reverse() as entry (entry.tuning.id)}
            <tr class="border-b border-stone-100">
              <td class="py-2">{entry.tuning.date}</td>
              <td class="py-2">{entry.tuning.technician}</td>
              <td class="py-2 tabular-nums">{formatCents(entry.tuning.avgDeviationCents)}</td>
              <td class="py-2 text-xs tabular-nums text-stone-500">
                {entry.tuning.zones.bass} / {entry.tuning.zones.mid} / {entry.tuning.zones.treble}
              </td>
              <td class="py-2 tabular-nums">{entry.env ? entry.env.tempC : '—'}</td>
              <td class="py-2 tabular-nums">{entry.env ? entry.env.humidityPct : '—'}</td>
              <td class="py-2">
                {#if !entry.env}
                  <span class="muted">无关联</span>
                {:else if entry.env.source === '实测'}
                  <span class="rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700">实测（{entry.env.envDate}）</span>
                {:else}
                  <span class="rounded-full bg-sky-100 px-2 py-0.5 text-xs text-sky-700" title="旧数据迁移：按同期最近一条回填，环境日期 {entry.env.envDate}，相差 {entry.env.dayGap} 天">
                    迁移回填（{entry.env.envDate} · 差 {entry.env.dayGap} 天）
                  </span>
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <!-- 结论历史 -->
    <div class="card">
      <div class="card-title mb-3">
        <span>已确认结论历史</span>
        <span class="muted">旧结论永久留痕；未复核前提醒与导出取最新一条</span>
      </div>
      {#if ledger.conclusions.length === 0}
        <p class="muted">还没有确认过结论。</p>
      {:else}
        <ul class="flex flex-col gap-2">
          {#each ledger.conclusions as row, index (row.id)}
            {@const isLatest = index === 0}
            {@const stale = isLatest && row.envFingerprint !== ledger.live.envFingerprint}
            <li class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-stone-200 px-3 py-2 text-sm">
              <div>
                <span class="font-medium">{row.confirmedAt.slice(0, 10)}</span>
                <span class="muted ml-2">{row.confirmer}</span>
                <span class="ml-2 rounded-full px-2 py-0.5 text-xs {levelClass(row.level)}">{row.level}</span>
                <span class="ml-2 tabular-nums text-stone-500">{row.driftCentsPerMonth} 音分/30 天</span>
                <span class="ml-2 text-stone-600">{row.adviceText}</span>
                {#if isLatest && stale}
                  <span class="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">待复核（环境已改）</span>
                {:else if isLatest}
                  <span class="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700">当前采用</span>
                {/if}
                {#if row.note}<div class="muted mt-0.5">{row.note}</div>{/if}
              </div>
              <button type="button" class="btn-danger !py-1 text-xs" onclick={() => removeConclusion(row)}>删除</button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>
