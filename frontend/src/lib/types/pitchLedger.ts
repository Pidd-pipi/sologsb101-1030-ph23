/**
 * 音准账：把调律记录、琴房环境与周期提醒接成一条随时间走的账。
 * - 趋势（漂移快慢、结论）为派生值：环境记录一改动立即按最新数据重算；
 * - 已确认的结论快照（PitchConclusion）持久化：未复核前提醒与导出照旧使用旧结论。
 */

/** 漂移快慢档位 */
export type DriftLevel = '稳定' | '偏快' | '过快';

/** 处理建议等级 */
export type AdviceLevel = 'none' | 'retune' | 'restring';

/** 温湿度稳定度（环境波动越大，漂移越可能是环境所致） */
export type EnvStability = '平稳' | '有波动' | '波动明显';

/**
 * 一次漂移测算结果（纯派生，不落库）。
 * 以“相邻两次调律之间的音分变化 ÷ 间隔天数”刻画这台琴的漂移快慢。
 */
export interface DriftTrend {
  /** 参与测算的账面条目数（已按时间排序、挂上温湿度） */
  pointCount: number;
  /** 平均绝对漂移（音分 / 30 天） */
  driftCentsPerMonth: number;
  /** 最近一次区间的漂移（音分 / 30 天，带方向） */
  latestCentsPerMonth: number;
  /** 漂移档位 */
  level: DriftLevel;
  /** 环境稳定度 */
  envStability: EnvStability;
  /** 环境异常区间占比（0–1） */
  abnormalRatio: number;
  /** 建议等级 */
  adviceLevel: AdviceLevel;
  /** 建议文案 */
  adviceText: string;
  /** 依据明细（人能看懂的一条条理由） */
  reasons: string[];
  /** 用于趋势失效比对的环境指纹（温湿度条数+最大更新时间+值指纹） */
  envFingerprint: string;
}

/** 结论复核状态 */
export type ConclusionStatus = '已确认' | '待复核';

/**
 * 已确认的结论快照（历史里永久留痕）。
 * 环境改动后 trend 立刻重算，但在新结论被确认前，提醒与导出仍读取本表中最新一条已确认结论。
 */
export interface PitchConclusion {
  id: string;
  /** 所属钢琴 */
  pianoId: string;
  /** 确认时间 ISO */
  confirmedAt: string;
  /** 确认人（默认当前调律师） */
  confirmer: string;
  /** 确认时的漂移（音分 / 30 天） */
  driftCentsPerMonth: number;
  /** 确认时的漂移档位 */
  level: DriftLevel;
  /** 确认时的环境指纹（环境一改，与最新指纹不符即判为“待复核”） */
  envFingerprint: string;
  /** 确认时的建议等级 */
  adviceLevel: AdviceLevel;
  /** 确认时的建议文案 */
  adviceText: string;
  /** 状态：最新一条已确认结论若指纹落后于当前环境则为待复核 */
  status: ConclusionStatus;
  /** 结论备注 */
  note: string;
}

/** 每月按 30 天折算漂移 */
export const DAYS_PER_MONTH = 30;
/** 漂移阈值（音分 / 30 天）：超过偏快档，超过 2 倍为过快 */
export const DRIFT_SLOW = 2;
export const DRIFT_FAST = 4;
/** 漂移长期过快，且最近调律仍明显跑偏时建议换弦（音分 / 30 天） */
export const RESTRING_DRIFT_THRESHOLD = 6;
/** 建议复调的最近平均偏差阈值（音分） */
export const RETUNE_AVG_THRESHOLD = 8;
/** 环境波动阈值（同琴温湿度极差） */
export const TEMP_SWING_WARN = 4;
export const HUMIDITY_SWING_WARN = 12;
export const TEMP_SWING_BAD = 8;
export const HUMIDITY_SWING_BAD = 20;

/** 漂移档位判定 */
export function driftLevel(absCentsPerMonth: number): DriftLevel {
  if (absCentsPerMonth >= DRIFT_FAST) return '过快';
  if (absCentsPerMonth >= DRIFT_SLOW) return '偏快';
  return '稳定';
}

/** 建议等级 → 中文 */
export const ADVICE_LABEL: Record<AdviceLevel, string> = {
  none: '按周期正常调律即可',
  retune: '建议尽快复调',
  restring: '建议安排换弦后复调'
};
