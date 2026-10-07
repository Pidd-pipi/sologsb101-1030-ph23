/**
 * 首次打开应用时灌入的演示数据
 * 只在 pianos 表为空时执行。钢琴 → 调律记录（含同期温湿度关联）→ 维修 / 环境 →
 * 周期提醒 → 漂移结论 互相引用，覆盖：
 * - pn-001 稳定琴：2 次调律、当天实测温湿度，另有一组双标签页待确认冲突；
 * - pn-002 漂移过快琴：3 次调律 + 高温高湿，含一条「待复核」结论（环境改动后已失效）；
 * - pn-003 走低待换弦琴：旧调律无温湿度关联（回填 / 无来源并存）。
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
import { analyzeDrift, suggestCycleMonths } from './drift';

function rev<T>(row: T): T & { revision: number; createdAt: number; updatedAt: number } {
  const now = Date.now();
  return { ...row, revision: ROW_REVISION, createdAt: now, updatedAt: now };
}

const PIANOS: Array<Omit<PianoRow, 'revision' | 'createdAt' | 'updatedAt'>> = [
  { id: 'pn-001', brand: 'YAMAHA', model: 'U1', serialNo: 'U1-6132457', type: '立式', venue: '琴房', purchaseYear: 2015, state: '正常' },
  { id: 'pn-002', brand: 'STEINWAY', model: 'B-211', serialNo: 'B-598812', type: '三角', venue: '音乐厅', purchaseYear: 2008, state: '正常' },
  { id: 'pn-003', brand: '珠江', model: 'UP118', serialNo: 'ZJ-1180621', type: '立式', venue: '家庭', purchaseYear: 2012, state: '待修' }
];

const TUNINGS: Array<Omit<TuningRow, 'revision' | 'createdAt' | 'updatedAt'>> = [
  // pn-001 稳定：两次都有当天实测温湿度
  {
    id: 'tn-001',
    pianoId: 'pn-001',
    date: '2024-01-10',
    basePitchHz: 440,
    avgDeviationCents: -2.0,
    maxDeviationCents: -4,
    zones: { bass: -4, mid: -1.5, treble: -0.5 },
    technician: '陆师傅',
    pitchRaised: false,
    status: '正常',
    conflictOf: null,
    envRef: { environmentId: 'en-004', envDate: '2024-01-10', tempC: 22.0, humidityPct: 50, source: '实测', gapDays: 0 }
  },
  {
    id: 'tn-005',
    pianoId: 'pn-001',
    date: '2024-04-08',
    basePitchHz: 440,
    avgDeviationCents: -3.0,
    maxDeviationCents: -6,
    zones: { bass: -6, mid: -2.5, treble: -1.5 },
    technician: '陆师傅',
    pitchRaised: false,
    status: '正常',
    conflictOf: null,
    envRef: { environmentId: 'en-005', envDate: '2024-04-08', tempC: 22.4, humidityPct: 52, source: '实测', gapDays: 0 }
  },
  // pn-001 双标签页并发保存：两条都留着、互相标记，等人确认（不参与漂移测速）
  {
    id: 'tn-010',
    pianoId: 'pn-001',
    date: '2024-07-02',
    basePitchHz: 440,
    avgDeviationCents: -3.5,
    maxDeviationCents: -7,
    zones: { bass: -7, mid: -3, treble: -2 },
    technician: '陆师傅',
    pitchRaised: false,
    status: '待确认',
    conflictOf: 'tn-011',
    envRef: { environmentId: '', envDate: '', tempC: 0, humidityPct: 0, source: '无', gapDays: 0 }
  },
  {
    id: 'tn-011',
    pianoId: 'pn-001',
    date: '2024-07-03',
    basePitchHz: 440,
    avgDeviationCents: -3.2,
    maxDeviationCents: -6.5,
    zones: { bass: -6.5, mid: -2.8, treble: -1.8 },
    technician: '陆师傅',
    pitchRaised: false,
    status: '待确认',
    conflictOf: 'tn-010',
    envRef: { environmentId: '', envDate: '', tempC: 0, humidityPct: 0, source: '无', gapDays: 0 }
  },

  // pn-002 漂移过快：高温高湿音乐厅，三次偏差一路走高，高音区最严重
  {
    id: 'tn-002',
    pianoId: 'pn-002',
    date: '2024-04-20',
    basePitchHz: 440,
    avgDeviationCents: 3.0,
    maxDeviationCents: 4,
    zones: { bass: 2, mid: 3, treble: 4 },
    technician: '顾老师',
    pitchRaised: false,
    status: '正常',
    conflictOf: null,
    envRef: { environmentId: 'en-007', envDate: '2024-04-20', tempC: 24, humidityPct: 58, source: '实测', gapDays: 0 }
  },
  {
    id: 'tn-006',
    pianoId: 'pn-002',
    date: '2024-05-25',
    basePitchHz: 441.5,
    avgDeviationCents: 9.8,
    maxDeviationCents: 21.4,
    zones: { bass: 6.2, mid: 9.8, treble: 21.4 },
    technician: '顾老师',
    pitchRaised: true,
    status: '正常',
    conflictOf: null,
    envRef: { environmentId: 'en-002', envDate: '2024-05-25', tempC: 27.8, humidityPct: 68, source: '实测', gapDays: 0 }
  },
  {
    id: 'tn-007',
    pianoId: 'pn-002',
    date: '2024-06-25',
    basePitchHz: 442.1,
    avgDeviationCents: 12.5,
    maxDeviationCents: 26,
    zones: { bass: 8, mid: 12, treble: 26 },
    technician: '顾老师',
    pitchRaised: true,
    status: '正常',
    conflictOf: null,
    envRef: { environmentId: 'en-006', envDate: '2024-06-25', tempC: 28.5, humidityPct: 72, source: '实测', gapDays: 0 }
  },

  // pn-003 严重走低、待换弦：旧数据缺温湿度，最近一条按同期 5 天外的环境回填
  {
    id: 'tn-003',
    pianoId: 'pn-003',
    date: '2023-11-02',
    basePitchHz: 437.2,
    avgDeviationCents: -8,
    maxDeviationCents: -18,
    zones: { bass: -18, mid: -7, treble: -4 },
    technician: '陆师傅',
    pitchRaised: false,
    status: '正常',
    conflictOf: null,
    envRef: { environmentId: '', envDate: '', tempC: 0, humidityPct: 0, source: '无', gapDays: 0 }
  },
  {
    id: 'tn-008',
    pianoId: 'pn-003',
    date: '2024-02-18',
    basePitchHz: 436.4,
    avgDeviationCents: -14,
    maxDeviationCents: -26,
    zones: { bass: -26, mid: -14, treble: -8 },
    technician: '陆师傅',
    pitchRaised: true,
    status: '正常',
    conflictOf: null,
    envRef: { environmentId: '', envDate: '', tempC: 0, humidityPct: 0, source: '无', gapDays: 0 }
  },
  {
    id: 'tn-009',
    pianoId: 'pn-003',
    date: '2024-05-20',
    basePitchHz: 435.6,
    avgDeviationCents: -22.5,
    maxDeviationCents: -35,
    zones: { bass: -35, mid: -21.4, treble: -12.6 },
    technician: '陆师傅',
    pitchRaised: true,
    status: '正常',
    conflictOf: null,
    // 同期最近一条环境在 5 天前：迁移 / 补录时回填并标注
    envRef: { environmentId: 'en-008', envDate: '2024-05-15', tempC: 17, humidityPct: 38, source: '回填', gapDays: 5 }
  }
];

const VOICINGS: Array<Omit<VoicingRow, 'revision' | 'createdAt' | 'updatedAt'>> = [
  { id: 'vo-001', pianoId: 'pn-002', type: '整音', parts: '毡槌', material: '进口羊毛毡 · 中硬度', date: '2024-03-21', operator: '顾老师', state: '已完成' },
  { id: 'vo-002', pianoId: 'pn-003', type: '换弦', parts: '琴弦', material: '德国 Roslau 0.9mm', date: '2024-05-25', operator: '陆师傅', state: '计划' },
  { id: 'vo-003', pianoId: 'pn-001', type: '击弦机调整', parts: '联动杆', material: '原厂联动杆 · 间隙 0.2mm', date: '2024-04-08', operator: '陆师傅', state: '已完成' }
];

const ENVIRONMENTS: Array<Omit<EnvironmentRow, 'revision' | 'createdAt' | 'updatedAt'>> = [
  // pn-001 适宜琴房
  { id: 'en-004', pianoId: 'pn-001', date: '2024-01-10', tempC: 22.0, humidityPct: 50, device: '记录仪', abnormal: false },
  { id: 'en-009', pianoId: 'pn-001', date: '2024-03-01', tempC: 23.0, humidityPct: 55, device: '记录仪', abnormal: false },
  { id: 'en-005', pianoId: 'pn-001', date: '2024-04-08', tempC: 22.4, humidityPct: 52, device: '温湿度计', abnormal: false },
  // pn-002 高温高湿音乐厅
  { id: 'en-007', pianoId: 'pn-002', date: '2024-04-20', tempC: 24.0, humidityPct: 58, device: '记录仪', abnormal: false },
  { id: 'en-002', pianoId: 'pn-002', date: '2024-05-25', tempC: 27.8, humidityPct: 68, device: '记录仪', abnormal: true },
  { id: 'en-006', pianoId: 'pn-002', date: '2024-06-25', tempC: 28.5, humidityPct: 72, device: '记录仪', abnormal: true },
  // pn-003 干冷家庭
  { id: 'en-003', pianoId: 'pn-003', date: '2024-04-12', tempC: 16.5, humidityPct: 35, device: '温湿度计', abnormal: true },
  { id: 'en-008', pianoId: 'pn-003', date: '2024-05-15', tempC: 17.0, humidityPct: 38, device: '温湿度计', abnormal: true }
];

const REMINDERS: Array<Omit<ReminderRow, 'revision' | 'createdAt' | 'updatedAt'>> = [
  { id: 'rm-001', pianoId: 'pn-001', cycleMonths: 6, lastTuningDate: '2024-04-08', nextDueDate: '2024-10-08', state: '正常' },
  { id: 'rm-002', pianoId: 'pn-002', cycleMonths: 6, lastTuningDate: '2024-06-25', nextDueDate: '2024-12-25', state: '临近' },
  { id: 'rm-003', pianoId: 'pn-003', cycleMonths: 12, lastTuningDate: '2024-05-20', nextDueDate: '2025-05-20', state: '超期' }
];

/** 由当前演示数据生成漂移结论快照 */
function buildConclusions(
  tunings: TuningRow[],
  environments: EnvironmentRow[],
  reminders: ReminderRow[]
): ConclusionRow[] {
  const now = Date.now();
  const out: ConclusionRow[] = [];

  for (const pianoId of ['pn-001', 'pn-002', 'pn-003'] as const) {
    const own = tunings.filter((t) => t.pianoId === pianoId);
    const envs = environments.filter((e) => e.pianoId === pianoId);
    const reminder = reminders.find((r) => r.pianoId === pianoId);
    const analysis = analyzeDrift(pianoId, own, envs);
    const base = {
      pianoId,
      envFingerprint: analysis.envFingerprint,
      sampleCount: analysis.sampleCount,
      driftCentsPer30Days: analysis.driftCentsPer30Days,
      level: analysis.level,
      worstZone: analysis.worstZone,
      trend: analysis.trend,
      summary: analysis.summary,
      advice: analysis.advice,
      suggestedCycleMonths: suggestCycleMonths(analysis.level, reminder?.cycleMonths ?? 6)
    };

    // pn-002：最近一次确认是三个月前（偏快）；环境又改动后生成一条待复核，指纹故意对不上 → 已失效待处理
    if (pianoId === 'pn-002') {
      out.push({
        id: 'cl-002-confirmed',
        ...base,
        sampleCount: 2,
        level: '过快',
        driftCentsPer30Days: 11,
        summary: '截至 5 月两次调律：综合漂移约 11 音分/30天（走高），判定为「过快」，高音区偏重。',
        advice: ['漂移过快，建议把周期缩短到 3 个月并注意夏季除湿。', '高音区偏差已达复调阈值，下次调律重点复核并检查旧弦。'],
        suggestedCycleMonths: 3,
        envFingerprint: 'confirmed-seed-fingerprint',
        createdAt: now - 90 * 86400000,
        reviewedAt: now - 90 * 86400000,
        status: '已确认',
        revision: ROW_REVISION,
        updatedAt: now - 90 * 86400000
      });
      out.push({
        id: 'cl-002-pending',
        ...base,
        envFingerprint: 'stale-seed-fingerprint',
        createdAt: now - 3600000,
        reviewedAt: null,
        status: '待复核',
        revision: ROW_REVISION,
        updatedAt: now - 3600000
      });
    } else {
      out.push({
        id: `cl-${pianoId}`,
        ...base,
        createdAt: now - 7 * 86400000,
        reviewedAt: now - 7 * 86400000,
        status: '已确认',
        revision: ROW_REVISION,
        updatedAt: now - 7 * 86400000
      });
    }
  }
  return out;
}

/** 灌入演示数据（钢琴 → 调律 → 维修 / 环境 → 提醒 → 漂移结论） */
export async function seedDatabase(): Promise<void> {
  const pianos = PIANOS.map(rev);
  const tunings = TUNINGS.map(rev);
  const voicings = VOICINGS.map(rev);
  const environments = ENVIRONMENTS.map(rev);
  const reminders = REMINDERS.map(rev);
  const conclusions = buildConclusions(tunings, environments, reminders);

  await db.transaction(
    'rw',
    [db.pianos, db.tunings, db.voicings, db.environments, db.reminders, db.conclusions],
    async () => {
      await db.pianos.bulkPut(pianos);
      await db.tunings.bulkPut(tunings);
      await db.voicings.bulkPut(voicings);
      await db.environments.bulkPut(environments);
      await db.reminders.bulkPut(reminders);
      await db.conclusions.bulkPut(conclusions);
    }
  );
}
