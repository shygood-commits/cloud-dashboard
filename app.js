/* ==========================================
   NovaCloud Dashboard Interaction Logic
   ========================================== */

// 1. Core State Management
const state = {
    metrics: {
        cpu: 24,
        memory: 58,
        disk: 41.8,
        network: 328
    },
    chartData: {
        maxPoints: 20,
        ingress: Array(20).fill(120),
        egress: Array(20).fill(160)
    },
    instances: {
        'inst-1': { name: 'Web-Server-01', status: 'RUNNING', ip: '13.125.4.110', region: 'ap-northeast-2', cpu: 18 },
        'inst-2': { name: 'Database-Main', status: 'RUNNING', ip: '54.180.12.87', region: 'ap-northeast-2', cpu: 35 },
        'inst-3': { name: 'API-Gateway-Dev', status: 'STOPPED', ip: '3.35.210.42', region: 'us-east-1', cpu: 0 }
    }
};

// 2. Initialize Dashboard
document.addEventListener('DOMContentLoaded', () => {
    // Generate initial randomized chart data
    for (let i = 0; i < state.chartData.maxPoints; i++) {
        state.chartData.ingress[i] = getRandomValue(80, 180);
        state.chartData.egress[i] = getRandomValue(100, 210);
    }
    
    // Draw initial chart
    updateChart();
    
    // Start real-time simulations
    startRealTimeUpdates();
    
    // Bind Event Listeners
    setupEventListeners();
    
    addConsoleLog('SYSTEM', 'NovaCloud 인프라 실시간 동기화 활성화됨.', 'success');
});

// Helper: Get random integer
function getRandomValue(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// 3. Event Listeners Setup
function setupEventListeners() {
    // Refresh Button
    const refreshBtn = document.getElementById('btn-refresh-data');
    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => {
            const icon = refreshBtn.querySelector('i');
            if (icon) icon.style.transform = 'rotate(360deg)';
            
            // Random shake of metrics
            state.metrics.cpu = getRandomValue(10, 85);
            state.metrics.memory = getRandomValue(40, 90);
            state.metrics.network = getRandomValue(100, 950);
            
            updateMetricsUI();
            addConsoleLog('USER', '사용자에 의한 전체 메트릭 수동 동기화 요청.', 'warning');
            
            setTimeout(() => {
                if (icon) icon.style.transform = 'none';
            }, 600);
        });
    }
    
    // Clear Logs Button
    const clearLogsBtn = document.getElementById('btn-clear-logs');
    if (clearLogsBtn) {
        clearLogsBtn.addEventListener('click', () => {
            const logsBody = document.getElementById('console-logs');
            if (logsBody) {
                logsBody.innerHTML = '';
                addConsoleLog('SYSTEM', '로그 터미널이 초기화되었습니다.', 'system');
            }
        });
    }
}

// 4. Real-time Metric & Chart Simulator
function startRealTimeUpdates() {
    // 1.5 Seconds loop for subtle CPU/RAM fluctuations
    setInterval(() => {
        // Subtle changes
        state.metrics.cpu = Math.max(5, Math.min(98, state.metrics.cpu + getRandomValue(-8, 8)));
        state.metrics.memory = Math.max(20, Math.min(95, state.metrics.memory + getRandomValue(-3, 3)));
        state.metrics.network = Math.max(50, Math.min(1000, state.metrics.network + getRandomValue(-40, 40)));
        
        // Dynamic Server CPU Usage simulator (if RUNNING)
        Object.keys(state.instances).forEach(id => {
            const inst = state.instances[id];
            if (inst.status === 'RUNNING') {
                inst.cpu = Math.max(5, Math.min(95, inst.cpu + getRandomValue(-6, 6)));
                const cpuTd = document.getElementById(`cpu-${id}`);
                if (cpuTd) cpuTd.textContent = `${inst.cpu}%`;
            }
        });
        
        updateMetricsUI();
    }, 1500);
    
    // 2.0 Seconds loop for Traffic Graph Flow
    setInterval(() => {
        // Shift chart array data to left
        state.chartData.ingress.shift();
        state.chartData.ingress.push(getRandomValue(80, 190));
        
        state.chartData.egress.shift();
        state.chartData.egress.push(getRandomValue(100, 220));
        
        updateChart();
    }, 2000);
}

// 5. Update Metrics UI Elements
function updateMetricsUI() {
    // CPU
    document.getElementById('val-cpu').textContent = `${state.metrics.cpu}%`;
    document.getElementById('progress-cpu').style.width = `${state.metrics.cpu}%`;
    
    // Memory
    document.getElementById('val-memory').textContent = `${state.metrics.memory}%`;
    document.getElementById('progress-memory').style.width = `${state.metrics.memory}%`;
    
    // Network
    document.getElementById('val-network').textContent = `${state.metrics.network} Mb/s`;
    // Scale 1000Mb/s to 100% width
    const netPercentage = Math.min(100, (state.metrics.network / 1000) * 100);
    document.getElementById('progress-network').style.width = `${netPercentage}%`;
}

// 6. Draw custom smooth SVG charts
function updateChart() {
    const svgWidth = 800;
    const svgHeight = 250;
    const padding = 15;
    
    const count = state.chartData.maxPoints;
    const step = svgWidth / (count - 1);
    
    // Map data values to SVG Coordinates (Y goes 0 to 250 from top)
    const getCoordinates = (arr) => {
        return arr.map((val, idx) => {
            const x = idx * step;
            // Map val (e.g. 0 to 250) to graph coordinate where max value is near top (padding)
            const y = svgHeight - val - padding;
            return { x, y };
        });
    };
    
    const ingressCoords = getCoordinates(state.chartData.ingress);
    const egressCoords = getCoordinates(state.chartData.egress);
    
    // Helper to generate bezier curves command
    const solveBezierPath = (coords) => {
        if (coords.length === 0) return '';
        let d = `M ${coords[0].x} ${coords[0].y}`;
        
        for (let i = 0; i < coords.length - 1; i++) {
            const cpX1 = coords[i].x + step / 2;
            const cpY1 = coords[i].y;
            const cpX2 = coords[i + 1].x - step / 2;
            const cpY2 = coords[i + 1].y;
            d += ` C ${cpX1} ${cpY1}, ${cpX2} ${cpY2}, ${coords[i + 1].x} ${coords[i + 1].y}`;
        }
        return d;
    };
    
    // Ingress Line & Area Path
    const ingressPathD = solveBezierPath(ingressCoords);
    document.getElementById('path-ingress').setAttribute('d', ingressPathD);
    
    const ingressAreaD = `${ingressPathD} L ${svgWidth} ${svgHeight} L 0 ${svgHeight} Z`;
    document.getElementById('area-ingress').setAttribute('d', ingressAreaD);
    
    // Egress Line & Area Path
    const egressPathD = solveBezierPath(egressCoords);
    document.getElementById('path-egress').setAttribute('d', egressPathD);
    
    const egressAreaD = `${egressPathD} L ${svgWidth} ${svgHeight} L 0 ${svgHeight} Z`;
    document.getElementById('area-egress').setAttribute('d', egressAreaD);
}

// 7. Dynamic Log Generator
function addConsoleLog(tag, text, type = 'system') {
    const logsBody = document.getElementById('console-logs');
    if (!logsBody) return;
    
    const now = new Date();
    const timeStr = `[${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}:${now.getSeconds().toString().padStart(2, '0')}]`;
    
    const logLine = document.createElement('div');
    logLine.className = `log-line ${type}-log`;
    
    logLine.innerHTML = `
        <span class="log-time">${timeStr}</span>
        <span class="log-tag">[${tag.toUpperCase()}]</span>
        <span class="log-text">${text}</span>
    `;
    
    logsBody.appendChild(logLine);
    
    // Auto Scroll to bottom
    logsBody.scrollTop = logsBody.scrollHeight;
}

// 8. Server Control Operations (Async simulated toggle)
window.toggleServer = function(id, action) {
    const inst = state.instances[id];
    if (!inst) return;
    
    const badge = document.getElementById(`status-${id}`);
    const row = document.getElementById(`row-${id}`);
    const cpuTd = document.getElementById(`cpu-${id}`);
    const actionCell = row.querySelector('td:last-child');
    
    if (action === 'stop') {
        addConsoleLog('ACTION', `${inst.name} 중지 명령 수신...`, 'warning');
        
        // Transitioning state UI update
        badge.className = 'status-badge transitioning';
        badge.textContent = 'STOPPING';
        disableRowButtons(row, true);
        
        setTimeout(() => {
            inst.status = 'STOPPED';
            inst.cpu = 0;
            
            badge.className = 'status-badge stopped';
            badge.textContent = 'STOPPED';
            cpuTd.textContent = '0%';
            
            // Swap icons in name
            const icon = row.querySelector('.instance-name-td i');
            if (icon) icon.className = 'stopped-server-icon';
            
            // Rebuild Buttons for STOPPED status
            actionCell.innerHTML = `
                <div class="action-btn-group">
                    <button class="btn-action start" onclick="toggleServer('${id}', 'start')"><i data-lucide="play"></i> 시작</button>
                    <button class="btn-action restart" onclick="toggleServer('${id}', 'restart')" disabled><i data-lucide="refresh-cw"></i> 재부팅</button>
                </div>
            `;
            lucide.createIcons();
            
            addConsoleLog('SYSTEM', `${inst.name} 중지 완료 (STOPPED). 모든 트래픽 연결이 끊김.`, 'error');
        }, 2000);
        
    } else if (action === 'start') {
        addConsoleLog('ACTION', `${inst.name} 가동 준비 중...`, 'system');
        
        badge.className = 'status-badge transitioning';
        badge.textContent = 'STARTING';
        disableRowButtons(row, true);
        
        setTimeout(() => {
            inst.status = 'RUNNING';
            inst.cpu = getRandomValue(10, 30);
            
            badge.className = 'status-badge running';
            badge.textContent = 'RUNNING';
            cpuTd.textContent = `${inst.cpu}%`;
            
            const icon = row.querySelector('.instance-name-td i');
            if (icon) icon.className = 'active-server-icon';
            
            actionCell.innerHTML = `
                <div class="action-btn-group">
                    <button class="btn-action stop" onclick="toggleServer('${id}', 'stop')"><i data-lucide="square"></i> 정지</button>
                    <button class="btn-action restart" onclick="toggleServer('${id}', 'restart')"><i data-lucide="refresh-cw"></i> 재부팅</button>
                </div>
            `;
            lucide.createIcons();
            
            addConsoleLog('SYSTEM', `${inst.name} 부팅 성공 (RUNNING). 리포팅 에이전트 연동 완료.`, 'success');
        }, 2000);
        
    } else if (action === 'restart') {
        addConsoleLog('ACTION', `${inst.name} 재부팅 수행...`, 'warning');
        
        badge.className = 'status-badge transitioning';
        badge.textContent = 'REBOOTING';
        disableRowButtons(row, true);
        
        setTimeout(() => {
            inst.cpu = getRandomValue(15, 45);
            badge.className = 'status-badge running';
            badge.textContent = 'RUNNING';
            cpuTd.textContent = `${inst.cpu}%`;
            
            disableRowButtons(row, false);
            addConsoleLog('SYSTEM', `${inst.name} 웜 리부트(Warm Reboot) 신호 수신 및 복구 성공.`, 'success');
        }, 2500);
    }
};

// Helper: disable/enable buttons during action transitions
function disableRowButtons(row, disable) {
    const buttons = row.querySelectorAll('.btn-action');
    buttons.forEach(btn => {
        btn.disabled = disable;
    });
}
