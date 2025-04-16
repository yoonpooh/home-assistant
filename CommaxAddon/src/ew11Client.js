// ew11Client.js
const net = require('net');
const {getTimestamp} = require('./deviceParser');

class Ew11Client {
    constructor(host, port, onDataCallback, safeWriteCallback) {
        this.host = host;
        this.port = port;
        this.onDataCallback = onDataCallback;
        this.safeWriteCallback = safeWriteCallback;
         // CMD , ACK , REQ , STAT
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
        this.connect();
    }

    connect() {
        this.socket = net.connect(this.port, this.host, () => {
            console.log('EW11에 연결되었습니다.');
        });

        this.socket.on('data', (data) => {
            const bytes = data.toString('hex').match(/.{1,2}/g).map(byte => parseInt(byte, 16));
            // 알려지지 않은 패킷 로그에 남김
            if (bytes.length > 0 && !this.knownHeaders.includes(bytes[0])) {
                console.log(`${getTimestamp()} <- ${data.toString('hex').match(/.{1,2}/g).join(' ').toUpperCase()}`);
            }

            this.onDataCallback(bytes);
        });

        this.socket.on('error', (err) => {
            console.error('EW11 connection error:', err);
            this.socket.destroy();
        });

        this.socket.on('close', () => {
            console.log('EW11 connection closed');
        });
    }

    write(command) {
        this.safeWriteCallback(command);
    }

    destroy() {
        this.socket.destroy();
    }
}

module.exports = Ew11Client;