<script lang="ts">
  /** 漂移快慢徽标：稳定 / 偏快 / 过快，对应绿 / 琥珀 / 红 */
  import type { Snippet } from 'svelte';
  import type { DriftSpeedLevel } from '$lib/utils/drift';

  interface Props {
    level: DriftSpeedLevel;
    magnitude?: number;
    children?: Snippet;
  }
  let { level, magnitude, children }: Props = $props();

  const toneClass: Record<DriftSpeedLevel, string> = {
    稳定: 'bg-emerald-100 text-emerald-800 ring-emerald-300',
    偏快: 'bg-amber-100 text-amber-800 ring-amber-300',
    过快: 'bg-rose-100 text-rose-800 ring-rose-300'
  };
</script>

<span class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ring-1 {toneClass[level]}">
  <span aria-hidden="true">{level === '稳定' ? '✓' : level === '偏快' ? '!' : '‼'}</span>
  漂移{level}
  {#if typeof magnitude === 'number'}
    <span class="opacity-70">· {magnitude} 音分/30天</span>
  {/if}
  {@render children?.()}
</span>
