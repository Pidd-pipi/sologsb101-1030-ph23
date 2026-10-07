/**
 * IndexedDB 持久化层（Dexie 封装）
 * - 数据库名 gbpianotune-db
 * - version(1)：钢琴 / 调律 / 整音维修 / 琴房环境 / 周期提醒 五张表
 * - version(2)：新增 conclusions 结论表；调律行增加 status / conflictOf / envRef；
 *   旧调律没有温湿度关联时，迁移按同期最近一条环境回填并标注「回填」来源，
 *   并为已有调律的琴补一条「已确认」基线结论，保证升级后提醒与导出照旧可用。
 */
import Dexie, { type Table } from 'dexie';
import type { Piano } from '$lib/types/piano';
import type { Tuning, TuningEnvRef } from '$lib/types/tuning';
import { BACKFILL_MAX_GAP_DAYS, CONCURRENT_DATE_WINDOW_DAYS } from '$lib/types/tuning';
import type { Voicing } from '$lib/types/voicing';
import type { Environment } from '$lib/types/environment';
import type { Reminder } from '$lib/types/reminder';
import type { DriftConclusion } from '$lib/types/conclusion';
import { nowIso } from './uuid';
import { seedDatabase } from './seed';
import { analyzeDrift, nearestEnvironment, suggestCycleMonths } from './drift';

/** 数据库名 */
export const DB_NAME = 'gbpianotune-db';

/** 当前数据结构版本号（每次调整字段结构必须 +1 并补迁移） */
export const DB_SCHEMA_VERSION = 2;

/** 行结构修订号 */
export const ROW_REVISION = 2;

/** 带时间戳与修订号的持久化实体 */
export interface Revisioned {
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export type PianoRow = Piano & Revisioned;
export type TuningRow = Tuning & Revisioned;
export type VoicingRow = Voicing & Revisioned;
export type EnvironmentRow = Environment & Revisioned;
export type ReminderRow = Reminder & Revisioned;
/** 结论表不套 Revisioned：其 createdAt / reviewedAt 是领域字段（epoch ms），另加 updatedAt */
export type ConclusionRow = DriftConclusion & { revision: number; updatedAt: number };

class GbPianoTuneDatabase extends Dexie {
  pianos!: Table<PianoRow, string>;
  tunings!: Table<TuningRow, string>;
  voicings!: Table<VoicingRow, string>;
  environments!: Table<EnvironmentRow, string>;
  reminders!: Table<ReminderRow, string>;
  conclusions!: Table<ConclusionRow, string>;

  constructor() {
    super(DB_NAME);

    // v1：历史结构（保留给老库升级，勿删）
    this.version(1).stores({
      pianos: 'id, brand, model, serialNo, type, venue, state, updatedAt',
      tunings: 'id, pianoId, date, technician, pitchRaised, updatedAt',
      voicings: 'id, pianoId, type, parts, state, date, updatedAt',
      environments: 'id, pianoId, date, device, abnormal, updatedAt',
      reminders: 'id, pianoId, state, nextDueDate, updatedAt'
    });

    // v2：新增 conclusions；tunings 增加 status / conflictOf 索引
    this.version(2)
      .stores({
        pianos: 'id, brand, model, serialNo, type, venue, state, updatedAt',
        tunings: 'id, pianoId, date, technician, pitchRaised, status, conflictOf, updatedAt',
        voicings: 'id, pianoId, type, parts, state, date, updatedAt',
        environments: 'id, pianoId, date, device, abnormal, updatedAt',
        reminders: 'id, pianoId, state, nextDueDate, updatedAt',
        conclusions: 'id, pianoId, status, createdAt, updatedAt'
      })
      .upgrade(async (tx) => {
        // 1) 通用：为历史行补齐修订号与时间戳
        const tableNames = ['pianos', 'tunings', 'voicings', 'environments', 'reminders'];
        for (const name of tableNames) {
          await tx
            .table(name)
            .toCollection()
            .modify((row: Record<string, unknown>) => {
              row.revision = ROW_REVISION;
              if (typeof row.createdAt !== 'number') row.createdAt = Date.now();
              if (typeof row.updatedAt !== 'number') row.updatedAt = row.createdAt;
            });
        }

        // 2) 旧调律没有温湿度关联：按同期最近一条环境回填并标「回填」来源
        const [tunings, environments, reminders] = await Promise.all([
          tx.table('tunings').toCollection().toArray() as Promise<TuningRow[]>,
          tx.table('environments').toCollection().toArray() as Promise<EnvironmentRow[]>,
          tx.table('reminders').toCollection().toArray() as Promise<ReminderRow[]>
        ]);
        for (const tuning of tunings) {
          const patch: Record<string, unknown> = {
            status: typeof tuning.status === 'string' ? tuning.status : '正常',
            conflictOf: tuning.conflictOf ?? null
          };
          if (!tuning.envRef) {
            const env = nearestEnvironment(environments, tuning.pianoId, tuning.date, BACKFILL_MAX_GAP_DAYS);
            patch.envRef = env
              ? {
                  environmentId: env.id,
                  envDate: env.date,
                  tempC: env.tempC,
                  humidityPct: env.humidityPct,
                  source: '回填',
                  gapDays: Math.abs(
                    Math.round(
                      (new Date(`${env.date}T00:00:00`).getTime() -
                        new Date(`${tuning.date}T00:00:00`).getTime()) /
                        86400000
                    )
                  )
                } satisfies TuningEnvRef
              : { environmentId: '', envDate: '', tempC: 0, humidityPct: 0, source: '无', gapDays: 0 };
          }
          await tx.table('tunings').update(tuning.id, patch);
        }

        // 3) 为已有调律的琴补一条「已确认」基线结论：升级后没复核前提醒 / 导出照旧
        const refTunings = await (tx.table('tunings').toCollection().toArray() as Promise<TuningRow[]>);
        const pianoIds = Array.from(new Set(refTunings.map((t) => t.pianoId)));
        const now = Date.now();
        for (const pianoId of pianoIds) {
          const own = refTunings.filter((t) => t.pianoId === pianoId);
          const analysis = analyzeDrift(pianoId, own, environments);
          const reminder = reminders.find((r) => r.pianoId === pianoId);
          const existing = await tx
            .table('conclusions')
            .where('pianoId')
            .equals(pianoId)
            .count();
          if (existing > 0) continue;
          const base: DriftConclusion = {
            id: `cl-mig-${pianoId}`,
            pianoId,
            createdAt: now,
            reviewedAt: now,
            status: '已确认',
            envFingerprint: analysis.envFingerprint,
            sampleCount: analysis.sampleCount,
            driftCentsPer30Days: analysis.driftCentsPer30Days,
            level: analysis.level,
            worstZone: analysis.worstZone,
            trend: analysis.trend,
            summary: analysis.insufficient ? '迁移基线：有效调律不足，暂无漂移结论。' : analysis.summary,
            advice: analysis.advice,
            suggestedCycleMonths: analysis.insufficient ? null : suggestCycleMonths(analysis.level, reminder?.cycleMonths ?? 6)
          };
          await tx.table('conclusions').add({ ...base, revision: ROW_REVISION, updatedAt: now });
        }
      });
  }
}

export const db = new GbPianoTuneDatabase();

/** 打开数据库：首次使用时灌入演示数据（幂等：表非空不播） */
export async function initDatabase(): Promise<void> {
  await db.open();
  if ((await db.pianos.count()) === 0) {
    await seedDatabase();
  }
}

/* ------------------------------ 钢琴 ------------------------------ */

export async function listPianos(): Promise<PianoRow[]> {
  const rows = await db.pianos.toArray();
  return rows.sort((a, b) => a.brand.localeCompare(b.brand, 'zh-Hans-CN') || a.model.localeCompare(b.model, 'zh-Hans-CN'));
}

export async function putPiano(row: PianoRow): Promise<void> {
  await db.pianos.put(row);
}

export async function updatePiano(id: string, patch: Partial<Piano>): Promise<void> {
  await db.pianos.update(id, { ...patch, updatedAt: Date.now() } as never);
}

/** 删除钢琴：级联删除其调律 / 维修 / 环境 / 提醒 / 结论 */
export async function removePiano(id: string): Promise<void> {
  await db.transaction('rw', [db.pianos, db.tunings, db.voicings, db.environments, db.reminders, db.conclusions], async () => {
    await db.tunings.where('pianoId').equals(id).delete();
    await db.voicings.where('pianoId').equals(id).delete();
    await db.environments.where('pianoId').equals(id).delete();
    await db.reminders.where('pianoId').equals(id).delete();
    await db.conclusions.where('pianoId').equals(id).delete();
    await db.pianos.delete(id);
  });
}

/* ------------------------------ 调律 ------------------------------ */

export async function listTunings(): Promise<TuningRow[]> {
  const rows = await db.tunings.toArray();
  return rows.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
}

export async function putTuning(row: TuningRow): Promise<void> {
  await db.tunings.put(row);
}

/** 并发保存结果：是否与另一标签页刚补的那次撞车 */
export interface SaveTuningResult {
  id: string;
  /** 是否被归入待确认重复组 */
  conflict: boolean;
  /** 同组另一条记录 id（用于跳转确认） */
  counterpartId: string | null;
}

/**
 * 保存一条调律并自动接入音准账。
 * 两个标签页几乎同时保存同一台琴、同一天（±CONCURRENT_DATE_WINDOW_DAYS 天）的调律时，
 * 后保存的不会盖掉对方：两条都保留并互相标记 conflictOf、置「待确认」，等人确认。
 */
export async function commitTuning(row: TuningRow): Promise<SaveTuningResult> {
  let result: SaveTuningResult = { id: row.id, conflict: false, counterpartId: null };
  await db.transaction('rw', [db.tunings, db.environments, db.conclusions, db.reminders], async () => {
    const environments = await db.environments.toArray();
    const linked: TuningRow = { ...row, envRef: resolveEnvRef(row, environments) };
    await db.tunings.put(linked);

    const candidate = (
      await db.tunings
        .where('pianoId')
        .equals(row.pianoId)
        .and((item) => item.id !== row.id && item.status === '正常' && !item.conflictOf)
        .toArray()
    )
      .filter((item) => Math.abs(dateGapDays(item.date, row.date)) <= CONCURRENT_DATE_WINDOW_DAYS)
      .sort((a, b) => b.createdAt - a.createdAt)[0];

    if (candidate) {
      const now = Date.now();
      await db.tunings.update(candidate.id, {
        status: '待确认',
        conflictOf: row.id,
        updatedAt: now
      } as never);
      await db.tunings.update(row.id, {
        status: '待确认',
        conflictOf: candidate.id,
        updatedAt: now
      } as never);
      result = { id: row.id, conflict: true, counterpartId: candidate.id };
    }
    await refreshPianoLedgerInTx(row.pianoId);
  });
  return result;
}

/** 编辑调律后重接环境关联并重算该琴的音准账 */
export async function updateTuningAndRecompute(id: string, patch: Partial<Tuning>): Promise<void> {
  await db.transaction('rw', [db.tunings, db.environments, db.conclusions, db.reminders], async () => {
    const current = await db.tunings.get(id);
    if (!current) return;
    const next: TuningRow = { ...current, ...patch, id, updatedAt: Date.now() } as TuningRow;
    const environments = await db.environments.toArray();
    next.envRef = resolveEnvRef(next, environments);
    await db.tunings.put(next);
    await refreshPianoLedgerInTx(next.pianoId);
  });
}

function dateGapDays(a: string, b: string): number {
  const ta = new Date(`${a}T00:00:00`).getTime();
  const tb = new Date(`${b}T00:00:00`).getTime();
  if (Number.isNaN(ta) || Number.isNaN(tb)) return Number.POSITIVE_INFINITY;
  return Math.round((tb - ta) / 86400000);
}

/**
 * 人工处理并发重复组：
 * - adopt（采纳本条）：本条转「已采纳」并恢复参与统计，另一条转「已忽略」；
 * - ignore（忽略本条）：本条转「已忽略」，另一条恢复正常。
 */
export async function resolveTuningConflict(id: string, action: 'adopt' | 'ignore'): Promise<void> {
  await db.transaction('rw', [db.tunings, db.environments, db.conclusions, db.reminders], async () => {
    const row = await db.tunings.get(id);
    if (!row || !row.conflictOf) return;
    const otherId = row.conflictOf;
    const now = Date.now();
    if (action === 'adopt') {
      await db.tunings.update(id, { status: '已采纳', conflictOf: null, updatedAt: now } as never);
      await db.tunings.update(otherId, { status: '已忽略', conflictOf: null, updatedAt: now } as never);
    } else {
      await db.tunings.update(id, { status: '已忽略', conflictOf: null, updatedAt: now } as never);
      await db.tunings.update(otherId, { status: '正常', conflictOf: null, updatedAt: now } as never);
    }
    await refreshPianoLedgerInTx(row.pianoId);
  });
}

export async function updateTuning(id: string, patch: Partial<Tuning>): Promise<void> {
  await db.tunings.update(id, { ...patch, updatedAt: Date.now() } as never);
}

/** 把一次调律关联到同期最近的琴房环境（实测 / 回填 / 无） */
export function resolveEnvRef(
  tuning: Pick<Tuning, 'pianoId' | 'date' | 'envRef'>,
  environments: EnvironmentRow[]
): TuningEnvRef {
  const today = new Date().toISOString().slice(0, 10);
  const gapToToday = Math.abs(
    Math.round(
      (new Date(`${today}T00:00:00`).getTime() - new Date(`${tuning.date}T00:00:00`).getTime()) / 86400000
    )
  );
  // 新建时显式选了「实测」且环境记录还在：保持实测关联
  const explicit = tuning.envRef;
  if (explicit && explicit.source === '实测' && explicit.environmentId) {
    const env = environments.find((item) => item.id === explicit.environmentId);
    if (env) {
      return {
        environmentId: env.id,
        envDate: env.date,
        tempC: env.tempC,
        humidityPct: env.humidityPct,
        source: '实测',
        gapDays: Math.abs(
          Math.round(
            (new Date(`${env.date}T00:00:00`).getTime() - new Date(`${tuning.date}T00:00:00`).getTime()) / 86400000
          )
        )
      };
    }
  }
  // 同期最近一条（当天 → 实测；跨日 31 天内 → 回填）
  const env = nearestEnvironment(environments, tuning.pianoId, tuning.date, BACKFILL_MAX_GAP_DAYS);
  if (env) {
    const gapDays = Math.abs(
      Math.round(
        (new Date(`${env.date}T00:00:00`).getTime() - new Date(`${tuning.date}T00:00:00`).getTime()) / 86400000
      )
    );
    return {
      environmentId: env.id,
      envDate: env.date,
      tempC: env.tempC,
      humidityPct: env.humidityPct,
      source: gapDays === 0 && gapToToday <= BACKFILL_MAX_GAP_DAYS ? '实测' : '回填',
      gapDays
    };
  }
  return { environmentId: '', envDate: '', tempC: 0, humidityPct: 0, source: '无', gapDays: 0 };
}

export async function removeTuning(id: string): Promise<void> {
  await db.transaction('rw', [db.tunings, db.environments, db.conclusions, db.reminders], async () => {
    const tuning = await db.tunings.get(id);
    await db.tunings.delete(id);
    // 解组：若它属于并发重复组，把另一条恢复为正常
    if (tuning?.conflictOf) {
      await db.tunings.update(tuning.conflictOf, { conflictOf: null, status: '正常', updatedAt: Date.now() } as never);
    }
    await db.tunings.where('conflictOf').equals(id).modify({ conflictOf: null, status: '正常', updatedAt: Date.now() } as never);
    if (tuning) await refreshPianoLedgerInTx(tuning.pianoId);
  });
}

/* --------------------------- 整音与维修 --------------------------- */

export async function listVoicings(): Promise<VoicingRow[]> {
  const rows = await db.voicings.toArray();
  return rows.sort((a, b) => b.date.localeCompare(a.date));
}

export async function putVoicing(row: VoicingRow): Promise<void> {
  await db.voicings.put(row);
}

export async function updateVoicing(id: string, patch: Partial<Voicing>): Promise<void> {
  await db.voicings.update(id, { ...patch, updatedAt: Date.now() } as never);
}

/** 完成维修：回写钢琴状态（全部完成则置为正常，否则置为待修） */
export async function completeVoicing(id: string): Promise<void> {
  await db.transaction('rw', [db.voicings, db.pianos], async () => {
    const voicing = await db.voicings.get(id);
    if (!voicing) throw new Error('维修记录不存在');
    await db.voicings.update(id, { state: '已完成', updatedAt: Date.now() } as never);
    const pending = await db.voicings
      .where('pianoId')
      .equals(voicing.pianoId)
      .filter((item) => item.state !== '已完成' && item.id !== id)
      .count();
    await db.pianos.update(voicing.pianoId, {
      state: pending === 0 ? '正常' : '待修',
      updatedAt: Date.now()
    } as never);
  });
}

/** 新建维修计划时把钢琴置为待修 */
export async function markPianoPending(pianoId: string): Promise<void> {
  await db.pianos.update(pianoId, { state: '待修', updatedAt: Date.now() } as never);
}

export async function removeVoicing(id: string): Promise<void> {
  await db.voicings.delete(id);
}

/* ---------------------------- 琴房环境 ---------------------------- */

export async function listEnvironments(): Promise<EnvironmentRow[]> {
  const rows = await db.environments.toArray();
  return rows.sort((a, b) => b.date.localeCompare(a.date));
}

export async function putEnvironment(row: EnvironmentRow): Promise<void> {
  await db.environments.put(row);
}

/**
 * 新增 / 修改一条环境记录后，重算受影响钢琴的整条音准账：
 * 关联到该环境的调律先重新解析（回填来源可能换条），其余调律也重跑同期匹配，
 * 环境指纹变化会使待复核结论立即失效并生成新的待复核结论。
 */
export async function upsertEnvironmentAndRecompute(row: EnvironmentRow): Promise<void> {
  await db.transaction('rw', [db.environments, db.tunings, db.conclusions, db.reminders], async () => {
    await db.environments.put(row);
    const environments = await db.environments.toArray();
    await relinkTunings(row.pianoId, environments);
    await refreshPianoLedgerInTx(row.pianoId);
  });
}

export async function updateEnvironment(id: string, patch: Partial<Environment>): Promise<void> {
  const existing = await db.environments.get(id);
  await db.environments.update(id, { ...patch, updatedAt: Date.now() } as never);
  if (existing) {
    const pianoId = (patch.pianoId as string | undefined) ?? existing.pianoId;
    await db.transaction('rw', [db.environments, db.tunings, db.conclusions, db.reminders], async () => {
      const environments = await db.environments.toArray();
      // 钢琴被改挂时，旧琴与新琴都要重算
      const affected = Array.from(new Set([existing.pianoId, pianoId]));
      for (const pid of affected) {
        await relinkTunings(pid, environments);
        await refreshPianoLedgerInTx(pid);
      }
    });
  }
}

/** 删除环境记录：受影响调律回退到同期次近一条，随后结论失效重算 */
export async function removeEnvironment(id: string): Promise<void> {
  const existing = await db.environments.get(id);
  if (!existing) {
    await db.environments.delete(id);
    return;
  }
  await db.transaction('rw', [db.environments, db.tunings, db.conclusions, db.reminders], async () => {
    await db.environments.delete(id);
    const environments = await db.environments.toArray();
    await relinkTunings(existing.pianoId, environments);
    await refreshPianoLedgerInTx(existing.pianoId);
  });
}

/** 重新解析某台琴全部调律的环境关联（保留「实测」直连，回填 / 无按同期最近重算） */
async function relinkTunings(pianoId: string, environments: EnvironmentRow[]): Promise<void> {
  const tunings = await db.tunings.where('pianoId').equals(pianoId).toArray();
  for (const tuning of tunings) {
    const envRef = resolveEnvRef(tuning, environments);
    await db.tunings.update(tuning.id, { envRef, updatedAt: Date.now() } as never);
  }
}

/* ---------------------------- 结论 / 音准账 ---------------------------- */

export async function listConclusions(): Promise<ConclusionRow[]> {
  const rows = await db.conclusions.toArray();
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

export async function putConclusion(row: ConclusionRow): Promise<void> {
  await db.conclusions.put(row);
}

/** 某台琴当前生效结论：优先最近一条「已确认」；没有则回退最近一条「待复核」 */
export async function getEffectiveConclusion(pianoId: string): Promise<ConclusionRow | null> {
  const rows = await db.conclusions.where('pianoId').equals(pianoId).sortBy('createdAt');
  const confirmed = rows.filter((r) => r.status === '已确认');
  if (confirmed.length > 0) return confirmed.at(-1)!;
  const pending = rows.filter((r) => r.status === '待复核');
  return pending.at(-1) ?? null;
}

/**
 * 重算一台琴的音准账（漂移 + 结论）。必须在已包含
 * tunings / environments / conclusions / reminders 的读写事务内调用。
 * - 数据与指纹都没变时不产生新结论；
 * - 指纹变化（环境改动）：当前「待复核」结论置「已失效」，另生成一条新的「待复核」；
 * - 已确认的旧结论原样留在历史里，提醒 / 导出仍读取最近一条已确认结论。
 */
export async function refreshPianoLedgerInTx(pianoId: string): Promise<void> {
  const [tunings, environments, reminder] = await Promise.all([
    db.tunings.where('pianoId').equals(pianoId).toArray(),
    db.environments.where('pianoId').equals(pianoId).toArray(),
    db.reminders.where('pianoId').equals(pianoId).first()
  ]);
  const analysis = analyzeDrift(pianoId, tunings, environments);

  const rows = await db.conclusions.where('pianoId').equals(pianoId).sortBy('createdAt');
  const latest = rows.at(-1);
  const sigOf = (r: DriftConclusion | ConclusionRow): string =>
    JSON.stringify([
      r.envFingerprint,
      r.sampleCount,
      r.driftCentsPer30Days,
      r.level,
      r.worstZone,
      r.trend,
      r.summary
    ]);
  const currentSig = sigOf({
    envFingerprint: analysis.envFingerprint,
    sampleCount: analysis.sampleCount,
    driftCentsPer30Days: analysis.driftCentsPer30Days,
    level: analysis.level,
    worstZone: analysis.worstZone,
    trend: analysis.trend,
    summary: analysis.summary
  } as DriftConclusion);

  // 数据与指纹都没变（例如只产生了不参与统计的待确认记录）：不重复建草稿
  if (latest && sigOf(latest) === currentSig) return;

  if (latest?.status === '待复核') {
    if (latest.envFingerprint === analysis.envFingerprint) {
      // 同指纹下调律有增删：就地更新这条待复核草稿
      const now = Date.now();
      await db.conclusions.update(latest.id, {
        sampleCount: analysis.sampleCount,
        driftCentsPer30Days: analysis.driftCentsPer30Days,
        level: analysis.level,
        worstZone: analysis.worstZone,
        trend: analysis.trend,
        summary: analysis.summary,
        advice: analysis.advice,
        suggestedCycleMonths: analysis.insufficient ? null : suggestCycleMonths(analysis.level, reminder?.cycleMonths ?? 6),
        updatedAt: now
      } as never);
      return;
    }
    // 环境改动导致指纹变化：旧的待复核草稿立即失效，重算新草稿
    await db.conclusions.update(latest.id, { status: '已失效', updatedAt: Date.now() } as never);
  }
  // 已确认 / 已失效是最新时：旧结论留在历史，另起一条待复核草稿

  const now = Date.now();
  const draft: ConclusionRow = {
    id: `cl-${pianoId}-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    pianoId,
    createdAt: now,
    reviewedAt: null,
    status: '待复核',
    envFingerprint: analysis.envFingerprint,
    sampleCount: analysis.sampleCount,
    driftCentsPer30Days: analysis.driftCentsPer30Days,
    level: analysis.level,
    worstZone: analysis.worstZone,
    trend: analysis.trend,
    summary: analysis.summary,
    advice: analysis.advice,
    suggestedCycleMonths: analysis.insufficient ? null : suggestCycleMonths(analysis.level, reminder?.cycleMonths ?? 6),
    revision: ROW_REVISION,
    updatedAt: now
  };
  await db.conclusions.add(draft);
}

/** 独立调用入口：自己开事务包裹事务内核心 */
export async function refreshPianoLedger(pianoId: string): Promise<void> {
  await db.transaction(
    'rw',
    [db.tunings, db.environments, db.conclusions, db.reminders],
    async () => {
      await refreshPianoLedgerInTx(pianoId);
    }
  );
}

/** 复核确认一条结论：其余「待复核」结论归档为已失效，本条成为最近的已确认结论 */
export async function confirmConclusion(id: string): Promise<void> {
  await db.transaction('rw', [db.conclusions], async () => {
    const target = await db.conclusions.get(id);
    if (!target) return;
    await db.conclusions
      .where('pianoId')
      .equals(target.pianoId)
      .filter((r) => r.status === '待复核' && r.id !== id)
      .modify({ status: '已失效', updatedAt: Date.now() } as never);
    await db.conclusions.update(id, { status: '已确认', reviewedAt: Date.now(), updatedAt: Date.now() } as never);
  });
}

/** 放弃一条待复核结论（不采纳当前重算） */
export async function dismissConclusion(id: string): Promise<void> {
  await db.conclusions.update(id, { status: '已失效', updatedAt: Date.now() } as never);
}

/* ---------------------------- 周期提醒 ---------------------------- */

export async function listReminders(): Promise<ReminderRow[]> {
  const rows = await db.reminders.toArray();
  return rows.sort((a, b) => a.nextDueDate.localeCompare(b.nextDueDate));
}

export async function putReminder(row: ReminderRow): Promise<void> {
  await db.reminders.put(row);
}

export async function updateReminder(id: string, patch: Partial<Reminder>): Promise<void> {
  await db.reminders.update(id, { ...patch, updatedAt: Date.now() } as never);
}

export async function removeReminder(id: string): Promise<void> {
  await db.reminders.delete(id);
}

/* --------------------------- 整库导入导出 --------------------------- */

export interface DatabaseSnapshot {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  pianos: Piano[];
  tunings: Tuning[];
  voicings: Voicing[];
  environments: Environment[];
  reminders: Reminder[];
  conclusions: DriftConclusion[];
}

function stripRow<T>(row: T): Omit<T, keyof Revisioned | 'updatedAt'> {
  const copy = { ...row } as Record<string, unknown>;
  delete copy.revision;
  delete copy.createdAt;
  delete copy.updatedAt;
  return copy as Omit<T, keyof Revisioned | 'updatedAt'>;
}

export async function exportSnapshot(): Promise<DatabaseSnapshot> {
  const [pianos, tunings, voicings, environments, reminders, conclusions] = await Promise.all([
    db.pianos.toArray(),
    db.tunings.toArray(),
    db.voicings.toArray(),
    db.environments.toArray(),
    db.reminders.toArray(),
    db.conclusions.toArray()
  ]);
  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    pianos: pianos.map(stripRow),
    tunings: tunings.map(stripRow),
    voicings: voicings.map(stripRow),
    environments: environments.map(stripRow),
    reminders: reminders.map(stripRow),
    // createdAt / reviewedAt 是结论的领域字段，必须保留，仅去掉 revision / updatedAt
    conclusions: conclusions.map((c) => {
      const { revision: _r, updatedAt: _u, ...rest } = c;
      return rest;
    })
  };
}

function stamp<T>(row: T): T & Revisioned {
  const now = Date.now();
  return { ...row, revision: ROW_REVISION, createdAt: now, updatedAt: now };
}

function stampConclusion(row: DriftConclusion): ConclusionRow {
  const now = Date.now();
  return {
    ...row,
    createdAt: typeof row.createdAt === 'number' ? row.createdAt : now,
    reviewedAt: typeof row.reviewedAt === 'number' ? row.reviewedAt : null,
    revision: ROW_REVISION,
    updatedAt: now
  };
}

export async function importSnapshot(snapshot: DatabaseSnapshot): Promise<void> {
  await db.transaction(
    'rw',
    [db.pianos, db.tunings, db.voicings, db.environments, db.reminders, db.conclusions],
    async () => {
      await Promise.all([
        db.pianos.clear(),
        db.tunings.clear(),
        db.voicings.clear(),
        db.environments.clear(),
        db.reminders.clear(),
        db.conclusions.clear()
      ]);
      await db.pianos.bulkPut(snapshot.pianos.map(stamp));
      await db.tunings.bulkPut(snapshot.tunings.map(stamp));
      await db.voicings.bulkPut(snapshot.voicings.map(stamp));
      await db.environments.bulkPut(snapshot.environments.map(stamp));
      await db.reminders.bulkPut(snapshot.reminders.map(stamp));
      // 兼容旧备份（无 conclusions）：导入后按当前数据重算每台琴的待复核结论
      const conclusions = snapshot.conclusions ?? [];
      if (conclusions.length > 0) {
        await db.conclusions.bulkPut(conclusions.map(stampConclusion));
      } else {
        const pianoIds = Array.from(new Set((await db.tunings.toArray()).map((t) => t.pianoId)));
        for (const pianoId of pianoIds) {
          // 事务内不能再开事务，直接内联 refresh 逻辑的等价操作
          const [tunings, environments, reminder] = await Promise.all([
            db.tunings.where('pianoId').equals(pianoId).toArray(),
            db.environments.where('pianoId').equals(pianoId).toArray(),
            db.reminders.where('pianoId').equals(pianoId).first()
          ]);
          const analysis = analyzeDrift(pianoId, tunings, environments);
          const now = Date.now();
          await db.conclusions.add({
            id: `cl-${pianoId}-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
            pianoId,
            createdAt: now,
            reviewedAt: null,
            status: '待复核',
            envFingerprint: analysis.envFingerprint,
            sampleCount: analysis.sampleCount,
            driftCentsPer30Days: analysis.driftCentsPer30Days,
            level: analysis.level,
            worstZone: analysis.worstZone,
            trend: analysis.trend,
            summary: analysis.summary,
            advice: analysis.advice,
            suggestedCycleMonths: analysis.insufficient ? null : suggestCycleMonths(analysis.level, reminder?.cycleMonths ?? 6),
            revision: ROW_REVISION,
            updatedAt: now
          });
        }
      }
    }
  );
}

/** 清空全部数据并重新灌入演示数据 */
export async function resetDatabase(): Promise<void> {
  await db.transaction(
    'rw',
    [db.pianos, db.tunings, db.voicings, db.environments, db.reminders, db.conclusions],
    async () => {
      await Promise.all([
        db.pianos.clear(),
        db.tunings.clear(),
        db.voicings.clear(),
        db.environments.clear(),
        db.reminders.clear(),
        db.conclusions.clear()
      ]);
    }
  );
  await seedDatabase();
}

/** 各表行数统计 */
export async function countAll(): Promise<Record<string, number>> {
  const [pianos, tunings, voicings, environments, reminders, conclusions] = await Promise.all([
    db.pianos.count(),
    db.tunings.count(),
    db.voicings.count(),
    db.environments.count(),
    db.reminders.count(),
    db.conclusions.count()
  ]);
  return { pianos, tunings, voicings, environments, reminders, conclusions };
}
