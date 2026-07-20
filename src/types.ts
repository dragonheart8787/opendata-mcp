/**
 * Raw response shapes returned by the CWA Open Data Platform REST API
 * (https://opendata.cwa.gov.tw/), for the two datasets this server uses.
 * These mirror the CWA API documentation / real API responses exactly —
 * do not "clean up" field casing, it must match what CWA actually sends.
 */

export interface CwaApiEnvelope<TRecords> {
  success: "true" | "false";
  result?: {
    resource_id?: string;
    fields?: Array<{ id: string; type: string }>;
  };
  records?: TRecords;
  message?: string;
}

// --- F-C0032-001: 36-hour weather forecast ---

export interface CwaWeatherParameter {
  parameterName: string;
  parameterValue?: string;
  parameterUnit?: string;
}

export interface CwaWeatherTimeEntry {
  startTime: string;
  endTime: string;
  parameter: CwaWeatherParameter;
}

export interface CwaWeatherElement {
  elementName: string;
  time: CwaWeatherTimeEntry[];
}

export interface CwaForecastLocation {
  locationName: string;
  weatherElement: CwaWeatherElement[];
}

export interface CwaForecastRecords {
  datasetDescription: string;
  location: CwaForecastLocation[];
}

// --- E-A0015-001: significant earthquake reports ---

export interface CwaEarthquakeEpicenter {
  Location: string;
  EpicenterLatitude: number;
  EpicenterLongitude: number;
}

export interface CwaEarthquakeMagnitude {
  MagnitudeType: string;
  MagnitudeValue: number;
}

export interface CwaEarthquakeInfo {
  OriginTime: string;
  Source: string;
  FocalDepth: number;
  Epicenter: CwaEarthquakeEpicenter;
  EarthquakeMagnitude: CwaEarthquakeMagnitude;
}

export interface CwaShakingArea {
  AreaDesc: string;
  CountyName: string;
  AreaIntensity: string;
}

export interface CwaEarthquake {
  EarthquakeNo: number;
  ReportType: string;
  ReportColor: string;
  ReportContent: string;
  ReportRemark?: string;
  Web?: string;
  ShakemapImageURI?: string;
  EarthquakeInfo: CwaEarthquakeInfo;
  Intensity: {
    ShakingArea: CwaShakingArea[];
  };
}

export interface CwaEarthquakeRecords {
  datasetDescription: string;
  Earthquake: CwaEarthquake[];
}

// --- MOENV aqx_p_432: hourly air quality index per monitoring station ---
// The v2 API (data.moenv.gov.tw/api/v2) uses all-lowercase field names and
// string-typed values; missing measurements come back as "", "-" or "ND".
// Confirmed against production traffic: a successful response body is a
// *bare* JSON array of records, not wrapped in `{ records: [...] }`. This
// envelope type only describes the object-shaped responses MOENV sends for
// errors (e.g. an invalid api_key) — see `extractRecordsArray` in
// moenv-client.ts for how both shapes are handled.

export interface MoenvApiEnvelope<TRecord> {
  fields?: Array<{ id: string; type: string; info?: { label?: string } }>;
  resource_id?: string;
  total?: number | string;
  limit?: number | string;
  offset?: number | string;
  records?: TRecord[];
  /** Present on error responses (e.g. invalid api_key). */
  message?: string;
}

export interface MoenvAqiRecord {
  sitename: string;
  county: string;
  aqi: string;
  pollutant: string;
  status: string;
  so2: string;
  co: string;
  o3: string;
  o3_8hr: string;
  pm10: string;
  "pm2.5": string;
  no2: string;
  nox: string;
  no: string;
  wind_speed: string;
  wind_direc: string;
  publishtime: string;
  co_8hr: string;
  "pm2.5_avg": string;
  pm10_avg: string;
  so2_avg: string;
  longitude: string;
  latitude: string;
  siteid: string;
}
