/**
 * Renamed / alternate city spellings users type, mapped to the GeoNames primary name exactly as
 * it appears in public/data/cities.min.json (the `n` field). Keys are lowercase single tokens
 * (no spaces) so scripts/build-cities.mjs --check can parse and validate every entry; values
 * may be multi-word. Every value must exist byte-exact in the asset.
 *
 * Consumed by citySearch.ts (alias-aware substring search: an alias key containing the query
 * surfaces its canonical row) and by scripts/build-cities.mjs --check (asserts every value
 * exists in the asset).
 */
export const CITY_ALIASES: Readonly<Record<string, string>> = {
  // Indian renames (GeoNames primary name is the post-rename spelling).
  bangalore: 'Bengaluru',
  bombay: 'Mumbai',
  calcutta: 'Kolkata',
  madras: 'Chennai',
  mysore: 'Mysuru',
  cochin: 'Kochi',
  trivandrum: 'Thiruvananthapuram',
  pondicherry: 'Puducherry',
  gurgaon: 'Gurugram',
  benares: 'Varanasi',
  poona: 'Pune',
  cawnpore: 'Kanpur',
  baroda: 'Vadodara',
  allahabad: 'Prayagraj',
  trichinopoly: 'Tiruchirappalli',
  tuticorin: 'Thoothukudi',
  calicut: 'Kozhikode',
  alleppey: 'Alappuzha',
  quilon: 'Kollam',
  palghat: 'Palakkad',
  // World renames plus ASCII spellings of diacritic primaries (typed without accents).
  saigon: 'Ho Chi Minh City',
  rangoon: 'Yangon',
  peking: 'Beijing',
  canton: 'Guangzhou',
  leningrad: 'Saint Petersburg',
  constantinople: 'Istanbul',
  goteborg: 'Gothenburg',
  sao: 'São Paulo',
  bogota: 'Bogotá',
  zurich: 'Zürich',
  malmo: 'Malmö',
};
