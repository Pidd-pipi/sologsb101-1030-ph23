/**
 * 钢琴档案 JSON 序列化与校验
 * 提醒页用于导出单琴档案与整库备份，并校验导入内容。
 */
import type { Piano } from '$lib/types/piano';
import type { Tuning } from '$lib/types/tuning';
import type { Voicing } from '$lib/types/voicing';
import type { Environment } from '$lib/types/environment';
import type { Reminder } from '$lib/types/reminder';
import type { DriftConclusion } from '$lib/types/conclusion';
import {
  DB_NAME,
  DB_SCHEMA_VERSION,
  db,
  getEffectiveConclusion,
  listConclusions,
  listEnvironments,
  listTunings,
  listVoicings
} from './db';
import { nowIso } from './uuid';
import { zoneDistribution } from './cents';
import { analyzeDrift, suggestCycleMonths, type DriftAnalysis } from './drift';

/** 单台钢琴档案 */
export interface PianoArchive {
  name: string;
  schemaVersion: number;
  exportedAt: string;
  piano: Piano;
  tunings: Tuning[];
  voicings: Voicing[];
  environments: Environment[];
  reminder: Reminder | null;
  /** 结论历史（旧结论永久留存） */
  conclusions: DriftConclusion[];
  /** 导出时生效的结论：没复核前沿用最近一条已确认旧结论 */
  effectiveConclusion: DriftConclusion | null;
  /** 生效结论是否已落后于实时漂移（待复核） */
  conclusionStale: boolean;
  /** 实时漂移（环境改动后立即重算的值，仅供对照） */
  liveDrift: {
    driftCentsPer30Days: number;
    level: DriftAnalysis['level'];
    worstZone: string;
    trend: DriftAnalysis['trend'];
    summary: string;
    advice: string[];
    suggestedCycleMonths: number | null;
  } | null;
  summary: {
    tuningCount: number;
    avgDeviationCents: number;
    maxDeviationCents: number;
    worstZone: string;
    maintenanceCount: number;
    abnormalDays: number;
    lastTuningDate: string;
    nextDueDate: string;
  };
}

type WithRevision = { revision?: number; createdAt?: number; updatedAt?: number };

function stripRevision<T extends WithRevision>(row: T): T {
  const copy = { ...row } as Record<string, unknown>;
  delete copy.revision;
  delete copy.createdAt;
  delete copy.updatedAt;
  return copy as T;
}

/** 汇总某台琴的完整档案 */
export async function buildPianoArchive(pianoId: string): Promise<PianoArchive> {
  const piano = await db.pianos.get(pianoId);
  if (!piano) throw new Error('钢琴档案不存在');
  const [allTunings, allVoicings, allEnvironments, allConclusions, reminder] = await Promise.all([
    listTunings(),
    listVoicings(),
    listEnvironments(),
    listConclusions(),
    db.reminders.where('pianoId').equals(pianoId).first()
  ]);
  const tunings = allTunings.filter((item) => item.pianoId === pianoId);
  const voicings = allVoicings.filter((item) => item.pianoId === pianoId);
  const environments = allEnvironments.filter((item) => item.pianoId === pianoId);
  const conclusions = allConclusions
    .filter((item) => item.pianoId === pianoId)
    .sort((a, b) => b.createdAt - a.createdAt);
  const latest = tunings[0];
  const worstZone = latest ? zoneDistribution(latest.zones).worst : '—';

  // 没复核前沿用最近一条「已确认」旧结论；确认结论缺失才回退待复核
  const effective = await getEffectiveConclusion(pianoId);
  const live = analyzeDrift(pianoId, tunings, environments);
  const conclusionStale = effective ? effective.envFingerprint !== live.envFingerprint : false;

  return {
    name: DB_NAME,
    schemaVersion: DB_SCHEMA_VERSION,
    exportedAt: nowIso(),
    piano: stripRevision(piano),
    tunings: tunings.map(stripRevision),
    voicings: voicings.map(stripRevision),
    environments: environments.map(stripRevision),
    reminder: reminder ? stripRevision(reminder) : null,
    conclusions: conclusions.map((c) => {
      const { revision: _r, updatedAt: _u, ...rest } = c;
      return rest;
    }),
    effectiveConclusion: effective
      ? (() => {
          const { revision: _r, updatedAt: _u, ...rest } = effective;
          return rest;
        })()
      : null,
    conclusionStale,
    liveDrift: live.sampleCount > 0
      ? {
          driftCentsPer30Days: live.driftCentsPer30Days,
          level: live.level,
          worstZone: live.worstZone,
          trend: live.trend,
          summary: live.summary,
          advice: live.advice,
          suggestedCycleMonths: live.insufficient
            ? null
            : suggestCycleMonths(live.level, reminder?.cycleMonths ?? 6)
        }
      : null,
    summary: {
      tuningCount: tunings.length,
      avgDeviationCents: latest ? latest.avgDeviationCents : 0,
      maxDeviationCents: latest ? latest.maxDeviationCents : 0,
      worstZone,
      maintenanceCount: voicings.length,
      abnormalDays: environments.filter((item) => item.abnormal).length,
      lastTuningDate: latest ? latest.date : '—',
      nextDueDate: reminder ? reminder.nextDueDate : '—'
    }
  };
}

export function serializeArchive(archive: PianoArchive): string {
  return JSON.stringify(archive, null, 2);
}

/** 校验并解析档案 / 备份 JSON，失败时抛出可读错误 */
export function parseArchive(text: string): PianoArchive {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('不是合法的 JSON 文本');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('档案根节点必须是对象');
  }
  const candidate = parsed as Partial<PianoArchive>;
  if (typeof candidate.name !== 'string') throw new Error('缺少 name 字段');
  if (typeof candidate.schemaVersion !== 'number') throw new Error('缺少 schemaVersion 字段');
  if (!candidate.piano || typeof candidate.piano.id !== 'string') throw new Error('缺少 piano.id 字段');
  if (!Array.isArray(candidate.tunings)) throw new Error('tunings 必须是数组');
  return candidate as PianoArchive;
}

/** 触发浏览器下载（纯前端，无需后端） */
export function downloadJson(filename: string, text: string): void {
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
