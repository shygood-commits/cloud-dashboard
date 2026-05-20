'use strict';

const fs = require('fs');
const path = require('path');
const iconv = require('iconv-lite');

const CSV_FILE = path.join(__dirname, 'GCP 3개월치 데이터 정리.csv');

function parseCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

function parseCost(raw) {
  const s = raw.replace(/,/g, '').replace(/\s/g, '');
  if (s === '-' || s === '') return 0;
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function formatKRW(n) {
  return Math.round(n).toLocaleString('ko-KR');
}

// ── 데이터 로드 ──────────────────────────────────────────────
const buffer = fs.readFileSync(CSV_FILE);
const content = iconv.decode(buffer, 'euc-kr');
const lines = content.split(/\r?\n/).filter(l => l.trim());

const headers = parseCSVLine(lines[0]);
const monthIdx   = headers.findIndex(h => h === '월');
const serviceIdx = headers.findIndex(h => h === '서비스명');
const costIdx    = headers.findIndex(h => h === 'Cost (KRW)');

if ([monthIdx, serviceIdx, costIdx].some(i => i === -1)) {
  console.error('필수 컬럼을 찾을 수 없습니다.');
  console.error('헤더:', headers);
  process.exit(1);
}

// ── 집계 ────────────────────────────────────────────────────
// monthTotals:   { 월 → 합계 }
// serviceTotals: { 서비스명 → 합계 }
// pivot:         { 서비스명 → { 월 → 합계 } }

const monthTotals   = {};
const serviceTotals = {};
const pivot         = {};

for (let i = 1; i < lines.length; i++) {
  const row = parseCSVLine(lines[i]);
  if (row.length <= Math.max(monthIdx, serviceIdx, costIdx)) continue;

  const month   = row[monthIdx];
  const service = row[serviceIdx];
  const cost    = parseCost(row[costIdx]);

  if (!month || !service) continue;

  monthTotals[month]   = (monthTotals[month]   || 0) + cost;
  serviceTotals[service] = (serviceTotals[service] || 0) + cost;

  if (!pivot[service]) pivot[service] = {};
  pivot[service][month] = (pivot[service][month] || 0) + cost;
}

const months   = Object.keys(monthTotals).sort();
const services = Object.keys(serviceTotals).sort((a, b) => serviceTotals[b] - serviceTotals[a]);

// ── 출력 헬퍼 ───────────────────────────────────────────────
const COL_SERVICE = 36;
const COL_MONTH   = 20;

function pad(str, width, right = false) {
  // 한글 1글자 = 화면 2칸
  let visual = 0;
  for (const ch of str) visual += ch.codePointAt(0) > 0x7F ? 2 : 1;
  const spaces = Math.max(0, width - visual);
  return right ? ' '.repeat(spaces) + str : str + ' '.repeat(spaces);
}

function separator(monthCount) {
  return '-'.repeat(COL_SERVICE + 2 + (COL_MONTH + 2) * monthCount + COL_MONTH + 2);
}

// ── 1. 월별 합계 ─────────────────────────────────────────────
console.log('\n═══════════════════════════════════════');
console.log('  월별 Cost (KRW) 합계');
console.log('═══════════════════════════════════════');
for (const m of months) {
  console.log(`  ${pad(m, 12)}  ${pad(formatKRW(monthTotals[m]), 20, true)} 원`);
}
const grandTotal = Object.values(monthTotals).reduce((a, b) => a + b, 0);
console.log('---------------------------------------');
console.log(`  ${'합계'.padEnd(12)}  ${pad(formatKRW(grandTotal), 20, true)} 원`);

// ── 2. 서비스명 × 월 피벗 테이블 ───────────────────────────
console.log('\n\n');
const sep = separator(months.length);
console.log(sep);

// 헤더 행
process.stdout.write('  ' + pad('서비스명', COL_SERVICE));
for (const m of months) process.stdout.write('  ' + pad(m, COL_MONTH, true));
process.stdout.write('  ' + pad('합계', COL_MONTH, true) + '\n');

console.log(sep);

for (const svc of services) {
  if (serviceTotals[svc] === 0) continue;   // 0원 서비스 생략
  process.stdout.write('  ' + pad(svc, COL_SERVICE));
  for (const m of months) {
    const v = (pivot[svc] && pivot[svc][m]) || 0;
    process.stdout.write('  ' + pad(v === 0 ? '-' : formatKRW(v), COL_MONTH, true));
  }
  process.stdout.write('  ' + pad(formatKRW(serviceTotals[svc]), COL_MONTH, true) + '\n');
}

console.log(sep);

// 합계 행
process.stdout.write('  ' + pad('합  계', COL_SERVICE));
for (const m of months) {
  process.stdout.write('  ' + pad(formatKRW(monthTotals[m]), COL_MONTH, true));
}
process.stdout.write('  ' + pad(formatKRW(grandTotal), COL_MONTH, true) + '\n');
console.log(sep);
console.log();
