/** 各音区音分偏差明细 */
export interface TuningZones {
  /** 低音区 */
  bass: number;
  /** 中音区 */
  mid: number;
  /** 高音区 */
  treble: number;
}

/** 温湿度来源：录入时现场记录 / 迁移回填 / 未关联 */
export type EnvLinkSource = '实测' | '回填' | '无';

/** 调律与琴房环境的关联信息 */
export interface TuningEnvRef {
  /** 采用的环境记录 id（回填或实测） */
  environmentId: string;
  /** 关联日期（环境记录自身日期） */
  envDate: string;
  /** 温度 ℃（环境记录快照，环境表改动后随重算刷新） */
  tempC: number;
  /** 相对湿度 %（环境记录快照） */
  humidityPct: number;
  /** 来源：实测 / 回填 / 无 */
  source: EnvLinkSource;
  /** 与调律日期相差天数（回填时用于标注） */
  gapDays: number;
}

/** 调律记录在双标签页并发保存时的生命周期状态 */
export type TuningStatus = '正常' | '待确认' | '已采纳' | '已忽略';

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
  /** 并发保存状态（v2 新增，历史数据迁移时置为「正常」） */
  status?: TuningStatus;
  /** 待确认重复组：同组的另一条记录 id */
  conflictOf?: string | null;
  /** 关联的琴房环境（按同期最近一条回填，标注来源；无环境时 source=无） */
  envRef?: TuningEnvRef | null;
}

/** 标准基准音高 */
export const STANDARD_PITCH_HZ = 440;
/** 平均偏差超过该值即建议复调（音分） */
export const REPITCH_AVG_THRESHOLD = 8;
/** 最大偏差超过该值即建议复调（音分） */
export const REPITCH_MAX_THRESHOLD = 20;
/** 旧数据迁移时回填温湿度允许的最大同期跨度（天） */
export const BACKFILL_MAX_GAP_DAYS = 31;
/** 两个标签页并发保存判为「同一次调律」的最大日期跨度（天） */
export const CONCURRENT_DATE_WINDOW_DAYS = 3;

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
    status: '正常',
    conflictOf: null,
    envRef: null
  };
}
