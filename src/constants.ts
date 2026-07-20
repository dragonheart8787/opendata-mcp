export const CWA_API_BASE_URL = "https://opendata.cwa.gov.tw/api/v1/rest/datastore";

/** Page for applying for / managing a CWA Open Data API key. */
export const CWA_AUTH_KEY_URL = "https://opendata.cwa.gov.tw/user/authkey";

export const F_C0032_001_DATASET_ID = "F-C0032-001";
export const E_A0015_001_DATASET_ID = "E-A0015-001";

export const MOENV_API_BASE_URL = "https://data.moenv.gov.tw/api/v2";

/** MOENV open data platform home — register here, then copy the API key from the member area. */
export const MOENV_SIGNUP_URL = "https://data.moenv.gov.tw/";

export const AQX_P_432_DATASET_ID = "aqx_p_432";

/**
 * Records requested per aqx_p_432 call so client-side filtering (see
 * air-quality.ts) sees the whole nationwide station list, not a partial
 * page. Taiwan's general ambient network has ~83-90 stations as of 2021-
 * 2026 (source: MOENV dataset docs and observed API traffic), so this
 * leaves well over 10x headroom for network growth. It's also, per MOENV's
 * own API documentation, the maximum `limit` the v2 API accepts in a single
 * request — so this is already the most we could ask for either way.
 */
export const AQX_P_432_FETCH_LIMIT = 1000;

/**
 * Cache TTLs (seconds), matched to each dataset's own update cadence:
 * F-C0032-001 updates a few times per day, E-A0015-001 on each significant
 * quake, aqx_p_432 hourly.
 */
export const WEATHER_CACHE_TTL_SECONDS = 30 * 60;
export const EARTHQUAKE_CACHE_TTL_SECONDS = 5 * 60;
export const AIR_QUALITY_CACHE_TTL_SECONDS = 10 * 60;

/**
 * Taiwan's 22 counties/cities as used by CWA's `locationName` parameter.
 * CWA uses the traditional character "臺" (not the common variant "台") in
 * 臺北市, 臺中市, 臺南市, and 臺東縣 — this must match exactly or the API
 * returns an empty result.
 */
export const TAIWAN_CITIES = [
  "臺北市",
  "新北市",
  "桃園市",
  "臺中市",
  "臺南市",
  "高雄市",
  "基隆市",
  "新竹市",
  "嘉義市",
  "新竹縣",
  "苗栗縣",
  "彰化縣",
  "南投縣",
  "雲林縣",
  "嘉義縣",
  "屏東縣",
  "宜蘭縣",
  "花蓮縣",
  "臺東縣",
  "澎湖縣",
  "金門縣",
  "連江縣"
] as const;

export type TaiwanCity = (typeof TAIWAN_CITIES)[number];
