export const CWA_API_BASE_URL = "https://opendata.cwa.gov.tw/api/v1/rest/datastore";

/** Page for applying for / managing a CWA Open Data API key. */
export const CWA_AUTH_KEY_URL = "https://opendata.cwa.gov.tw/user/authkey";

export const F_C0032_001_DATASET_ID = "F-C0032-001";
export const E_A0015_001_DATASET_ID = "E-A0015-001";

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
