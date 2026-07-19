import { z } from "zod";
import { E_A0015_001_DATASET_ID } from "../constants.js";
import { fetchCwaRecords } from "../services/cwa-client.js";
import type { CwaEarthquake, CwaEarthquakeRecords } from "../types.js";

export const recentEarthquakesInputShape = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(10)
    .default(3)
    .describe("要回傳的地震報告筆數，範圍 1-10，預設 3 筆，依發生時間新到舊排序。")
};

const RecentEarthquakesInput = z.object(recentEarthquakesInputShape);
export type RecentEarthquakesInput = z.infer<typeof RecentEarthquakesInput>;

/** CWA intensity scale, ordered weakest to strongest, for picking the max-intensity area. */
const INTENSITY_ORDER = ["0級", "1級", "2級", "3級", "4級", "5弱", "5強", "6弱", "6強", "7級"];

function intensityRank(intensity: string | undefined): number {
  if (!intensity) return -1;
  return INTENSITY_ORDER.indexOf(intensity);
}

export interface EarthquakeSummary {
  earthquakeNo: number;
  originTime: string;
  magnitude: number;
  magnitudeType: string;
  depthKm: number;
  epicenter: string;
  maxIntensity: string;
  reportContent: string;
  detailUrl: string | null;
}

function summarizeEarthquake(earthquake: CwaEarthquake): EarthquakeSummary {
  const areas = earthquake.Intensity?.ShakingArea ?? [];
  const maxIntensity = areas.reduce<string>((max, area) => {
    return intensityRank(area.AreaIntensity) > intensityRank(max) ? area.AreaIntensity : max;
  }, areas[0]?.AreaIntensity ?? "無資料");

  return {
    earthquakeNo: earthquake.EarthquakeNo,
    originTime: earthquake.EarthquakeInfo.OriginTime,
    magnitude: earthquake.EarthquakeInfo.EarthquakeMagnitude.MagnitudeValue,
    magnitudeType: earthquake.EarthquakeInfo.EarthquakeMagnitude.MagnitudeType,
    depthKm: earthquake.EarthquakeInfo.FocalDepth,
    epicenter: earthquake.EarthquakeInfo.Epicenter.Location,
    maxIntensity,
    reportContent: earthquake.ReportContent,
    detailUrl: earthquake.Web ?? null
  };
}

export interface RecentEarthquakesResult {
  [key: string]: unknown;
  earthquakes: EarthquakeSummary[];
}

export async function runRecentEarthquakes(
  limit: number,
  apiKey: string | undefined,
  fetchImpl?: typeof fetch
): Promise<RecentEarthquakesResult> {
  const records = await fetchCwaRecords<CwaEarthquakeRecords>(
    E_A0015_001_DATASET_ID,
    apiKey,
    { limit: String(limit) },
    fetchImpl
  );

  const earthquakes = (records.Earthquake ?? []).slice(0, limit).map(summarizeEarthquake);
  return { earthquakes };
}

export function formatRecentEarthquakesText(result: RecentEarthquakesResult): string {
  if (result.earthquakes.length === 0) {
    return "目前查無近期顯著有感地震報告。";
  }
  const lines = ["# 台灣近期顯著有感地震報告", ""];
  for (const eq of result.earthquakes) {
    lines.push(`## No.${eq.earthquakeNo} — ${eq.originTime}`);
    lines.push(`- 震央位置：${eq.epicenter}`);
    lines.push(`- 規模：${eq.magnitudeType} ${eq.magnitude}`);
    lines.push(`- 深度：${eq.depthKm} 公里`);
    lines.push(`- 最大震度：${eq.maxIntensity}`);
    lines.push(`- 說明：${eq.reportContent}`);
    if (eq.detailUrl) {
      lines.push(`- 詳細報告：${eq.detailUrl}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
