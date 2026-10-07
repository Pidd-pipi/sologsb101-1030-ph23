/**
 * 首次打开应用时灌入的演示数据
 * 只在 pianos 表为空时执行。钢琴 → 调律记录 → 维修 / 环境 → 周期提醒 → 音准结论 互相引用，
 * 其中包含 1 台超期琴、多条异常环境、1 组多标签页并发冲突与已确认 / 待复核结论，
 * 保证每个页面第一次进入都有内容可看。
 */
import type {
  PianoRow,
  TuningRow,
  VoicingRow,
  EnvironmentRow,
  ReminderRow,
  ConclusionRow
} from './db';
import { db, ROW_REVISION } from './db';
import type { Tuning } from '$lib/types/tuning';
import { linkEnvironment, envFingerprint } from './ledger';

function rev<T>(row: T): T & { revision: number; createdAt: number; updatedAt: number } {
  const now = Date.now();
  return { ...row, revision: ROW_REVISION, createdAt: now, updatedAt: now };
}

const PIANOS: Array<Omit<PianoRow, 'revision' | 'createdAt' | 'updatedAt'>> = [
  { id: 'pn-001', brand: 'YAMAHA', model: 'U1', serialNo: 'U1-6132457', type: '立式', venue: '琴房', purchaseYear: 2015, state: '正常' },
  { id: 'pn-002', brand: 'STEINWAY', model: 'B-211', serialNo: 'B-598812', type: '三角', venue: '音乐厅', purchaseYear: 2008, state: '正常' },
  { id: 'pn-003', brand: '珠江', model: 'UP118', serialNo: 'ZJ-1180621', type: '立式', venue: '家庭', purchaseYear: 2012, state: '待修' }
];

/**
 * 调律原始数据（不含温湿度关联）。
 * 每台琴给出跨数月的多次到访，温湿度在下方按「同期最近一条」规则统一回填。
 */
const TUNING_RAW: Array<Omit<Tuning, 'env' | 'pendingReview' | 'reviewGroupId' | 'reviewReason'>> = [
  // pn-001：漂移平稳偏慢，环境稳定
  { id: 'tn-001', pianoId: 'pn-001', date: '2024-01-10', basePitchHz: 440, avgDeviationCents: -1.5, maxDeviationCents: -4, zones: { bass: -4, mid: -1.2, treble: 0.7 }, technician: '陆师傅', pitchRaised: false },
  { id: 'tn-002', pianoId: 'pn-001', date: '2024-04-08', basePitchHz: 440, avgDeviationCents: -4, maxDeviationCents: -9, zones: { bass: -9, mid: -2.5, treble: -0.5 }, technician: '陆师傅', pitchRaised: false },
  { id: 'tn-003', pianoId: 'pn-001', date: '2024-07-15', basePitchHz: 439.6, avgDeviationCents: -5, maxDeviationCents: -10, zones: { bass: -10, mid: -4.2, treble: -0.8 }, technician: '陆师傅', pitchRaised: false },
  // pn-002：漂移偏快，建议复调
  { id: 'tn-004', pianoId: 'pn-002', date: '2024-01-15', basePitchHz: 440.6, avgDeviationCents: 4, maxDeviationCents: 8, zones: { bass: 3, mid: 4, treble: 8 }, technician: '顾老师', pitchRaised: false },
  { id: 'tn-005', pianoId: 'pn-002', date: '2024-03-20', basePitchHz: 441.5, avgDeviationCents: 9.8, maxDeviationCents: 21.4, zones: { bass: 6.2, mid: 9.8, treble: 21.4 }, technician: '顾老师', pitchRaised: true },
  { id: 'tn-006', pianoId: 'pn-002', date: '2024-06-25', basePitchHz: 442.1, avgDeviationCents: 14, maxDeviationCents: 26, zones: { bass: 9, mid: 14, treble: 26 }, technician: '顾老师', pitchRaised: true },
  // pn-003：长期快速跑偏，建议换弦
  { id: 'tn-007', pianoId: 'pn-003', date: '2023-11-02', basePitchHz: 437.2, avgDeviationCents: -22.5, maxDeviationCents: -35, zones: { bass: -35, mid: -21.4, treble: -12.6 }, technician: '陆师傅', pitchRaised: true },
  { id: 'tn-008', pianoId: 'pn-003', date: '2024-02-10', basePitchHz: 437.8, avgDeviationCents: -18, maxDeviationCents: -29, zones: { bass: -29, mid: -17, treble: -8 }, technician: '陆师傅', pitchRaised: true },
  { id: 'tn-009', pianoId: 'pn-003', date: '2024-05-18', basePitchHz: 436.9, avgDeviationCents: -25, maxDeviationCents: -38, zones: { bass: -38, mid: -24, treble: -13 }, technician: '陆师傅', pitchRaised: true },
  // 并发冲突演示：两个标签页几乎同时为 pn-001 补了同一天的调律，双方都保留待确认
  { id: 'tn-010', pianoId: 'pn-001', date: '2024-09-05', basePitchHz: 439.6, avgDeviationCents: -5, maxDeviationCents: -11, zones: { bass: -11, mid: -4.5, treble: -2 }, technician: '陆师傅', pitchRaised: false },
  { id: 'tn-011', pianoId: 'pn-001', date: '2024-09-05', basePitchHz: 439.5, avgDeviationCents: -6.2, maxDeviationCents: -12, zones: { bass: -12, mid: -6, treble: -2.6 }, technician: '顾老师', pitchRaised: false }
];

const VOICINGS: Array<Omit<VoicingRow, 'revision' | 'createdAt' | 'updatedAt'>> = [
  { id: 'vo-001', pianoId: 'pn-002', type: '整音', parts: '毡槌', material: '进口羊毛毡 · 中硬度', date: '2024-03-21', operator: '顾老师', state: '已完成' },
  { id: 'vo-002', pianoId: 'pn-003', type: '换弦', parts: '琴弦', material: '德国 Roslau 0.9mm', date: '2024-05-20', operator: '陆师傅', state: '计划' },
  { id: 'vo-003', pianoId: 'pn-001', type: '击弦机调整', parts: '联动杆', material: '原厂联动杆 · 间隙 0.2mm', date: '2024-04-08', operator: '陆师傅', state: '已完成' }
];

/**
 * 环境记录：pn-001 同日实测；pn-002 / pn-003 个别日期与调律错开一两天，
 * 以演示「迁移回填 · 同期最近一条」。
 */
const ENVIRONMENTS: Array<Omit<EnvironmentRow, 'revision' | 'createdAt' | 'updatedAt'>> = [
  // pn-001：温湿度平稳
  { id: 'en-001', pianoId: 'pn-001', date: '2024-01-10', tempC: 21.8, humidityPct: 50, device: '温湿度计', abnormal: false },
  { id: 'en-002', pianoId: 'pn-001', date: '2024-04-08', tempC: 22.4, humidityPct: 52, device: '温湿度计', abnormal: false },
  { id: 'en-003', pianoId: 'pn-001', date: '2024-07-15', tempC: 23.1, humidityPct: 55, device: '记录仪', abnormal: false },
  { id: 'en-004', pianoId: 'pn-001', date: '2024-09-05', tempC: 22.9, humidityPct: 53, device: '记录仪', abnormal: false },
  // pn-002：偏热偏湿且有波动（03-18 与调律 03-20 错开 → 回填）
  { id: 'en-005', pianoId: 'pn-002', date: '2024-01-15', tempC: 23.2, humidityPct: 55, device: '记录仪', abnormal: false },
  { id: 'en-006', pianoId: 'pn-002', date: '2024-03-18', tempC: 25.1, humidityPct: 62, device: '记录仪', abnormal: true },
  { id: 'en-007', pianoId: 'pn-002', date: '2024-06-25', tempC: 27.8, humidityPct: 68, device: '记录仪', abnormal: true },
  // pn-003：家庭环境干湿冷热波动明显（02-12 与调律 02-10 错开 → 回填）
  { id: 'en-008', pianoId: 'pn-003', date: '2023-11-02', tempC: 16.5, humidityPct: 35, device: '温湿度计', abnormal: true },
  { id: 'en-009', pianoId: 'pn-003', date: '2024-02-12', tempC: 15.2, humidityPct: 30, device: '温湿度计', abnormal: true },
  { id: 'en-010', pianoId: 'pn-003', date: '2024-05-18', tempC: 29.1, humidityPct: 72, device: '温湿度计', abnormal: true }
];

const REMINDERS: Array<Omit<ReminderRow, 'revision' | 'createdAt' | 'updatedAt'>> = [
  { id: 'rm-001', pianoId: 'pn-001', cycleMonths: 6, lastTuningDate: '2024-09-05', nextDueDate: '2025-03-05', state: '临近' },
  { id: 'rm-002', pianoId: 'pn-002', cycleMonths: 6, lastTuningDate: '2024-06-25', nextDueDate: '2024-12-25', state: '临近' },
  { id: 'rm-003', pianoId: 'pn-003', cycleMonths: 12, lastTuningDate: '2024-05-18', nextDueDate: '2025-05-18', state: '超期' }
];

/** 组装调律行：回填温湿度、标注待确认冲突组 */
function buildTuningRows(): TuningRow[] {
  return TUNING_RAW.map((raw) => {
    const base: Tuning = {
      ...raw,
      env: null,
      pendingReview: raw.id === 'tn-010' || raw.id === 'tn-011',
      reviewGroupId: raw.id === 'tn-010' || raw.id === 'tn-011' ? 'rv-demo-001' : '',
      reviewReason:
        raw.id === 'tn-010' || raw.id === 'tn-011'
          ? '两个标签页几乎同时保存了同一天的调律，内容不同，待人工确认保留哪一条。'
          : ''
    };
    return { ...base, env: linkEnvironment(base, ENVIRONMENTS) } as TuningRow;
  });
}

/** 音准结论：pn-001 指纹与当前环境一致（已确认）；pn-002 指纹过期（待复核） */
function buildConclusionRows(): ConclusionRow[] {
  const rows: Array<Omit<ConclusionRow, 'revision' | 'createdAt' | 'updatedAt'>> = [
    {
      id: 'pc-001',
      pianoId: 'pn-001',
      confirmedAt: '2024-07-16T09:30:00.000Z',
      confirmer: '陆师傅',
      driftCentsPerMonth: 1.4,
      level: '稳定',
      envFingerprint: envFingerprint(ENVIRONMENTS, 'pn-001'),
      adviceLevel: 'none',
      adviceText: '按周期正常调律即可',
      status: '已确认',
      note: '琴房恒温恒湿，漂移平稳，维持半年周期。'
    },
    {
      id: 'pc-002',
      pianoId: 'pn-002',
      confirmedAt: '2024-03-21T03:00:00.000Z',
      confirmer: '顾老师',
      driftCentsPerMonth: 4.2,
      level: '过快',
      envFingerprint: 'env:legacy-2-0',
      adviceLevel: 'retune',
      adviceText: '建议尽快复调',
      status: '已确认',
      note: '初判偏快；夏季环境记录补录后趋势需要重新复核。'
    }
  ];
  return rows as ConclusionRow[];
}

/** 灌入演示数据（钢琴 → 调律 → 维修 / 环境 → 提醒 → 音准结论） */
export async function seedDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.pianos, db.tunings, db.voicings, db.environments, db.reminders, db.conclusions],
    async () => {
      await db.pianos.bulkPut(PIANOS.map(rev));
      await db.tunings.bulkPut(buildTuningRows().map(rev));
      await db.voicings.bulkPut(VOICINGS.map(rev));
      await db.environments.bulkPut(ENVIRONMENTS.map(rev));
      await db.reminders.bulkPut(REMINDERS.map(rev));
      await db.conclusions.bulkPut(buildConclusionRows().map(rev));
    }
  );
}
