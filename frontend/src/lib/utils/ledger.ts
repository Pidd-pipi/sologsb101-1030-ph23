/**
 * 音准账核心测算（纯函数，不触碰 IndexedDB，便于复核与复用）。
 *
 * 账面条目 = 一次调律（按时间排序）+ 当时温湿度。
 * 温湿度关联规则（迁移回填）：取同台琴、与调律日期同期最近的一条环境记录，
 * 同日为「实测」，异日为「迁移回填」，没有任何环境记录则为「无」。
 *
 * 漂移测算：相邻两次调律之间，音准从上一次调后接近 0 漂移到本次到访测得的平均偏差，
 * 故每段漂移量取本次 avgDeviationCents，按间隔天数折算到每 30 天。
 */
import type { Tuning, TuningEnvLink, EnvLinkSource } from '$lib/types/tuning';
import type { Environment } from '$lib/types/environment';
import type {
  AdviceLevel,
  DriftLevel,
  DriftTrend,
  EnvStability
} from '$lib/types/pitchLedger';
import {
  ADVICE_LABEL,
  DRIFT_FAST,
  driftLevel as levelOf,
  HUMIDITY_SWING_BAD,
  HUMIDITY_SWING_WARN,
  RESTRING_DRIFT_THRESHOLD,
  RETUNE_AVG_THRESHOLD,
  TEMP_SWING_BAD,
  TEMP_SWING_WARN
} from '$lib/types/pitchLedger';
import { daysBetween } from './uuid';

/** 账面条目：一次调律 + 当次温湿度（按时间升序） */
export interface LedgerEntry {
  tuning: Tuning;
  env: TuningEnvLink | null;
}

/** 两个日期相差的绝对天数 */
function gapAbs(date: string, envDate: string): number {
  return Math.abs(daysBetween(date, envDate));
}

/**
 * 同期最近的一条环境记录：同台琴中与调律日期绝对天数差最小者（并列取较晚更新的一条由调用方排序保证）。
 */
export function nearestEnvironment(
  environments: Environment[],
  pianoId: string,
  date: string
): Environment | null {
  const own = environments.filter((item) => item.pianoId === pianoId && !!item.date);
  if (own.length === 0) return null;
  let best: Environment | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const env of own) {
    const gap = gapAbs(date, env.date);
    if (gap < bestGap) {
      bestGap = gap;
      best = env;
    }
  }
  return best;
}

/** 按迁移规则给一次调律挂上温湿度快照 */
export function linkEnvironment(
  tuning: Tuning,
  environments: Environment[]
): TuningEnvLink | null {
  // 已带关联且引用记录仍存在：原样保留（环境值若被修改，由账本重建时统一刷新）
  const linkedId = tuning.env?.environmentId;
  const linked = linkedId ? environments.find((item) => item.id === linkedId) : undefined;
  const env = linked ?? nearestEnvironment(environments, tuning.pianoId, tuning.date);
  if (!env) return null;
  const dayGap = gapAbs(tuning.date, env.date);
  const source: EnvLinkSource = dayGap === 0 ? '实测' : '迁移回填';
  return {
    environmentId: env.id,
    tempC: env.tempC,
    humidityPct: env.humidityPct,
    envDate: env.date,
    source,
    dayGap
  };
}

/**
 * 重建某台琴的音准账（时间升序），逐条挂温湿度。
 * 环境记录一改动，重新调用本函数即可让全部条目上的温湿度与趋势失效重算。
 */
export function buildLedgerEntries(tunings: Tuning[], environments: Environment[]): LedgerEntry[] {
  return tunings
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((tuning) => ({ tuning, env: linkEnvironment(tuning, environments) }));
}

/**
 * 环境指纹：同台琴温湿度的条数、最大更新时间与取值指纹。
 * 任一条环境记录新增 / 修改 / 删除都会改变指纹，从而使已确认结论判为「待复核」。
 */
export function envFingerprint(environments: Environment[], pianoId: string): string {
  const own = environments
    .filter((item) => item.pianoId === pianoId)
    .map((item) => `${item.date}|${item.tempC}|${item.humidityPct}`)
    .sort();
  const joined = own.join(';');
  let hash = 0;
  for (let i = 0; i < joined.length; i += 1) {
    hash = (hash * 31 + joined.charCodeAt(i)) | 0;
  }
  return `env:${own.length}:${hash}`;
}

/** 温湿度稳定度（按同台琴全部环境记录的极差） */
export function envStability(environments: Environment[], pianoId: string): EnvStability {
  const own = environments.filter((item) => item.pianoId === pianoId);
  if (own.length < 2) return '平稳';
  const temps = own.map((item) => item.tempC);
  const hums = own.map((item) => item.humidityPct);
  const tempSwing = Math.max(...temps) - Math.min(...temps);
  const humSwing = Math.max(...hums) - Math.min(...hums);
  if (tempSwing >= TEMP_SWING_BAD || humSwing >= HUMIDITY_SWING_BAD) return '波动明显';
  if (tempSwing >= TEMP_SWING_WARN || humSwing >= HUMIDITY_SWING_WARN) return '有波动';
  return '平稳';
}

interface IntervalPoint {
  days: number;
  driftCents: number;
}

/** 由账本时间序列折算每段漂移（音分 / 30 天） */
function intervalPoints(entries: LedgerEntry[]): IntervalPoint[] {
  const points: IntervalPoint[] = [];
  for (let i = 1; i < entries.length; i += 1) {
    const days = daysBetween(entries[i - 1].tuning.date, entries[i].tuning.date);
    if (days <= 0) continue;
    points.push({ days, driftCents: entries[i].tuning.avgDeviationCents });
  }
  return points;
}

/** 漂移快慢与建议（纯派生）。pianoEnvironments 为同台琴的全部环境记录。 */
export function calcDriftTrend(
  pianoId: string,
  entries: LedgerEntry[],
  pianoEnvironments: Environment[]
): DriftTrend {
  const fingerprint = envFingerprint(pianoEnvironments, pianoId);
  const stability = envStability(pianoEnvironments, pianoId);
  const abnormalRatio =
    pianoEnvironments.length > 0
      ? pianoEnvironments.filter((item) => item.abnormal).length / pianoEnvironments.length
      : 0;

  const reasons: string[] = [];
  if (entries.length === 0) {
    return {
      pointCount: 0,
      driftCentsPerMonth: 0,
      latestCentsPerMonth: 0,
      level: '稳定',
      envStability: stability,
      abnormalRatio,
      adviceLevel: 'none',
      adviceText: ADVICE_LABEL.none,
      reasons: ['还没有调律记录，暂无法测算漂移。'],
      envFingerprint: fingerprint
    };
  }

  const points = intervalPoints(entries);
  const totalDays = points.reduce((sum, p) => sum + p.days, 0);
  const totalAbs = points.reduce((sum, p) => sum + Math.abs(p.driftCents), 0);
  const driftPerMonth = totalDays > 0 ? (totalAbs / totalDays) * 30 : 0;
  const latest = points[points.length - 1];
  const latestPerMonth = latest ? (latest.driftCents / latest.days) * 30 : 0;
  const level: DriftLevel = levelOf(driftPerMonth);

  const lastEntry = entries[entries.length - 1];
  const lastAvg = lastEntry.tuning.avgDeviationCents;
  const lastAvgAbs = Math.abs(lastAvg);
  const lastMaxAbs = Math.abs(lastEntry.tuning.maxDeviationCents);
  const fastIntervals = points.filter((p) => (Math.abs(p.driftCents) / p.days) * 30 >= DRIFT_FAST).length;

  reasons.push(`共 ${entries.length} 次调律，平均漂移 ${driftPerMonth.toFixed(1)} 音分/30 天（${level}）。`);
  if (latest) {
    reasons.push(
      `最近一段（${lastEntry.tuning.date}）约 ${latest.days} 天漂移 ${lastAvg.toFixed(1)} 音分，折 ${latestPerMonth.toFixed(1)} 音分/30 天。`
    );
  } else {
    reasons.push(`仅有 1 次调律（${lastEntry.tuning.date}），本次到访偏差 ${lastAvg.toFixed(1)} 音分。`);
  }
  reasons.push(`琴房温湿度${stability}，超标记录占比 ${Math.round(abnormalRatio * 100)}%。`);

  // 建议：长期过快 + 最近仍明显跑偏且多段偏快 → 换弦；跑偏或过快 → 复调；否则正常
  let adviceLevel: AdviceLevel = 'none';
  if (
    driftPerMonth >= RESTRING_DRIFT_THRESHOLD &&
    lastAvgAbs >= RETUNE_AVG_THRESHOLD &&
    fastIntervals >= 2
  ) {
    adviceLevel = 'restring';
    reasons.push('漂移长期过快且多段复调后仍快速跑偏，单纯复调难以维持，建议检查并安排换弦。');
  } else if (
    level === '过快' ||
    lastAvgAbs > RETUNE_AVG_THRESHOLD ||
    lastMaxAbs > 20 ||
    lastEntry.tuning.pitchRaised
  ) {
    adviceLevel = 'retune';
    reasons.push('漂移偏快或最近一次偏差超阈值，建议在常规周期前尽快复调。');
  } else {
    reasons.push('漂移与最近偏差都在可接受范围，按既定周期正常调律即可。');
  }
  if (stability !== '平稳') {
    reasons.push('温湿度波动会带动音准走，建议先稳定琴房环境（加湿 / 除湿 / 恒温）再复调。');
  }

  return {
    pointCount: entries.length,
    driftCentsPerMonth: Number(driftPerMonth.toFixed(2)),
    latestCentsPerMonth: Number(latestPerMonth.toFixed(2)),
    level,
    envStability: stability,
    abnormalRatio,
    adviceLevel,
    adviceText: ADVICE_LABEL[adviceLevel],
    reasons,
    envFingerprint: fingerprint
  };
}
