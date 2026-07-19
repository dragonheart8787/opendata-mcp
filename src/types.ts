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
