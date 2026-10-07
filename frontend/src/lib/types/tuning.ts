/** 各音区音分偏差明细 */
export interface TuningZones {
  /** 低音区 */
  bass: number;
  /** 中音区 */
  mid: number;
  /** 高音区 */
  treble: number;
}

/** 温湿度来源：录入时直接关联 / 迁移回填（同期最近一条）/ 无可用环境记录 */
export type EnvLinkSource = '实测' | '迁移回填' | '无';

/** 调律记录上挂的琴房温湿度快照（音准账的一笔） */
export interface TuningEnvLink {
  /** 引用的环境记录 id（回填时为同期最近一条；无关联时为空） */
  environmentId: string;
  /** 温度 ℃ */
  tempC: number;
  /** 相对湿度 % */
  humidityPct: number;
  /** 环境记录日期 */
  envDate: string;
  /** 温湿度来源标记 */
  source: EnvLinkSource;
  /** 与调律日期相差的天数（回填时用于交代“同期最近”） */
  dayGap: number;
}

/** 调律记录 */
export interface Tuning {
  id: string;
  /** 所属钢琴 */
  pianoId: string;
  /** 调律日期 YYYY-MM-DD */
  date: string;
  /** 基准音高 Hz（标准 A4 = 440 Hz） */
  basePitchHz: number;
  /** 平均偏差音分 */
  avgDeviationCents: number;
  /** 最大偏差音分 */
  maxDeviationCents: number;
  /** 各音区偏差明细 */
  zones: TuningZones;
  /** 调律师 */
  technician: string;
  /** 是否需二次复调 */
  pitchRaised: boolean;
  /** 当次调律时的琴房温湿度（旧数据迁移时按同期最近一条回填） */
  env: TuningEnvLink | null;
  /** 多标签页并发保存时：本条是否处于待确认状态（不覆盖对方，双方都留） */
  pendingReview: boolean;
  /** 并发分组 id：同一组互斥保存的记录共享该 id，等待人工确认 */
  reviewGroupId: string;
  /** 待确认原因说明 */
  reviewReason: string;
}

/** 标准基准音高 */
export const STANDARD_PITCH_HZ = 440;
/** 平均偏差超过该值即建议复调（音分） */
export const REPITCH_AVG_THRESHOLD = 8;
/** 最大偏差超过该值即建议复调（音分） */
export const REPITCH_MAX_THRESHOLD = 20;

export const ZONE_LABELS: Array<{ key: keyof TuningZones; label: string }> = [
  { key: 'bass', label: '低音区' },
  { key: 'mid', label: '中音区' },
  { key: 'treble', label: '高音区' }
];

export function createEmptyTuning(): Omit<Tuning, 'id'> {
  return {
    pianoId: '',
    date: new Date().toISOString().slice(0, 10),
    basePitchHz: STANDARD_PITCH_HZ,
    avgDeviationCents: 0,
    maxDeviationCents: 0,
    zones: { bass: 0, mid: 0, treble: 0 },
    technician: '',
    pitchRaised: false,
    env: null,
    pendingReview: false,
    reviewGroupId: '',
    reviewReason: ''
  };
}
