// Airports frequently used by Korean travelers: domestic, Japan, Southeast Asia.
// name is what gets saved (also used for map search); tz fills the IANA timezone field.
export const AIRPORT_GROUPS = [
  { group: '국내', tz: 'Asia/Seoul', list: [
    ['인천국제공항', 'ICN', '서울/인천'], ['김포국제공항', 'GMP', '서울/김포'], ['김해국제공항', 'PUS', '부산'],
    ['제주국제공항', 'CJU', '제주'], ['대구국제공항', 'TAE', '대구'], ['청주국제공항', 'CJJ', '청주'],
    ['무안국제공항', 'MWX', '무안/광주'], ['광주공항', 'KWJ', '광주'], ['양양국제공항', 'YNY', '양양/속초'],
    ['여수공항', 'RSU', '여수'], ['울산공항', 'USN', '울산'], ['포항경주공항', 'KPO', '포항/경주'],
    ['사천공항', 'HIN', '진주/사천'], ['군산공항', 'KUV', '군산'], ['원주공항', 'WJU', '원주'],
  ] },
  { group: '일본', tz: 'Asia/Tokyo', list: [
    ['나리타국제공항', 'NRT', '도쿄'], ['하네다공항', 'HND', '도쿄'], ['간사이국제공항', 'KIX', '오사카'],
    ['후쿠오카공항', 'FUK', '후쿠오카'], ['신치토세공항', 'CTS', '삿포로'], ['주부국제공항', 'NGO', '나고야'],
    ['나하공항', 'OKA', '오키나와'], ['기타큐슈공항', 'KKJ', '기타큐슈'], ['마쓰야마공항', 'MYJ', '마쓰야마'],
    ['다카마쓰공항', 'TAK', '다카마쓰'], ['히로시마공항', 'HIJ', '히로시마'], ['구마모토공항', 'KMJ', '구마모토'],
    ['가고시마공항', 'KOJ', '가고시마'], ['오이타공항', 'OIT', '오이타'], ['나가사키공항', 'NGS', '나가사키'],
    ['사가공항', 'HSG', '사가'], ['미야자키공항', 'KMI', '미야자키'], ['시즈오카공항', 'FSZ', '시즈오카'],
    ['센다이공항', 'SDJ', '센다이'], ['요나고공항', 'YGJ', '요나고'],
  ] },
  { group: '동남아', tz: null, list: [
    ['다낭국제공항', 'DAD', '베트남 다낭', 'Asia/Ho_Chi_Minh'], ['깜라인국제공항', 'CXR', '베트남 나트랑', 'Asia/Ho_Chi_Minh'],
    ['노이바이국제공항', 'HAN', '베트남 하노이', 'Asia/Ho_Chi_Minh'], ['떤선녓국제공항', 'SGN', '베트남 호찌민', 'Asia/Ho_Chi_Minh'],
    ['푸꾸옥국제공항', 'PQC', '베트남 푸꾸옥', 'Asia/Ho_Chi_Minh'], ['리엔크엉국제공항', 'DLI', '베트남 달랏', 'Asia/Ho_Chi_Minh'],
    ['수완나품국제공항', 'BKK', '태국 방콕', 'Asia/Bangkok'], ['돈므앙국제공항', 'DMK', '태국 방콕', 'Asia/Bangkok'],
    ['푸껫국제공항', 'HKT', '태국 푸껫', 'Asia/Bangkok'], ['치앙마이국제공항', 'CNX', '태국 치앙마이', 'Asia/Bangkok'],
    ['막탄세부국제공항', 'CEB', '필리핀 세부', 'Asia/Manila'], ['니노이아키노국제공항', 'MNL', '필리핀 마닐라', 'Asia/Manila'],
    ['팡라오국제공항', 'TAG', '필리핀 보홀', 'Asia/Manila'], ['클락국제공항', 'CRK', '필리핀 클락', 'Asia/Manila'],
    ['칼리보국제공항', 'KLO', '필리핀 보라카이', 'Asia/Manila'], ['싱가포르창이공항', 'SIN', '싱가포르', 'Asia/Singapore'],
    ['쿠알라룸푸르국제공항', 'KUL', '말레이시아 쿠알라룸푸르', 'Asia/Kuala_Lumpur'], ['코타키나발루국제공항', 'BKI', '말레이시아 코타키나발루', 'Asia/Kuala_Lumpur'],
    ['응우라라이국제공항', 'DPS', '인도네시아 발리', 'Asia/Makassar'], ['수카르노하타국제공항', 'CGK', '인도네시아 자카르타', 'Asia/Jakarta'],
    ['왓따이국제공항', 'VTE', '라오스 비엔티안', 'Asia/Vientiane'], ['씨엠립앙코르국제공항', 'SAI', '캄보디아 씨엠립', 'Asia/Phnom_Penh'],
  ] },
];

export const AIRPORTS = AIRPORT_GROUPS.flatMap(({ group, tz, list }) =>
  list.map(([name, code, city, zone]) => ({ group, name, code, city, tz: zone ?? tz })));

export function findAirport(text) {
  const value = String(text ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (!value) return null;
  return AIRPORTS.find(a => a.code === value || a.name.replace(/\s+/g, '').toUpperCase() === value) ?? null;
}

// <select> helper with 국내/일본/동남아 groups; picking one fills the airport + timezone inputs.
export function airportPicker(input, timezoneInputFinder) {
  const select = document.createElement('select');
  select.className = 'airport-picker';
  select.setAttribute('aria-label', '자주 가는 공항에서 선택');
  select.add(new Option('공항 목록에서 선택', ''));
  for (const { group, tz, list } of AIRPORT_GROUPS) {
    const optgroup = document.createElement('optgroup'); optgroup.label = group;
    for (const [name, code, city] of list) optgroup.append(new Option(`${city} · ${name} (${code})`, code));
    select.append(optgroup);
  }
  select.add(new Option('목록에 없음 (직접 입력)', 'custom'));
  const sync = () => { const match = findAirport(input.value); select.value = match ? match.code : (input.value ? 'custom' : ''); };
  select.onchange = () => {
    const airport = AIRPORTS.find(a => a.code === select.value);
    if (airport) {
      input.value = airport.name;
      const zone = timezoneInputFinder();
      if (zone) zone.value = airport.tz;
    } else if (select.value === 'custom') { input.focus(); }
  };
  input.addEventListener('change', () => {
    // Typing a code like "NRT" becomes the full name + timezone.
    const match = findAirport(input.value);
    if (match) { input.value = match.name; const zone = timezoneInputFinder(); if (zone) zone.value = match.tz; }
    sync();
  });
  sync();
  return select;
}
