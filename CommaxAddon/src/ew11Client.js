const net = require('net');
const { log, logError } = require('./utils');

class Ew11Client {
    constructor(host, port, onDataCallback, safeWriteCallback) {
        this.host = host;
        this.port = port;
        this.onDataCallback = onDataCallback;
        this.safeWriteCallback = safeWriteCallback;
        this.knownHeaders = [
            0x78, 0xF8, 0x76, 0xF6,// FAN
            0x31, 0xB1, 0x30, 0xB0,// LIGHT
            0x22, 0xA2, 0x20, 0xA0,// MASTER LIGHT
            0x7A, 0xFA, 0x79, 0xF9,// OUTLET
            0x04, 0x84, 0x02, 0x82,// TEMP
            0x11, 0x91, 0x10, 0x90,// 가스차단기
            0x7F, // 생활정보기 날짜 시간 응답
            0x24, 0xA4, 0x25, // 주차위치 REQ
            0x2A, 0x80, 0xAA, // 주차위치 STAT
            0x47, 0x48, // 공기질 센서 REQ
            0xC8, // 공기질 센서 STAT
            0xF7, 0x77, // ?
            0x0F, 0x8F, // ?
        ];
        this.reconnectDelay = 5000; // 5 seconds
        this.maxRetryAttempts = 10;
        this.retryCount = 0;
        this.connectionTimeout = 10000; // 10 seconds
        this.isConnecting = false;
        this.lastDataTime = Date.now();
        this.dataTimeout = 5000; // 5 seconds with no data
        this.heartbeatInterval = null;
        this.connect();
    }

    connect() {
        if (this.isConnecting) return;
        this.isConnecting = true;

        const timeout = setTimeout(() => {
            console.error('EW11 connection timeout');
            this.socket.destroy();
        }, this.connectionTimeout);

        this.socket = net.connect(this.port, this.host, () => {
            clearTimeout(timeout);
            this.isConnecting = false;
            this.retryCount = 0;
            this.lastDataTime = Date.now();
            this.startHeartbeat();
            log('EW11에 연결되었습니다.');
        });

        this.socket.on('data', (data) => {
            this.lastDataTime = Date.now(); // Update last data time
            const bytes = data.toString('hex').match(/.{1,2}/g).map(byte => parseInt(byte, 16));
            if (bytes.length > 0 && !this.knownHeaders.includes(bytes[0])) {
                log(`<- ${data.toString('hex').match(/.{1,2}/g).join(' ').toUpperCase()}`);
            }
            this.onDataCallback(bytes);
        });

        this.socket.on('error', (err) => {
            logError('EW11 connection error:', err);
            this.stopHeartbeat();
            this.socket.destroy();
            this.handleReconnect();
        });

        this.socket.on('close', () => {
            log('EW11 connection closed');
            this.stopHeartbeat();
            this.isConnecting = false;
            this.handleReconnect();
        });
    }

    startHeartbeat() {
        if (this.heartbeatInterval) return;
        this.heartbeatInterval = setInterval(() => {
            const now = Date.now();
            if (now - this.lastDataTime > this.dataTimeout) {
                log('No data received for 5 seconds, triggering reconnect');
                this.socket.destroy();
            }
        }, 1000); // Check every second
    }

    stopHeartbeat() {
        if (this.heartbeatInterval) {
            clearInterval(this.heartbeatInterval);
            this.heartbeatInterval = null;
        }
    }

    handleReconnect() {
        if (this.retryCount >= this.maxRetryAttempts) {
            console.error('Max retry attempts reached. Stopping reconnection.');
            return;
        }

        this.retryCount++;
        log(`Attempting to reconnect (${this.retryCount}/${this.maxRetryAttempts}) in ${this.reconnectDelay}ms...`);

        setTimeout(() => {
            if (!this.isConnecting) {
                this.connect();
            }
        }, this.reconnectDelay);
    }

    write(command) {
        if (this.socket && !this.socket.destroyed) {
            this.safeWriteCallback(command);
        } else {
            console.warn('Socket is not connected. Command not sent.');
        }
    }

    destroy() {
        this.stopHeartbeat();
        this.socket.destroy();
        this.isConnecting = false;
        this.retryCount = this.maxRetryAttempts; // Prevent reconnection
    }
}

module.exports = Ew11Client;