/**
 * 音准漂移分析：按时间顺序把每次调律的音分偏差与当时温湿度串成一条音准账，
 * 估算这台琴相邻两次调律之间的漂移速度，并给出复调 / 换弦建议。
 * 纯计算，不读写数据库；环境记录一改动即由调用方重新调用本模块重算。
 */
import type { TuningRow, EnvironmentRow } from '$lib/utils/db';
import { daysBetween } from './uuid';
import { BACKFILL_MAX_GAP_DAYS } from '$lib/types/tuning';

/** 漂移快慢档位 */
export type DriftSpeedLevel = '稳定' | '偏快' | '过快';

/** 单个音区的漂移速度 */
export interface ZoneDrift {
  /** 音区键 */
  zone: 'bass' | 'mid' | 'treble';
  /** 音区中文名 */
  label: string;
  /** 平均漂移速度（音分 / 30 天，带正负号） */
  centsPer30Days: number;
  /** 漂移速度绝对值（音分 / 30 天） */
  magnitude: number;
}

/** 相邻两次调律之间的一段漂移 */
export interface DriftSegment {
  /** 本段起点（较早一次调律） */
  fromTuningId: string;
  fromDate: string;
  /** 本段终点（较近一次调律） */
  toTuningId: string;
  toDate: string;
  /** 间隔天数 */
  days: number;
  /** 平均偏差的区间变化（音分，带正负号） */
  avgDeltaCents: number;
  /** 平均漂移速度（音分 / 30 天，带正负号） */
  avgCentsPer30Days: number;
  /** 本段终点的温度 ℃（无关联时为 null） */
  tempC: number | null;
  /** 本段终点的相对湿度 %（无关联时为 null） */
  humidityPct: number | null;
  /** 温湿度是否为回填来源 */
  backfilled: boolean;
}

/** 一台琴的漂移分析结果 */
export interface DriftAnalysis {
  pianoId: string;
  /** 参与计算的调律次数（仅「正常 / 已采纳」状态） */
  sampleCount: number;
  /** 覆盖的总天数 */
  spanDays: number;
  /** 综合漂移速度（音分 / 30 天，带正负号，负号表示整体走低） */
  driftCentsPer30Days: number;
  /** 漂移速度绝对值 */
  driftMagnitude: number;
  /** 快慢档位 */
  level: DriftSpeedLevel;
  /** 各音区漂移速度 */
  zones: ZoneDrift[];
  /** 漂移最重的音区中文名 */
  worstZone: string;
  /** 平均偏差的总体走向（走低 / 走高 / 平稳） */
  trend: '走低' | '走高' | '平稳';
  /** 最近一次调律的平均偏差 */
  latestAvgCents: number;
  /** 最近一次调律的最大偏差 */
  latestMaxCents: number;
  /** 最近一次调律是否标记需复调 */
  latestPitchRaised: boolean;
  /** 近期待确认的并发调律条数（不参与计算，仅提示） */
  pendingCount: number;
  /** 逐段漂移（按时间升序） */
  segments: DriftSegment[];
  /** 建议条目（可直接展示） */
  advice: string[];
  /** 一句话总结 */
  summary: string;
  /** 是否样本不足（< 2 次有效调律无法测速） */
  insufficient: boolean;
  /** 分析所依据的环境数据指纹：环境表改动后指纹变化，触发结论失效 */
  envFingerprint: string;
}

/** 漂移速度阈值（音分 / 30 天）：≤3 稳定，≤8 偏快，>8 过快 */
export const DRIFT_STABLE_MAX = 3;
export const DRIFT_FAST_MAX = 8;
/** 建议换弦的最大偏差阈值（音分） */
export const RESTRING_MAX_THRESHOLD = 25;
/** 建议缩短调律周期的漂移速度阈值（音分 / 30 天） */
export const SHORTEN_CYCLE_THRESHOLD = 5;
/** 建议的最短 / 最长调律周期（月） */
export const MIN_CYCLE_MONTHS = 1;
export const MAX_CYCLE_MONTHS = 12;

/**
 * 依据漂移档位建议下次调律周期（月）。
 * 过快缩短到约 3 个月、偏快约 4 个月、稳定维持 6 个月，并夹在 1–12 个月内。
 */
export function suggestCycleMonths(level: DriftSpeedLevel, fallback = 6): number {
  const target = level === '过快' ? 3 : level === '偏快' ? 4 : fallback > 0 ? fallback : 6;
  return Math.min(MAX_CYCLE_MONTHS, Math.max(MIN_CYCLE_MONTHS, Math.round(target)));
}

export const DRIFT_LEVEL_LABEL: Record<DriftSpeedLevel, string> = {
  稳定: '稳定',
  偏快: '偏快',
  过快: '过快'
};

/** 按漂移速度绝对值分档 */
export function driftLevel(magnitude: number): DriftSpeedLevel {
  if (magnitude <= DRIFT_STABLE_MAX) return '稳定';
  if (magnitude <= DRIFT_FAST_MAX) return '偏快';
  return '过快';
}

/** 同期最近的环境记录：优先调律日期当天，其次按绝对天数差最小且不超过 maxGapDays */
export function nearestEnvironment(
  environments: EnvironmentRow[],
  pianoId: string,
  date: string,
  maxGapDays = BACKFILL_MAX_GAP_DAYS
): EnvironmentRow | null {
  const candidates = environments
    .filter((env) => env.pianoId === pianoId)
    .map((env) => ({ env, gap: Math.abs(daysBetween(date, env.date)) }))
    .filter((item) => item.gap <= maxGapDays)
    .sort((a, b) => a.gap - b.gap || b.env.date.localeCompare(a.env.date));
  return candidates[0]?.env ?? null;
}

/** 环境数据指纹：取该琴全部环境行的关键字段，任一行改动都会改变 */
export function envFingerprint(environments: EnvironmentRow[], pianoId: string): string {
  const own = environments
    .filter((env) => env.pianoId === pianoId)
    .map((env) => `${env.id}@${env.date}:${env.tempC}/${env.humidityPct}#${env.updatedAt}`)
    .sort()
    .join('|');
  return own;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/** 综合漂移速度：对各段按间隔天数加权平均（带正负号） */
function weightedDrift(segments: DriftSegment[]): number {
  const totalDays = segments.reduce((sum, seg) => sum + Math.max(seg.days, 1), 0);
  if (totalDays === 0) return 0;
  const weighted = segments.reduce(
    (sum, seg) => sum + seg.avgCentsPer30Days * Math.max(seg.days, 1),
    0
  );
  return round1(weighted / totalDays);
}

/**
 * 计算一台琴的音准漂移。
 * @param tunings 该琴全部调律行（内部会按日期排序）
 * @param environments 该琴所在琴房的全部环境行
 */
export function analyzeDrift(
  pianoId: string,
  tunings: TuningRow[],
  environments: EnvironmentRow[]
): DriftAnalysis {
  const pendingCount = tunings.filter((t) => t.status === '待确认').length;
  // 只有已确认的调律（正常 / 已采纳）参与测速；待确认与已忽略都不进账
  const confirmed = tunings
    .filter((t) => t.status !== '待确认' && t.status !== '已忽略')
    .sort((a, b) => a.date.localeCompare(b.date) || a.createdAt - b.createdAt);

  const empty: DriftAnalysis = {
    pianoId,
    sampleCount: confirmed.length,
    spanDays: 0,
    driftCentsPer30Days: 0,
    driftMagnitude: 0,
    level: '稳定',
    zones: [
      { zone: 'bass', label: '低音区', centsPer30Days: 0, magnitude: 0 },
      { zone: 'mid', label: '中音区', centsPer30Days: 0, magnitude: 0 },
      { zone: 'treble', label: '高音区', centsPer30Days: 0, magnitude: 0 }
    ],
    worstZone: '—',
    trend: '平稳',
    latestAvgCents: confirmed.at(-1)?.avgDeviationCents ?? 0,
    latestMaxCents: confirmed.at(-1)?.maxDeviationCents ?? 0,
    latestPitchRaised: confirmed.at(-1)?.pitchRaised ?? false,
    pendingCount,
    segments: [],
    advice:
      confirmed.length === 0
        ? ['暂无可确认的调律记录，先录入并确认调律后再测速。']
        : ['有效调律不足 2 次，暂时无法估算漂移速度，再录一次调律后即可出趋势。'],
    summary: '样本不足，暂无法判断漂移快慢',
    insufficient: true,
    envFingerprint: envFingerprint(environments, pianoId)
  };
  if (confirmed.length < 2) return empty;

  const segments: DriftSegment[] = [];
  for (let i = 1; i < confirmed.length; i += 1) {
    const prev = confirmed[i - 1];
    const curr = confirmed[i];
    const days = Math.max(daysBetween(prev.date, curr.date), 1);
    const avgDelta = round1(curr.avgDeviationCents - prev.avgDeviationCents);
    const env = curr.envRef ?? null;
    segments.push({
      fromTuningId: prev.id,
      fromDate: prev.date,
      toTuningId: curr.id,
      toDate: curr.date,
      days,
      avgDeltaCents: avgDelta,
      avgCentsPer30Days: round1((avgDelta / days) * 30),
      tempC: env ? env.tempC : null,
      humidityPct: env ? env.humidityPct : null,
      backfilled: env?.source === '回填'
    });
  }

  const drift = weightedDrift(segments);
  const magnitude = Math.abs(drift);
  const level = driftLevel(magnitude);

  const zoneDefs: Array<{ zone: ZoneDrift['zone']; label: string }> = [
    { zone: 'bass', label: '低音区' },
    { zone: 'mid', label: '中音区' },
    { zone: 'treble', label: '高音区' }
  ];
  const zones: ZoneDrift[] = zoneDefs.map(({ zone, label }) => {
    let zDrift = 0;
    let totalDays = 0;
    for (let i = 1; i < confirmed.length; i += 1) {
      const days = Math.max(daysBetween(confirmed[i - 1].date, confirmed[i].date), 1);
      const delta = confirmed[i].zones[zone] - confirmed[i - 1].zones[zone];
      zDrift += (delta / days) * 30 * days;
      totalDays += days;
    }
    const per30 = totalDays === 0 ? 0 : round1(zDrift / totalDays);
    return { zone, label, centsPer30Days: per30, magnitude: Math.abs(per30) };
  });
  const worstZone = zones.reduce((acc, z) => (z.magnitude > acc.magnitude ? z : acc), zones[0]).label;

  const latest = confirmed.at(-1)!;
  const first = confirmed[0];
  const netDelta = latest.avgDeviationCents - first.avgDeviationCents;
  const trend: DriftAnalysis['trend'] = netDelta < -2 ? '走低' : netDelta > 2 ? '走高' : '平稳';

  const spanDays = Math.max(daysBetween(first.date, latest.date), 1);
  const advice = buildAdvice({
    level,
    drift,
    magnitude,
    latestAvgCents: latest.avgDeviationCents,
    latestMaxCents: latest.maxDeviationCents,
    latestPitchRaised: latest.pitchRaised,
    worstZone,
    trend,
    pendingCount
  });

  const direction = drift < -0.1 ? '走低' : drift > 0.1 ? '走高' : '基本平稳';
  const summary =
    `近 ${confirmed.length} 次调律（${spanDays} 天）综合漂移约 ${round1(magnitude)} 音分/30天（${direction}），` +
    `判定为「${level}」，漂移最重的是${worstZone}。`;

  return {
    pianoId,
    sampleCount: confirmed.length,
    spanDays,
    driftCentsPer30Days: drift,
    driftMagnitude: round1(magnitude),
    level,
    zones,
    worstZone,
    trend,
    latestAvgCents: latest.avgDeviationCents,
    latestMaxCents: latest.maxDeviationCents,
    latestPitchRaised: latest.pitchRaised,
    pendingCount,
    segments,
    advice,
    summary,
    insufficient: false,
    envFingerprint: envFingerprint(environments, pianoId)
  };
}

interface AdviceInput {
  level: DriftSpeedLevel;
  drift: number;
  magnitude: number;
  latestAvgCents: number;
  latestMaxCents: number;
  latestPitchRaised: boolean;
  worstZone: string;
  trend: '走低' | '走高' | '平稳';
  pendingCount: number;
}

/** 由漂移结果生成可执行建议（复调 / 换弦 / 环境 / 周期 / 待确认） */
function buildAdvice(input: AdviceInput): string[] {
  const advice: string[] = [];
  const { level, magnitude, latestAvgCents, latestMaxCents, latestPitchRaised, worstZone, trend, pendingCount } = input;

  if (latestPitchRaised || Math.abs(latestAvgCents) > 8 || Math.abs(latestMaxCents) > 20) {
    advice.push('最近一次调律偏差已超阈值，建议尽快安排二次复调（拉拔后再精调）。');
  }

  if (Math.abs(latestMaxCents) >= RESTRING_MAX_THRESHOLD) {
    advice.push(
      `${worstZone}最大偏差达 ${latestMaxCents} 音分、超过 ${RESTRING_MAX_THRESHOLD} 音分，若复调后仍反复失准，优先检查该音区弦轴与琴弦，考虑换弦。`
    );
  } else if (level === '过快') {
    advice.push(`漂移过快（${magnitude} 音分/30天）且集中在${worstZone}，复调同时重点排查弦轴板握钉力与该音区旧弦。`);
  }

  if (magnitude > SHORTEN_CYCLE_THRESHOLD) {
    advice.push(`整体漂移${trend}、速度偏快，建议把调律周期缩短一档，并在换季（温湿度波动大）前加调一次。`);
  } else if (level === '稳定') {
    advice.push('漂移稳定、各音区偏差可控，维持现有调律周期即可，无需换弦。');
  } else {
    advice.push('漂移略快，先按现周期观察 1–2 次，并留意琴房温湿度波动。');
  }

  advice.push('持续记录调律时的温湿度：温湿度大幅波动会加速音准漂移，尽量稳定在 18–26℃ / 40–60%。');

  if (pendingCount > 0) {
    advice.push(`有 ${pendingCount} 条另一标签页补录的调律待确认，确认前本结论按旧数据计算，请先到调律记录页处理。`);
  }
  return advice;
}
