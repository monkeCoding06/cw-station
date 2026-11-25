import { $ } from './util.js';

/*
 * Callsign prefix lookup, entirely in the browser. Prefixes follow the ITU
 * allocations plus the best-known DXCC entities; the longest matching prefix wins.
 * Some countries also name the call area, taken from the first digit of the call.
 */

const US_AREAS = {
  0: 'CO, IA, KS, MN, MO, NE, ND, SD', 1: 'CT, ME, MA, NH, RI, VT', 2: 'NY, NJ', 3: 'PA, DE, MD, DC',
  4: 'AL, FL, GA, KY, NC, SC, TN, VA', 5: 'AR, LA, MS, NM, OK, TX', 6: 'California',
  7: 'AZ, ID, MT, NV, OR, UT, WA, WY', 8: 'MI, OH, WV', 9: 'IL, IN, WI',
};
const CA_AREAS = {
  1: 'Nova Scotia', 2: 'Quebec', 3: 'Ontario', 4: 'Manitoba', 5: 'Saskatchewan',
  6: 'Alberta', 7: 'British Columbia', 8: 'Northwest Territories', 9: 'New Brunswick', 0: 'Nunavut',
};
const JA_AREAS = {
  1: 'Kanto', 2: 'Tokai', 3: 'Kansai', 4: 'Chugoku', 5: 'Shikoku',
  6: 'Kyushu / Okinawa', 7: 'Tohoku', 8: 'Hokkaido', 9: 'Hokuriku', 0: 'Shinetsu',
};
const VK_AREAS = {
  1: 'Australian Capital Territory', 2: 'New South Wales', 3: 'Victoria', 4: 'Queensland',
  5: 'South Australia', 6: 'Western Australia', 7: 'Tasmania', 8: 'Northern Territory', 9: 'External territories',
};
const OE_AREAS = {
  1: 'Vienna', 2: 'Salzburg', 3: 'Lower Austria', 4: 'Burgenland', 5: 'Upper Austria',
  6: 'Styria', 7: 'Tyrol', 8: 'Carinthia', 9: 'Vorarlberg',
};

// [comma separated prefixes (ranges like DA-DR allowed), name, optional call areas]
const TABLE = [
  ['AA-AG,AI-AK,K,N,W', 'United States', US_AREAS],
  ['AH,KH6,KH7,NH,WH6,WH7', 'Hawaii (USA)'],
  ['AL,KL,NL,WL', 'Alaska (USA)'],
  ['KP3,KP4,NP3,NP4,WP3,WP4', 'Puerto Rico (USA)'],
  ['KP2,NP2,WP2', 'US Virgin Islands (USA)'],
  ['KH2,NH2,WH2,AH2', 'Guam (USA)'],
  ['VE,VA', 'Canada', CA_AREAS],
  ['VO', 'Newfoundland & Labrador (Canada)'],
  ['VY', 'Canada (Yukon, PEI, Nunavut)'],
  ['CF-CK', 'Canada'],
  ['JA-JS,7J-7N,8J-8N', 'Japan', JA_AREAS],
  ['VK', 'Australia', VK_AREAS],
  ['OE', 'Austria', OE_AREAS],
  ['DA-DR', 'Germany'],
  ['HB', 'Switzerland'],
  ['HB0', 'Liechtenstein'],
  ['F,TK', 'France'],
  ['I', 'Italy'],
  ['G,M,2E', 'England'],
  ['GM,MM,2M', 'Scotland'],
  ['GW,MW,2W', 'Wales'],
  ['GI,MI,2I', 'Northern Ireland'],
  ['GD,MD,2D', 'Isle of Man'],
  ['GJ,MJ,2J', 'Jersey'],
  ['GU,MU,2U', 'Guernsey'],
  ['EI,EJ', 'Ireland'],
  ['EA-EH', 'Spain'],
  ['CT', 'Portugal'],
  ['CU', 'Azores (Portugal)'],
  ['PA-PI', 'Netherlands'],
  ['ON-OT', 'Belgium'],
  ['LX', 'Luxembourg'],
  ['OZ', 'Denmark'],
  ['OY', 'Faroe Islands'],
  ['OX', 'Greenland'],
  ['LA-LN', 'Norway'],
  ['JW', 'Svalbard'],
  ['SA-SM,7S,8S', 'Sweden'],
  ['OH', 'Finland'],
  ['OH0', 'Aland Islands'],
  ['TF', 'Iceland'],
  ['SN-SR,3Z', 'Poland'],
  ['OK,OL', 'Czech Republic'],
  ['OM', 'Slovakia'],
  ['HA,HG', 'Hungary'],
  ['YO-YR', 'Romania'],
  ['LZ', 'Bulgaria'],
  ['SV-SZ,J4', 'Greece'],
  ['9A', 'Croatia'],
  ['S5', 'Slovenia'],
  ['E7', 'Bosnia and Herzegovina'],
  ['YT,YU', 'Serbia'],
  ['4O', 'Montenegro'],
  ['Z3', 'North Macedonia'],
  ['ZA', 'Albania'],
  ['9H', 'Malta'],
  ['5B,C4,H2,P3', 'Cyprus'],
  ['TA-TC,YM', 'Turkey'],
  ['ES', 'Estonia'],
  ['YL', 'Latvia'],
  ['LY', 'Lithuania'],
  ['EU-EW', 'Belarus'],
  ['ER', 'Moldova'],
  ['EM-EO,UR-UZ', 'Ukraine'],
  ['R,UA-UI', 'Russia'],
  ['UN-UQ', 'Kazakhstan'],
  ['UJ-UM', 'Uzbekistan'],
  ['EX', 'Kyrgyzstan'],
  ['EY', 'Tajikistan'],
  ['EZ', 'Turkmenistan'],
  ['EK', 'Armenia'],
  ['4J,4K', 'Azerbaijan'],
  ['4L', 'Georgia'],
  ['3A', 'Monaco'],
  ['C3', 'Andorra'],
  ['T7', 'San Marino'],
  ['HV', 'Vatican'],
  ['ZB,ZG', 'Gibraltar'],
  ['B,BY,BA-BZ,3H-3U', 'China'],
  ['BV,BM-BQ', 'Taiwan'],
  ['VR', 'Hong Kong'],
  ['XX', 'Macao'],
  ['HL,DS,DT,6K-6N', 'South Korea'],
  ['P5', 'North Korea'],
  ['JT,JU,JV', 'Mongolia'],
  ['VU,AT-AW,8T-8Y', 'India'],
  ['AP,6P-6S', 'Pakistan'],
  ['S2,S3', 'Bangladesh'],
  ['4S', 'Sri Lanka'],
  ['9N', 'Nepal'],
  ['A5', 'Bhutan'],
  ['8Q', 'Maldives'],
  ['HS,E2', 'Thailand'],
  ['XV,3W', 'Vietnam'],
  ['XU', 'Cambodia'],
  ['XW', 'Laos'],
  ['XY,XZ', 'Myanmar'],
  ['9M', 'Malaysia'],
  ['9V,S6', 'Singapore'],
  ['V8', 'Brunei'],
  ['YB-YH,7A-7I,8A-8I', 'Indonesia'],
  ['DU-DZ,4D-4I', 'Philippines'],
  ['YA', 'Afghanistan'],
  ['EP,EQ', 'Iran'],
  ['YI', 'Iraq'],
  ['YK,6C', 'Syria'],
  ['OD', 'Lebanon'],
  ['JY', 'Jordan'],
  ['4X,4Z', 'Israel'],
  ['E4', 'Palestine'],
  ['HZ,7Z,8Z', 'Saudi Arabia'],
  ['A9', 'Bahrain'],
  ['A7', 'Qatar'],
  ['A6', 'United Arab Emirates'],
  ['A4', 'Oman'],
  ['9K', 'Kuwait'],
  ['7O', 'Yemen'],
  ['SU,6A,6B', 'Egypt'],
  ['5A', 'Libya'],
  ['3V,TS', 'Tunisia'],
  ['7X', 'Algeria'],
  ['CN,5C-5G', 'Morocco'],
  ['5T', 'Mauritania'],
  ['6W,6V', 'Senegal'],
  ['C5', 'Gambia'],
  ['J5', 'Guinea-Bissau'],
  ['3X', 'Guinea'],
  ['9L', 'Sierra Leone'],
  ['EL,A8,D5,5L,5M', 'Liberia'],
  ['TU', "Cote d'Ivoire"],
  ['9G', 'Ghana'],
  ['5V', 'Togo'],
  ['TY', 'Benin'],
  ['5N,5O', 'Nigeria'],
  ['TZ', 'Mali'],
  ['5U', 'Niger'],
  ['XT', 'Burkina Faso'],
  ['TT', 'Chad'],
  ['TJ', 'Cameroon'],
  ['TL', 'Central African Republic'],
  ['TN', 'Congo'],
  ['9Q-9T', 'DR Congo'],
  ['TR', 'Gabon'],
  ['3C', 'Equatorial Guinea'],
  ['S9', 'Sao Tome and Principe'],
  ['D2,D3', 'Angola'],
  ['D4', 'Cape Verde'],
  ['ST,6T,6U', 'Sudan'],
  ['Z8', 'South Sudan'],
  ['ET,9E,9F', 'Ethiopia'],
  ['E3', 'Eritrea'],
  ['J2', 'Djibouti'],
  ['T5,6O', 'Somalia'],
  ['5Y,5Z', 'Kenya'],
  ['5H,5I', 'Tanzania'],
  ['5X', 'Uganda'],
  ['9X', 'Rwanda'],
  ['9U', 'Burundi'],
  ['9J', 'Zambia'],
  ['7Q', 'Malawi'],
  ['C8,C9', 'Mozambique'],
  ['Z2', 'Zimbabwe'],
  ['A2,8O', 'Botswana'],
  ['V5', 'Namibia'],
  ['ZR-ZU,H5,S4', 'South Africa'],
  ['7P', 'Lesotho'],
  ['3DA', 'Eswatini'],
  ['5R,6X', 'Madagascar'],
  ['3B', 'Mauritius'],
  ['S7', 'Seychelles'],
  ['D6', 'Comoros'],
  ['ZD7', 'Saint Helena'],
  ['ZD8', 'Ascension Island'],
  ['XA-XI,4A-4C,6D-6J', 'Mexico'],
  ['TG,TD', 'Guatemala'],
  ['V3', 'Belize'],
  ['YS,HU', 'El Salvador'],
  ['HQ,HR', 'Honduras'],
  ['YN,H6,H7', 'Nicaragua'],
  ['TI,TE', 'Costa Rica'],
  ['HO,HP,H3,3E,3F', 'Panama'],
  ['CM-CO,T4', 'Cuba'],
  ['6Y', 'Jamaica'],
  ['HH', 'Haiti'],
  ['HI', 'Dominican Republic'],
  ['C6', 'Bahamas'],
  ['8P', 'Barbados'],
  ['9Y,9Z', 'Trinidad and Tobago'],
  ['J3', 'Grenada'],
  ['J6', 'Saint Lucia'],
  ['J7', 'Dominica'],
  ['J8', 'Saint Vincent'],
  ['V2', 'Antigua and Barbuda'],
  ['V4', 'Saint Kitts and Nevis'],
  ['ZF', 'Cayman Islands'],
  ['VP9', 'Bermuda'],
  ['VP5', 'Turks and Caicos'],
  ['VP2', 'British Leeward / Virgin Islands'],
  ['P4', 'Aruba'],
  ['PJ', 'Curacao / Sint Maarten (Dutch Caribbean)'],
  ['HK,HJ,5J,5K', 'Colombia'],
  ['YV,YW,YX,YY,4M', 'Venezuela'],
  ['8R', 'Guyana'],
  ['PZ', 'Suriname'],
  ['HC,HD', 'Ecuador'],
  ['OA-OC,4T', 'Peru'],
  ['CP', 'Bolivia'],
  ['CA-CE,XQ,XR,3G', 'Chile'],
  ['CE0', 'Easter Island / Chilean islands'],
  ['CE9,KC4', 'Antarctica'],
  ['LO-LW,AY,AZ,L2-L9', 'Argentina'],
  ['CX,CV,CW', 'Uruguay'],
  ['ZP', 'Paraguay'],
  ['PP-PY,ZV-ZZ', 'Brazil'],
  ['VP8', 'Falkland Islands'],
  ['ZK-ZM,ZL', 'New Zealand'],
  ['E5', 'Cook Islands'],
  ['E6', 'Niue'],
  ['A3', 'Tonga'],
  ['5W', 'Samoa'],
  ['3D2', 'Fiji'],
  ['YJ', 'Vanuatu'],
  ['H4', 'Solomon Islands'],
  ['P2', 'Papua New Guinea'],
  ['T8', 'Palau'],
  ['V6', 'Micronesia'],
  ['V7', 'Marshall Islands'],
  ['C2', 'Nauru'],
  ['T2', 'Tuvalu'],
  ['T3', 'Kiribati'],
  ['FK', 'New Caledonia (France)'],
  ['FO', 'French Polynesia'],
  ['FG', 'Guadeloupe (France)'],
  ['FM', 'Martinique (France)'],
  ['FY', 'French Guiana'],
  ['FR', 'Reunion (France)'],
  ['4U', 'United Nations'],
];

const entries = new Map();

function expand(spec) {
  const m = /^([A-Z0-9]*)([A-Z0-9])-[A-Z0-9]*([A-Z0-9])$/.exec(spec);
  if (!m) return [spec];
  const [, head, from, to] = m;
  const prefixes = [];
  for (let c = from.charCodeAt(0); c <= to.charCodeAt(0); c++) prefixes.push(head + String.fromCharCode(c));
  return prefixes;
}

for (const [specs, name, areas] of TABLE) {
  for (const spec of specs.split(',')) {
    for (const prefix of expand(spec)) entries.set(prefix, { name, areas });
  }
}

/** Resolves a typed prefix or full callsign. Returns { name, area } or null. */
export function lookupPrefix(text) {
  const parts = text.toUpperCase().replace(/[^A-Z0-9/]/g, '').split('/').filter(Boolean);
  for (const part of parts) {
    for (let length = Math.min(part.length, 4); length > 0; length--) {
      const hit = entries.get(part.slice(0, length));
      if (!hit) continue;
      const digit = /\d/.exec(part)?.[0];
      const area = hit.areas && digit !== undefined && part.indexOf(digit) >= length - 1 ? hit.areas[digit] : null;
      return { name: hit.name, area, digit };
    }
  }
  return null;
}

export function initPrefixLookup() {
  const input = $('prefixInput');
  const result = $('prefixResult');
  input.addEventListener('input', () => {
    const text = input.value.trim();
    if (!text) { result.textContent = ''; return; }
    const hit = lookupPrefix(text);
    if (!hit) { result.textContent = 'No match'; return; }
    result.textContent = hit.area ? `${hit.name} · area ${hit.digit}: ${hit.area}` : hit.name;
  });
}
