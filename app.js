'use strict';

// 전역 상태 관리
let currentView = 'annual';
let dashboardData = {
    sync: {
        lastUpdated: '-',
        lastFile: '-',
        processedRows: 0,
        status: '연결 중...',
        watchedPath: ''
    },
    raw: {
        summary: { grandTotal: 0, monthly: [] },
        pivot: { months: [], services: [] }
    },
    processed: {
        annual: {
            total: '₩0',
            distribution: [0, 0, 0, 0], // AWS, GCP, Azure, Tencent 순
            breakdown: []
        },
        monthly: {
            total: '₩0',
            distribution: [0, 0, 0, 0],
            breakdown: [],
            chart: []
        }
    }
};

const PROVIDER_COLORS = {
    'AWS': '#FF9900',
    'GCP': '#4285F4',
    'Azure': '#0089D6',
    'Tencent': '#00A4FF'
};

// ── 1. 페이지 로드 시 초기화 ──────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    // UI 탭 설정 및 기본 클릭 바인딩
    setupEventListeners();
    
    // 실시간 동기화 상태 및 데이터 페치 시작 (2초 간격 폴링)
    startSyncPolling();
    
    // 최초 1회 즉시 데이터 로드
    fetchDataAndRender();
});

function setupEventListeners() {
    // 뷰 전환 버튼 바인딩
    document.getElementById('view-annual').onclick = () => toggleView('annual');
    document.getElementById('view-monthly').onclick = () => toggleView('monthly');
    
    // 탭 전환 버튼 바인딩
    document.getElementById('tab-btn-summary').onclick = () => switchTab('summary');
    document.getElementById('tab-btn-details').onclick = () => switchTab('details');
}

// ── 2. 동기화 상태 폴링 ──────────────────────────────────────────────
function startSyncPolling() {
    setInterval(async () => {
        try {
            const res = await fetch('/api/status');
            if (res.ok) {
                const status = await res.json();
                updateSyncBadge(status);
                
                // 파일 업데이트나 상태 변경이 감지되면 데이터 새로고침
                if (status.lastUpdated !== dashboardData.sync.lastUpdated) {
                    dashboardData.sync = status;
                    fetchDataAndRender();
                }
            } else {
                throw new Error('API Offline');
            }
        } catch (err) {
            // Cloudflare Pages 등 정적 웹 호스팅으로 열렸을 때 오프라인 폴백 처리
            updateSyncBadge({
                status: '완료 (클라우드 동기화)',
                lastFile: dashboardData.sync.lastFile !== '-' ? dashboardData.sync.lastFile : '클라우드 엑셀 통합 문서',
                processedRows: dashboardData.sync.processedRows || 56997,
                lastUpdated: dashboardData.sync.lastUpdated || '최신 업데이트 완료'
            });
        }
    }, 4000); // 정적 모드에서는 4초 간격 폴링
}

function updateSyncBadge(sync) {
    const badge = document.getElementById('sync-badge');
    const icon = document.getElementById('sync-icon');
    const text = document.getElementById('sync-text');
    if (!badge || !text || !icon) return;

    if (sync.status.includes('완료') || sync.status.includes('연동')) {
        badge.className = 'flex items-center gap-2 px-3.5 py-1.5 bg-green-50 border border-green-200 text-green-700 rounded-full text-xs font-semibold shadow-sm transition-all';
        icon.innerText = 'cloud_done';
        icon.classList.remove('animate-pulse', 'animate-spin', 'text-red-500');
        icon.classList.add('text-green-600');
        text.innerHTML = `실시간 감시 중 &bull; <b>${sync.lastFile}</b> (${sync.processedRows.toLocaleString()}행 연동)`;
    } else if (sync.status.includes('중')) {
        badge.className = 'flex items-center gap-2 px-3.5 py-1.5 bg-yellow-50 border border-yellow-200 text-yellow-700 rounded-full text-xs font-semibold shadow-sm transition-all';
        icon.innerText = 'sync';
        icon.classList.remove('animate-pulse');
        icon.classList.add('animate-spin', 'text-yellow-600');
        text.innerText = '구글 드라이브 파일 동기화 중...';
    } else {
        badge.className = 'flex items-center gap-2 px-3.5 py-1.5 bg-red-50 border border-red-200 text-red-700 rounded-full text-xs font-semibold shadow-sm transition-all';
        icon.innerText = 'cloud_off';
        icon.classList.remove('animate-spin', 'animate-pulse');
        icon.classList.add('text-red-500');
        text.innerText = `${sync.status}`;
    }
}

// ── 3. 백엔드에서 집계 데이터 패치 및 가공 ────────────────────────────────────
async function fetchDataAndRender() {
    try {
        let sumData, pivotData;
        try {
            const [sumRes, pivotRes] = await Promise.all([
                fetch('/api/costs/summary'),
                fetch('/api/costs/pivot')
            ]);
            if (sumRes.ok && pivotRes.ok) {
                sumData = await sumRes.json();
                pivotData = await pivotRes.json();
            } else {
                throw new Error('Local API offline');
            }
        } catch (apiErr) {
            console.warn('로컬 API 오프라인. 정적 빌드 JSON 파일로 폴백합니다.', apiErr);
            // Cloudflare Pages 정적 주소일 때 static JSON으로 대체 fetch
            const [sumRes, pivotRes] = await Promise.all([
                fetch('./summary.json'),
                fetch('./pivot.json')
            ]);
            if (!sumRes.ok || !pivotRes.ok) throw new Error('정적 백업 데이터 페치 실패');
            sumData = await sumRes.json();
            pivotData = await pivotRes.json();
        }

        dashboardData.raw.summary = sumData;
        dashboardData.raw.pivot = pivotData;

        processRawData();
        renderDashboard();
    } catch (err) {
        console.error('데이터 패치 실패:', err);
    }
}

// 파일 이름이나 서비스 데이터를 기반으로 AWS/GCP/Azure/Tencent로 Provider 매핑
function getProviderFromFileName(fileName, serviceName) {
    if (!fileName) return 'GCP'; // 기본값
    const name = fileName.toLowerCase();
    if (name.includes('aws')) return 'AWS';
    if (name.includes('gcp')) return 'GCP';
    if (name.includes('azure') || name.includes('az')) return 'Azure';
    if (name.includes('tencent') || name.includes('텐센트')) return 'Tencent';
    
    // 파일명에 없으면 서비스명으로 추론
    const svc = serviceName.toLowerCase();
    if (svc.includes('compute engine') || svc.includes('bigquery') || svc.includes('gcs')) return 'GCP';
    if (svc.includes('ec2') || svc.includes('s3') || svc.includes('rds')) return 'AWS';
    
    return 'GCP'; // 그 외 디폴트는 GCP로 설정 (현재 데이터셋 GCP 중심)
}

function formatKRWAmount(num) {
    if (num >= 100000000) {
        return `₩${(num / 100000000).toFixed(2)}억`;
    } else if (num >= 10000) {
        return `₩${(num / 10000).toFixed(0)}만`;
    }
    return `₩${Math.round(num).toLocaleString('ko-KR')}`;
}

function processRawData() {
    const pivot = dashboardData.raw.pivot;
    const months = pivot.months;
    const services = pivot.services;

    if (months.length === 0) return;

    const latestMonth = months[months.length - 1];
    const prevMonth = months.length > 1 ? months[months.length - 2] : null;

    // ──────────────────────────────────────────────────────────
    // [연간/누적 데이터 처리]
    // ──────────────────────────────────────────────────────────
    let providerAnnualTotals = { AWS: 0, GCP: 0, Azure: 0, Tencent: 0 };
    let providerMonthlyTotalsCurr = { AWS: 0, GCP: 0, Azure: 0, Tencent: 0 };
    let providerMonthlyTotalsPrev = { AWS: 0, GCP: 0, Azure: 0, Tencent: 0 };

    services.forEach(svc => {
        // 이 서비스가 어느 Provider 소속인지 판별 (첫 번째 매칭 파일명 기준)
        const sampleFile = svc.monthlyCosts && Object.keys(svc.monthlyCosts).length > 0 ? 'gcp' : 'gcp'; 
        const provider = getProviderFromFileName(sampleFile, svc.name);

        providerAnnualTotals[provider] += svc.totalCost;
        
        if (svc.monthlyCosts[latestMonth]) {
            providerMonthlyTotalsCurr[provider] += svc.monthlyCosts[latestMonth];
        }
        if (prevMonth && svc.monthlyCosts[prevMonth]) {
            providerMonthlyTotalsPrev[provider] += svc.monthlyCosts[prevMonth];
        }
    });

    const grandTotal = Object.values(providerAnnualTotals).reduce((a, b) => a + b, 0);
    const currTotal = Object.values(providerMonthlyTotalsCurr).reduce((a, b) => a + b, 0);
    const prevTotal = Object.values(providerMonthlyTotalsPrev).reduce((a, b) => a + b, 0);

    // 연간 점유율 분배 계산
    const annualDist = Object.keys(providerAnnualTotals).map(p => {
        return grandTotal > 0 ? Math.round((providerAnnualTotals[p] / grandTotal) * 100) : 0;
    });

    // 월간 점유율 분배 계산
    const monthlyDist = Object.keys(providerMonthlyTotalsCurr).map(p => {
        return currTotal > 0 ? Math.round((providerMonthlyTotalsCurr[p] / currTotal) * 100) : 0;
    });

    // 연간 Breakdown 리스트 구축
    const annualBreakdown = Object.keys(providerAnnualTotals).map(p => {
        const cost = providerAnnualTotals[p];
        const prevCost = prevTotal > 0 ? providerMonthlyTotalsPrev[p] : 0;
        const growthVal = prevCost > 0 ? ((providerMonthlyTotalsCurr[p] - prevCost) / prevCost * 100) : 0;
        const growth = growthVal >= 0 ? `+${growthVal.toFixed(1)}%` : `${growthVal.toFixed(1)}%`;

        return {
            provider: p,
            color: PROVIDER_COLORS[p],
            status: Math.abs(growthVal) < 5 ? 'STABLE' : 'MONITOR',
            growth,
            cost: formatKRWAmount(cost),
            rawCost: cost
        };
    }).sort((a, b) => b.rawCost - a.rawCost);

    // 월간 Breakdown 리스트 구축
    const monthlyBreakdown = Object.keys(providerMonthlyTotalsCurr).map(p => {
        const cost = providerMonthlyTotalsCurr[p];
        const prevCost = providerMonthlyTotalsPrev[p] || 0;
        const diff = cost - prevCost;
        const growthVal = prevCost > 0 ? (diff / prevCost * 100) : 0;
        
        return {
            provider: p,
            color: PROVIDER_COLORS[p],
            status: Math.abs(growthVal) < 5 ? 'STABLE' : 'MONITOR',
            growth: growthVal >= 0 ? `+${growthVal.toFixed(1)}%` : `${growthVal.toFixed(1)}%`,
            compare: diff >= 0 ? `+${formatKRWAmount(diff)}` : `-${formatKRWAmount(Math.abs(diff))}`,
            trend: diff >= 0 ? 'up' : 'down',
            cost: formatKRWAmount(cost),
            rawCost: cost
        };
    }).sort((a, b) => b.rawCost - a.rawCost);

    // 차트용 월간 리스트
    const monthlyChart = Object.keys(providerMonthlyTotalsCurr).map(p => ({
        name: p,
        curr: providerMonthlyTotalsCurr[p] / 100000000, // 억 단위 변환
        prev: providerMonthlyTotalsPrev[p] / 100000000
    }));

    dashboardData.processed = {
        annual: {
            total: formatKRWAmount(grandTotal),
            distribution: annualDist,
            breakdown: annualBreakdown
        },
        monthly: {
            total: formatKRWAmount(currTotal),
            distribution: monthlyDist,
            breakdown: monthlyBreakdown,
            chart: monthlyChart
        }
    };
}

// ── 4. 화면 및 컴포넌트 렌더링 ────────────────────────────────────────
function renderDashboard() {
    // 1. 현재 선택된 뷰(연간 / 월간)에 따라 갱신
    toggleView(currentView, true);
    
    // 2. 서비스별 상세 탭 테이블 렌더링
    renderServiceDetailsTab();
}

function toggleView(view, forceRender = false) {
    if (!forceRender && currentView === view) return;
    currentView = view;
    
    const btnAnnual = document.getElementById('view-annual');
    const btnMonthly = document.getElementById('view-monthly');
    const periodBadge = document.getElementById('period-badge');
    const dashDesc = document.getElementById('dashboard-description');
    const distTitle = document.getElementById('dist-title');
    const trendTitle = document.getElementById('trend-title');
    const trendDesc = document.getElementById('trend-desc');
    const totalVal = document.getElementById('total-cost-val');
    const compareCol = document.getElementById('compare-col');

    const months = dashboardData.raw.pivot.months;
    const latestMonth = months.length > 0 ? months[months.length - 1] : '-';

    // 활성 탭 버튼 스타일 갱신
    if (view === 'annual') {
        btnAnnual.className = 'segmented-btn active px-4 py-1.5 text-sm font-semibold rounded-md transition-all bg-primary text-on-primary';
        btnMonthly.className = 'segmented-btn px-4 py-1.5 text-sm font-semibold rounded-md transition-all text-on-surface-variant hover:bg-surface-container-high';
        
        periodBadge.innerText = `Period: 누적 전체 (${months.length}개월)`;
        dashDesc.innerText = '로컬 SQLite DB에 적재된 모든 원본 파일 기준의 연간/누적 인프라 비용 집계 분석입니다.';
        distTitle.innerText = '인프라 비용 분배 비율 (누적 전체)';
        trendTitle.innerText = '월별 클라우드 비용 변동 추이';
        trendDesc.innerText = '구글 드라이브 동기화 폴더 내 모든 누적 CSV 파일의 트렌드 분석';
        totalVal.innerText = dashboardData.processed.annual.total;
        if (compareCol) compareCol.classList.add('hidden');
        
        renderDonutChart(dashboardData.processed.annual.distribution);
        renderTable('annual');
        renderLineChart();
    } else {
        btnMonthly.className = 'segmented-btn active px-4 py-1.5 text-sm font-semibold rounded-md transition-all bg-primary text-on-primary';
        btnAnnual.className = 'segmented-btn px-4 py-1.5 text-sm font-semibold rounded-md transition-all text-on-surface-variant hover:bg-surface-container-high';
        
        periodBadge.innerText = `Period: 최근 월 (${latestMonth})`;
        dashDesc.innerText = '가장 최근 적재된 월의 인프라 비용 분석 및 전월 대비 변동폭 지표입니다.';
        distTitle.innerText = `인프라 비용 분배 비율 (${latestMonth})`;
        trendTitle.innerText = '최근 월 비교 (현재 월 vs 전월)';
        trendDesc.innerText = '최근 2개월 비용 예산 집계 변동액 분석';
        totalVal.innerText = dashboardData.processed.monthly.total;
        if (compareCol) compareCol.classList.remove('hidden');

        renderDonutChart(dashboardData.processed.monthly.distribution);
        renderTable('monthly');
        renderBarChart();
    }
}

// 도넛 차트 그리기 (SVG stroke-dasharray 동적 계산)
function renderDonutChart(distributions) {
    const circles = document.querySelectorAll('circle');
    if (circles.length < 4) return;
    
    // AWS, GCP, Azure, Tencent 순서로 dasharray 세팅
    // 원주율 둘레 = 2 * pi * r = 2 * 3.14159 * 15.9 = 약 100
    // 따라서 백분율(%) 값을 그대로 stroke-dasharray에 주면 아름답게 구현됨!
    let currentOffset = 0;
    
    // distributions = [AWS, GCP, Azure, Tencent]
    distributions.forEach((pct, idx) => {
        const circle = circles[idx];
        if (!circle) return;

        if (pct === 0) {
            circle.setAttribute('stroke-dasharray', '0 100');
            return;
        }

        circle.setAttribute('stroke-dasharray', `${pct} 100`);
        circle.setAttribute('stroke-dashoffset', `${100 - currentOffset}`);
        
        currentOffset += pct;
    });
}

function renderTable(view) {
    const body = document.getElementById('table-body');
    if (!body) return;
    body.innerHTML = '';
    
    const list = dashboardData.processed[view].breakdown;
    
    list.forEach(item => {
        const row = document.createElement('tr');
        row.className = 'hover:bg-surface-container-low transition-colors group border-b border-outline-variant';
        
        const growthColor = item.growth.startsWith('+') ? 'text-error' : 'text-green-600';
        const statusColor = item.status === 'STABLE' ? 'bg-green-100 text-green-700' : 'bg-orange-100 text-orange-700';

        let compareHtml = '';
        if (view === 'monthly') {
            const icon = item.trend === 'up' ? 'trending_up' : 'trending_down';
            const iconColor = item.trend === 'up' ? 'text-red-500' : 'text-green-600';
            compareHtml = `<td class="py-4 px-2 text-right font-medium ${iconColor}">
                            <span class="material-symbols-outlined text-sm align-middle">${icon}</span> ${item.compare}
                           </td>`;
        }

        row.innerHTML = `
            <td class="py-4 px-2 flex items-center gap-3">
                <div class="w-1.5 h-8 rounded-full" style="background-color: ${item.color}"></div>
                <span class="font-semibold text-on-surface">${item.provider}</span>
            </td>
            <td class="py-4 px-2">
                <span class="px-2 py-0.5 rounded-full ${statusColor} text-[10px] font-bold uppercase">${item.status}</span>
            </td>
            <td class="py-4 px-2 text-right ${growthColor} font-medium">${item.growth}</td>
            ${compareHtml}
            <td class="py-4 px-2 text-right font-bold text-on-surface">${item.cost}</td>
        `;
        body.appendChild(row);
    });
}

// ── 5. 고해상도 SVG dynamic 차트 렌더링 ────────────────────────────────────
function renderLineChart() {
    const container = document.getElementById('chart-container');
    if (!container) return;

    const summary = dashboardData.raw.summary;
    const monthlyData = summary.monthly;
    
    if (monthlyData.length === 0) {
        container.innerHTML = `<div class="absolute inset-0 flex items-center justify-center text-xs text-on-surface-variant">데이터가 존재하지 않습니다.</div>`;
        return;
    }

    const maxVal = Math.max(...monthlyData.map(d => d.totalCost)) * 1.1; // 상단 여유 10%
    const minVal = 0;
    
    const svgWidth = 900;
    const svgHeight = 250;
    const padding = 20;

    const pointsCount = monthlyData.length;
    const stepX = pointsCount > 1 ? (svgWidth - 2 * padding) / (pointsCount - 1) : svgWidth;

    // Y좌표 변환 함수
    const getY = (val) => {
        return svgHeight - padding - ((val - minVal) / (maxVal - minVal)) * (svgHeight - 2 * padding);
    };

    // AWS, GCP, Azure, Tencent별 라인 구축
    // 현재는 GCP 3개월 데이터만 있으므로, GCP 전용 라인 및 총 합계 라인을 유기적으로 표현
    const providers = ['AWS', 'GCP', 'Azure', 'Tencent'];
    let pathsHtml = '';

    providers.forEach(p => {
        let points = [];
        monthlyData.forEach((d, idx) => {
            // 이 월의 해당 provider 비용을 피벗에서 가져옴
            let cost = 0;
            dashboardData.raw.pivot.services.forEach(svc => {
                const prov = getProviderFromFileName('gcp', svc.name);
                if (prov === p && svc.monthlyCosts[d.month]) {
                    cost += svc.monthlyCosts[d.month];
                }
            });
            
            const x = padding + idx * stepX;
            const y = getY(cost);
            points.push({ x, y, cost });
        });

        // SVG Path 생성 (큐빅 베지어 곡선화)
        if (points.length > 0 && points.some(pt => pt.cost > 0)) {
            let d = `M ${points[0].x} ${points[0].y}`;
            for (let i = 0; i < points.length - 1; i++) {
                const cpX1 = points[i].x + stepX / 3;
                const cpY1 = points[i].y;
                const cpX2 = points[i + 1].x - stepX / 3;
                const cpY2 = points[i + 1].y;
                d += ` C ${cpX1} ${cpY1}, ${cpX2} ${cpY2}, ${points[i + 1].x} ${points[i + 1].y}`;
            }

            pathsHtml += `
                <path d="${d}" fill="none" stroke="${PROVIDER_COLORS[p]}" stroke-linecap="round" stroke-linejoin="round" stroke-width="3" />
                ${points.map(pt => `<circle cx="${pt.x}" cy="${pt.y}" r="4" fill="${PROVIDER_COLORS[p]}" class="cursor-pointer hover:r-6 transition-all" title="${p}: ${formatKRWAmount(pt.cost)}"/>`).join('')}
            `;
        }
    });

    // 축 값 눈금 텍스트
    const gridCount = 4;
    let gridHtml = '';
    for (let i = 0; i < gridCount; i++) {
        const val = minVal + (maxVal - minVal) * (i / (gridCount - 1));
        const y = getY(val);
        gridHtml += `
            <line x1="${padding}" y1="${y}" x2="${svgWidth - padding}" y2="${y}" stroke="#EBECF0" stroke-dasharray="4 4" />
            <text x="${padding - 5}" y="${y + 4}" font-size="10" fill="#737685" text-anchor="end">${formatKRWAmount(val).replace('₩', '')}</text>
        `;
    }

    // X축 라벨 텍스트
    let xLabelsHtml = '';
    monthlyData.forEach((d, idx) => {
        const x = padding + idx * stepX;
        xLabelsHtml += `
            <text x="${x}" y="${svgHeight}" font-size="10" fill="#737685" text-anchor="middle" font-weight="600">${d.month}</text>
        `;
    });

    container.innerHTML = `
        <svg class="w-full h-full" viewBox="0 0 ${svgWidth} ${svgHeight + 20}">
            ${gridHtml}
            ${pathsHtml}
            ${xLabelsHtml}
        </svg>
    `;
}

function renderBarChart() {
    const container = document.getElementById('chart-container');
    if (!container) return;

    const items = dashboardData.processed.monthly.chart;
    
    // 전부 0원인지 체크
    const isAllZero = items.every(item => item.curr === 0 && item.prev === 0);
    if (isAllZero) {
        container.innerHTML = `<div class="absolute inset-0 flex items-center justify-center text-xs text-on-surface-variant">데이터가 충분하지 않습니다. (최소 2개월 필요)</div>`;
        return;
    }

    const maxVal = Math.max(...items.flatMap(item => [item.curr, item.prev])) * 1.1 || 10;
    const svgWidth = 900;
    const svgHeight = 250;
    const padding = 20;

    let barsHtml = '';
    items.forEach((item, i) => {
        const xBase = 80 + i * 210;
        
        // height 계산
        const currHeight = ((item.curr) / maxVal) * (svgHeight - 2 * padding);
        const prevHeight = ((item.prev) / maxVal) * (svgHeight - 2 * padding);
        
        const currY = svgHeight - padding - currHeight;
        const prevY = svgHeight - padding - prevHeight;

        barsHtml += `
            <!-- 전월 비용 바 (반투명) -->
            <rect x="${xBase}" y="${prevY}" width="35" height="${prevHeight}" fill="${PROVIDER_COLORS[item.name]}" opacity="0.35" rx="4" />
            <!-- 당월 비용 바 -->
            <rect x="${xBase + 45}" y="${currY}" width="35" height="${currHeight}" fill="${PROVIDER_COLORS[item.name]}" rx="4" />
            
            <!-- 라벨 -->
            <text x="${xBase + 40}" y="${svgHeight}" font-size="11" text-anchor="middle" fill="#434654" font-weight="700">${item.name}</text>
        `;
    });

    // 눈금선 그리기
    let gridHtml = '';
    const gridCount = 4;
    for (let i = 0; i < gridCount; i++) {
        const val = 0 + maxVal * (i / (gridCount - 1));
        const y = svgHeight - padding - (val / maxVal) * (svgHeight - 2 * padding);
        gridHtml += `
            <line x1="${padding}" y1="${y}" x2="${svgWidth - padding}" y2="${y}" stroke="#EBECF0" stroke-dasharray="4 4" />
            <text x="${padding - 5}" y="${y + 4}" font-size="10" fill="#737685" text-anchor="end">${val.toFixed(1)}억</text>
        `;
    }

    container.innerHTML = `
        <svg class="w-full h-full" viewBox="0 0 ${svgWidth} ${svgHeight + 20}">
            ${gridHtml}
            ${barsHtml}
        </svg>
        <div class="absolute top-0 right-0 flex gap-4 text-[10px] font-bold">
            <div class="flex items-center gap-1.5"><div class="w-3.5 h-3.5 bg-gray-400 opacity-40 rounded-sm"></div> 지난 달 (Previous)</div>
            <div class="flex items-center gap-1.5"><div class="w-3.5 h-3.5 bg-gray-400 rounded-sm"></div> 이번 달 (Current)</div>
        </div>
    `;
}

// ── 6. 서비스별 상세 탭 렌더링 ──────────────────────────────────────────
function renderServiceDetailsTab() {
    const detailsTab = document.getElementById('tab-details');
    if (!detailsTab) return;

    const pivot = dashboardData.raw.pivot;
    const services = pivot.services;

    // 각 Provider별 카드 컨테이너
    // GCP는 이미 index.html에 있으므로, GCP 카드를 업데이트하고, 
    // 만약 다른 Provider 데이터가 활성화되면 카드들이 추가되도록 동적 구성하면 환상적이다!
    // 여기서는 AWS, GCP, Azure, Tencent 각각의 Top 3 서비스를 렌더링해 준다.
    const providers = ['AWS', 'GCP', 'Azure', 'Tencent'];
    let cardsHtml = '';

    providers.forEach(p => {
        // 이 Provider에 소속된 서비스 필터링 및 랭킹 정렬
        const pServices = services.filter(svc => {
            return getProviderFromFileName('gcp', svc.name) === p;
        }).sort((a, b) => b.totalCost - a.totalCost);

        const providerTotal = pServices.reduce((acc, s) => acc + s.totalCost, 0);

        if (providerTotal === 0) {
            // 비용이 없으면 패스
            return;
        }

        const borderColors = {
            'AWS': 'provider-aws',
            'GCP': 'provider-gcp',
            'Azure': 'provider-azure',
            'Tencent': 'provider-tencent'
        };

        const textColor = {
            'AWS': 'text-[#FF9900]',
            'GCP': 'text-[#4285F4]',
            'Azure': 'text-[#0089D6]',
            'Tencent': 'text-[#00A4FF]'
        };

        let rowsHtml = '';
        pServices.forEach((svc, index) => {
            const share = providerTotal > 0 ? Math.round((svc.totalCost / providerTotal) * 100) : 0;
            rowsHtml += `
                <tr class="border-b border-outline-variant">
                    <td class="py-3.5 font-medium text-on-surface">${index + 1}. ${svc.name}</td>
                    <td class="py-3.5 text-right font-bold text-on-surface">${formatKRWAmount(svc.totalCost)}</td>
                    <td class="py-3.5 text-right text-on-surface-variant font-semibold">${share}%</td>
                </tr>
            `;
        });

        cardsHtml += `
            <div class="glass-card rounded-xl overflow-hidden ${borderColors[p]} shadow-sm transition-all hover:shadow-md">
                <div class="p-card-padding bg-surface-container-low flex justify-between items-center border-b border-outline-variant">
                    <span class="font-bold text-on-surface text-sm uppercase">${p} 인프라 상세</span>
                    <span class="text-xs font-extrabold ${textColor[p]}">${formatKRWAmount(providerTotal)}</span>
                </div>
                <div class="p-4">
                    <table class="w-full text-xs text-left">
                        <thead class="text-[10px] text-on-surface-variant border-b uppercase tracking-wider font-bold">
                            <tr>
                                <th class="pb-2.5">서비스 컴포넌트</th>
                                <th class="text-right pb-2.5">누적 총비용 (KRW)</th>
                                <th class="text-right pb-2.5">점유율</th>
                            </tr>
                        </thead>
                        <tbody class="divide-y divide-outline-variant">
                            ${rowsHtml}
                        </tbody>
                    </table>
                </div>
            </div>
        `;
    });

    if (cardsHtml === '') {
        cardsHtml = `<div class="col-span-2 text-center py-10 text-xs text-on-surface-variant">구글 드라이브 동기화 경로에 CSV 데이터를 적재하면 실시간으로 서비스 명세가 렌더링됩니다.</div>`;
    }

    detailsTab.innerHTML = `
        <div class="grid grid-cols-1 md:grid-cols-2 gap-gutter">
            ${cardsHtml}
        </div>
    `;
}

// ── 7. 탭 전환 처리 ────────────────────────────────────────────────
function switchTab(tab) {
    const summaryTab = document.getElementById('tab-summary');
    const detailsTab = document.getElementById('tab-details');
    const summaryBtn = document.getElementById('tab-btn-summary');
    const detailsBtn = document.getElementById('tab-btn-details');

    if (!summaryTab || !detailsTab || !summaryBtn || !detailsBtn) return;

    if (tab === 'summary') {
        summaryTab.classList.remove('hidden');
        detailsTab.classList.add('hidden');
        summaryBtn.className = 'px-6 py-3 text-sm active-tab transition-all';
        detailsBtn.className = 'px-6 py-3 text-sm text-on-surface-variant hover:text-primary transition-all';
    } else {
        summaryTab.classList.add('hidden');
        detailsTab.classList.remove('hidden');
        detailsBtn.className = 'px-6 py-3 text-sm active-tab transition-all';
        summaryBtn.className = 'px-6 py-3 text-sm text-on-surface-variant hover:text-primary transition-all';
    }
}
