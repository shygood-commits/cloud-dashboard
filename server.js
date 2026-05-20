'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const chokidar = require('chokidar');
const iconv = require('iconv-lite');
const cors = require('cors');
const xlsx = require('xlsx');
const { exec } = require('child_process'); // Git 자동 배포를 위한 child_process

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname))); // 웹 정적 파일 서빙

// DB 및 경로 구성
const DB_PATH = path.join(__dirname, 'cloud_cost.db');
const WATCH_DIR = 'G:\\공유 드라이브\\#구매기획\\07. 자체기획업무\\AI 바이브코딩\\선병훈\\cloud-dashboard-raw';

// 상태 보관용 메모리 객체
let syncStatus = {
  lastUpdated: '-',
  lastFile: '-',
  processedRows: 0,
  status: '대기 중',
  watchedPath: WATCH_DIR
};

// ── SQLite DB 초기화 ──────────────────────────────────────────
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('DB 연결 실패:', err.message);
  } else {
    console.log('SQLite DB 연결 성공:', DB_PATH);
    
    // WAL(Write-Ahead Logging) 모드를 활성화하여 
    // 백엔드 기동 중에도 DB Browser 등 외부 툴의 직접적인 읽기/쓰기 락 충돌을 완전히 방지합니다.
    db.run('PRAGMA journal_mode=WAL', (err) => {
      if (err) {
        console.error('WAL 모드 설정 에러:', err.message);
      } else {
        console.log('SQLite WAL (Write-Ahead Logging) 모드 활성화 완료.');
      }
    });
    
    initDatabase();
  }
});

function initDatabase() {
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS costs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_name TEXT,
        month TEXT,
        service TEXT,
        cost REAL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_costs_month_service 
      ON costs(month, service)
    `);
    
    db.run(`
      CREATE INDEX IF NOT EXISTS idx_costs_file_name
      ON costs(file_name)
    `);
    
    console.log('SQLite 테이블 및 인덱스 초기화 완료.');
    
    // 서버 시작 시 감시 폴더 내 기존 파일 스캔 및 파싱 실행 (CSV & XLSX 통합)
    scanAndProcessExistingFiles();
  });
}

// ── CSV 파서 ──────────────────────────────────────────────────
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
  if (raw === undefined || raw === null) return 0;
  if (typeof raw === 'number') return raw;
  const s = raw.toString().replace(/,/g, '').replace(/\s/g, '');
  if (s === '-' || s === '') return 0;
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

// ── 파일 확장자별 처리 분기 ───────────────────
function processFile(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.csv') {
    return processCSVFile(filePath);
  } else if (ext === '.xlsx') {
    return processXLSXFile(filePath);
  } else {
    console.log(`[지원 안 함] 지원하지 않는 파일 형식입니다: ${path.basename(filePath)}`);
    return Promise.resolve();
  }
}

// 1. CSV 파일 처리
function processCSVFile(filePath) {
  return new Promise((resolve, reject) => {
    const fileName = path.basename(filePath);
    console.log(`[감지] CSV 파일 처리 시작: ${fileName}`);
    syncStatus.status = '동기화 중...';
    
    try {
      const buffer = fs.readFileSync(filePath);
      const content = iconv.decode(buffer, 'euc-kr');
      const lines = content.split(/\r?\n/).filter(l => l.trim());

      if (lines.length < 2) {
        console.log(`[경고] 파일 내용이 비어있거나 부족합니다: ${fileName}`);
        syncStatus.status = '대기 중';
        return resolve();
      }

      const headers = parseCSVLine(lines[0]);
      const monthIdx   = headers.findIndex(h => h === '월');
      const serviceIdx = headers.findIndex(h => h === '서비스명');
      const costIdx    = headers.findIndex(h => h === 'Cost (KRW)');

      if ([monthIdx, serviceIdx, costIdx].some(i => i === -1)) {
        console.error(`[에러] 필수 컬럼이 누락되었습니다. 헤더:`, headers);
        syncStatus.status = '에러 (컬럼 구조 안맞음)';
        return reject(new Error('필수 컬럼 누락'));
      }

      db.serialize(() => {
        db.run('DELETE FROM costs WHERE file_name = ?', [fileName], (err) => {
          if (err) {
            console.error('기존 데이터 삭제 실패:', err.message);
            syncStatus.status = 'DB 삭제 실패';
            return reject(err);
          }
          
          db.run('BEGIN TRANSACTION', (err) => {
            if (err) return reject(err);
          });
          
          const stmt = db.prepare('INSERT INTO costs (file_name, month, service, cost) VALUES (?, ?, ?, ?)', (err) => {
            if (err) return reject(err);
          });
          let insertedCount = 0;

          for (let i = 1; i < lines.length; i++) {
            const row = parseCSVLine(lines[i]);
            if (row.length <= Math.max(monthIdx, serviceIdx, costIdx)) continue;

            const month   = row[monthIdx];
            const service = row[serviceIdx];
            const cost    = parseCost(row[costIdx]);

            if (!month || !service) continue;

            stmt.run(fileName, month, service, cost);
            insertedCount++;
          }

          stmt.finalize((err) => {
            if (err) return reject(err);
          });

          db.run('COMMIT', (err) => {
            if (err) {
              console.error('트랜잭션 커밋 에러:', err.message);
              syncStatus.status = 'DB 저장 실패';
              reject(err);
            } else {
              console.log(`[완료] SQLite 적재 완료: ${fileName} (${insertedCount}행)`);
              
              // 상태 업데이트
              syncStatus.lastUpdated = new Date().toLocaleString('ko-KR');
              syncStatus.lastFile = fileName;
              syncStatus.processedRows = insertedCount;
              syncStatus.status = '완료 (정상 연동됨)';
              
              resolve();
            }
          });
        });
      });

    } catch (error) {
      console.error('CSV 처리 중 에러 발생:', error.message);
      syncStatus.status = '에러 발생';
      reject(error);
    }
  });
}

// 2. XLSX 엑셀 파일 처리
function processXLSXFile(filePath) {
  return new Promise((resolve, reject) => {
    const fileName = path.basename(filePath);
    console.log(`[감지] XLSX 파일 처리 시작: ${fileName}`);
    syncStatus.status = '동기화 중...';

    try {
      const workbook = xlsx.readFile(filePath);
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      
      const rows = xlsx.utils.sheet_to_json(sheet, { header: 1 });

      if (rows.length < 2) {
        console.log(`[경고] 엑셀 파일 내용이 비어있거나 부족합니다: ${fileName}`);
        syncStatus.status = '대기 중';
        return resolve();
      }

      const headers = rows[0].map(h => (h !== undefined && h !== null) ? h.toString().trim() : '');
      const monthIdx   = headers.findIndex(h => h === '월');
      const serviceIdx = headers.findIndex(h => h === '서비스명');
      const costIdx    = headers.findIndex(h => h === 'Cost (KRW)');

      if ([monthIdx, serviceIdx, costIdx].some(i => i === -1)) {
        console.error(`[에러] 필수 컬럼이 누락되었습니다. 헤더:`, headers);
        syncStatus.status = '에러 (컬럼 구조 안맞음)';
        return reject(new Error('필수 컬럼 누락'));
      }

      db.serialize(() => {
        db.run('DELETE FROM costs WHERE file_name = ?', [fileName], (err) => {
          if (err) {
            console.error('기존 데이터 삭제 실패:', err.message);
            syncStatus.status = 'DB 삭제 실패';
            return reject(err);
          }
          
          db.run('BEGIN TRANSACTION', (err) => {
            if (err) return reject(err);
          });
          
          const stmt = db.prepare('INSERT INTO costs (file_name, month, service, cost) VALUES (?, ?, ?, ?)', (err) => {
            if (err) return reject(err);
          });
          let insertedCount = 0;

          for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            if (!row || row.length <= Math.max(monthIdx, serviceIdx, costIdx)) continue;

            const month   = row[monthIdx] ? row[monthIdx].toString().trim() : '';
            const service = row[serviceIdx] ? row[serviceIdx].toString().trim() : '';
            const cost    = parseCost(row[costIdx]);

            if (!month || !service) continue;

            stmt.run(fileName, month, service, cost);
            insertedCount++;
          }

          stmt.finalize((err) => {
            if (err) return reject(err);
          });

          db.run('COMMIT', (err) => {
            if (err) {
              console.error('트랜잭션 커밋 에러:', err.message);
              syncStatus.status = 'DB 저장 실패';
              reject(err);
            } else {
              console.log(`[완료] SQLite 적재 완료: ${fileName} (${insertedCount}행)`);
              
              // 상태 업데이트
              syncStatus.lastUpdated = new Date().toLocaleString('ko-KR');
              syncStatus.lastFile = fileName;
              syncStatus.processedRows = insertedCount;
              syncStatus.status = '완료 (정상 연동됨)';
              
              resolve();
            }
          });
        });
      });

    } catch (error) {
      console.error('XLSX 처리 중 에러 발생:', error.message);
      syncStatus.status = '에러 발생';
      reject(error);
    }
  });
}

// ── 3. 정적 JSON 빌드 및 깃허브 자동 배포 기능 (Pre-render 하이브리드) ─────────────────
function exportStaticJSON() {
  console.log('[Build] Cloudflare Pages 호스팅 연동을 위한 정적 JSON 파일 빌드 시작...');
  
  // 1) summary.json 생성
  const sumQuery = `
    SELECT month, SUM(cost) as totalCost
    FROM costs
    GROUP BY month
    ORDER BY month ASC
  `;
  
  db.all(sumQuery, [], (err, sumRows) => {
    if (err) return console.error('[Build] summary.json 빌드 에러:', err.message);
    const grandTotal = sumRows.reduce((acc, row) => acc + row.totalCost, 0);
    const sumJSON = JSON.stringify({ grandTotal, monthly: sumRows }, null, 2);
    fs.writeFileSync(path.join(__dirname, 'summary.json'), sumJSON, 'utf8');
    
    // 2) pivot.json 생성
    db.all('SELECT DISTINCT month FROM costs ORDER BY month ASC', [], (err, monthRows) => {
      if (err) return console.error('[Build] pivot.json 빌드 에러 (월 목록):', err.message);
      const months = monthRows.map(r => r.month);
      
      const pivotQuery = `
        SELECT service, month, SUM(cost) as cost
        FROM costs
        GROUP BY service, month
      `;
      
      db.all(pivotQuery, [], (err, dataRows) => {
        if (err) return console.error('[Build] pivot.json 빌드 에러 (피벗 데이터):', err.message);
        
        const pivot = {};
        const serviceTotals = {};
        dataRows.forEach(row => {
          const { service, month, cost } = row;
          if (!pivot[service]) {
            pivot[service] = {};
            serviceTotals[service] = 0;
          }
          pivot[service][month] = cost;
          serviceTotals[service] += cost;
        });
        
        const rankedServices = Object.keys(serviceTotals).map(name => ({
          name,
          totalCost: serviceTotals[name],
          monthlyCosts: months.reduce((acc, m) => {
            acc[m] = pivot[name][m] || 0;
            return acc;
          }, {})
        })).sort((a, b) => b.totalCost - a.totalCost);
        
        const pivotJSON = JSON.stringify({ months, services: rankedServices }, null, 2);
        fs.writeFileSync(path.join(__dirname, 'pivot.json'), pivotJSON, 'utf8');
        
        console.log('[Build] summary.json, pivot.json 정적 빌드 성공.');
        
        // 3) 깃허브 자동 push 실행
        autoGitPush();
      });
    });
  });
}

function autoGitPush() {
  console.log('[Git] Cloudflare Pages 배포를 위해 깃허브 원격 연동 자동화 시작...');
  const cmd = 'git add summary.json pivot.json app.js index.html && git commit -m "auto: GDrive cost data sync update" && git push';
  
  exec(cmd, { cwd: __dirname }, (err, stdout, stderr) => {
    if (err) {
      console.error('[Git] 자동 푸시 실패:', err.message);
    } else {
      console.log('[Git] 푸시 성공! Cloudflare Pages 배포 파이프라인 작동 개시.');
    }
  });
}

// 서버 시작 시 기존에 감시 폴더 내에 존재하던 모든 CSV/XLSX 처리
async function scanAndProcessExistingFiles() {
  if (!fs.existsSync(WATCH_DIR)) {
    console.warn(`[경고] 구글 드라이브 감시 디렉토리가 존재하지 않습니다: ${WATCH_DIR}`);
    syncStatus.status = '구글드라이브 경로 미연결';
    return;
  }

  try {
    const files = fs.readdirSync(WATCH_DIR);
    const dataFiles = files.filter(f => {
      const ext = f.toLowerCase();
      return ext.endsWith('.csv') || ext.endsWith('.xlsx');
    });
    
    if (dataFiles.length === 0) {
      console.log('감시 폴더 내에 기존 CSV 또는 XLSX 파일이 없습니다.');
      return;
    }

    console.log(`기존 데이터 파일 ${dataFiles.length}개 발견. 순차 적재 시작...`);
    for (const file of dataFiles) {
      const fullPath = path.join(WATCH_DIR, file);
      try {
        await processFile(fullPath);
      } catch (err) {
        console.error(`[에러] 파일 처리 중 실패: ${file} - ${err.message}`);
      }
    }
    
    // 멱등적으로 모든 적재가 안전하게 끝난 뒤, 비동기 충돌 없이 단 한 번만 JSON 빌드 및 Git 자동 푸시를 수행합니다!
    console.log('[완료] 모든 기존 데이터 파일 적재 완료. 정적 JSON 빌드 작업을 실행합니다.');
    exportStaticJSON();
  } catch (err) {
    console.error('기존 파일 스캔 에러:', err.message);
  }
}

// ── Chokidar 구글 드라이브 실시간 폴더 감시 ──────────────────────────────
if (fs.existsSync(WATCH_DIR)) {
  console.log(`[감시 시작] 구글 드라이브 디렉토리 감시 중: ${WATCH_DIR}`);
  
  const watcher = chokidar.watch(WATCH_DIR, {
    ignored: /(^|[\/\\])\../,
    persistent: true,
    ignoreInitial: true,
    usePolling: true,
    interval: 2000,
    binaryInterval: 3000,
    awaitWriteFinish: {
      stabilityThreshold: 2000,
      pollInterval: 100
    }
  });

  watcher
    .on('add', (filePath) => {
      const ext = filePath.toLowerCase();
      if (ext.endsWith('.csv') || ext.endsWith('.xlsx')) {
        processFile(filePath)
          .then(() => {
            console.log(`[실시간 동기화] 신규 파일 적재 성공 -> 정적 JSON 빌드`);
            exportStaticJSON();
          })
          .catch((err) => console.error(`[실시간 동기화] 신규 파일 적재 실패:`, err.message));
      }
    })
    .on('change', (filePath) => {
      const ext = filePath.toLowerCase();
      if (ext.endsWith('.csv') || ext.endsWith('.xlsx')) {
        processFile(filePath)
          .then(() => {
            console.log(`[실시간 동기화] 파일 수정 반영 성공 -> 정적 JSON 빌드`);
            exportStaticJSON();
          })
          .catch((err) => console.error(`[실시간 동기화] 파일 수정 반영 실패:`, err.message));
      }
    })
    .on('error', (error) => {
      console.error(`Watcher 에러 발생:`, error.message);
    });
} else {
  console.warn(`[경고] 감시할 구글 드라이브 디렉토리가 마운트되지 않았습니다: ${WATCH_DIR}`);
}

// ── Express API 엔드포인트 ─────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json(syncStatus);
});

app.get('/api/costs/summary', (req, res) => {
  const query = `
    SELECT month, SUM(cost) as totalCost
    FROM costs
    GROUP BY month
    ORDER BY month ASC
  `;
  
  db.all(query, [], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    const grandTotal = rows.reduce((acc, row) => acc + row.totalCost, 0);
    res.json({ grandTotal, monthly: rows });
  });
});

app.get('/api/costs/pivot', (req, res) => {
  db.all('SELECT DISTINCT month FROM costs ORDER BY month ASC', [], (err, monthRows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    const months = monthRows.map(r => r.month);
    
    const pivotQuery = `
      SELECT service, month, SUM(cost) as cost
      FROM costs
      GROUP BY service, month
    `;
    
    db.all(pivotQuery, [], (err, dataRows) => {
      if (err) {
        return res.status(500).json({ error: err.message });
      }
      
      const pivot = {};
      const serviceTotals = {};
      
      dataRows.forEach(row => {
        const { service, month, cost } = row;
        if (!pivot[service]) {
          pivot[service] = {};
          serviceTotals[service] = 0;
        }
        pivot[service][month] = cost;
        serviceTotals[service] += cost;
      });
      
      const rankedServices = Object.keys(serviceTotals).map(name => ({
        name,
        totalCost: serviceTotals[name],
        monthlyCosts: months.reduce((acc, m) => {
          acc[m] = pivot[name][m] || 0;
          return acc;
        }, {})
      })).sort((a, b) => b.totalCost - a.totalCost);
      
      res.json({ months, services: rankedServices });
    });
  });
});

// 서버 기동
app.listen(PORT, () => {
  console.log(`=================================================`);
  console.log(`  CloudCost Pro 로컬 백엔드가 정상적으로 작동 중입니다.`);
  console.log(`  대시보드 주소: http://localhost:${PORT}`);
  console.log(`=================================================`);
});
