// Adapter barrel - re-exports every per-family fetcher module so importers
// can reference `jobSources/adapters/index.js` as one entry point (Wave 1,
// T621). `jobSources/index.ts` remains the canonical public surface and
// re-exports these same names; the registry references the family modules
// directly.

export type { RawJob } from './http.js';
export { fetcher, matchHaystack } from './http.js';
export { fetchGreenhouseDetail, fetchGreenhouse } from './greenhouse.js';
export { fetchAshby } from './ashby.js';
export { fetchLever } from './lever.js';
export { fetchWorkday } from './workday.js';
export { fetchRss, parseXmlFeedItems } from './rss.js';
export { fetchJsonBoard } from './json.js';
export { fetchSmartRecruiters } from './smartrecruiters.js';
export { fetchRecruitee } from './recruitee.js';
export { fetchPersonio } from './personio.js';
export { fetchJobicy } from './jobicy.js';
export { mapHNThreadComments, fetchHNAlgolia } from './hnalgolia.js';
export { SUPPORTED_SCRAPER_PROVIDERS, fetchViaScraper } from './scraper.js';
