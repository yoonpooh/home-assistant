const fs = require('fs');
const MqttClient = require('./mqttClient');
const Ew11Client = require('./ew11Client');
const CommandHandler = require('./commandHandler');
const { log, logError } = require('./utils');
const {
    analyzeAndDiscoverTemperature,
    analyzeAndDiscoverOutlet,
    analyzeAndDiscoverLight,
    analyzeParkingAreaAndCarNumber,
    analyzeAndDiscoverVentilation,
    analyzeAndDiscoverElevator,
    analyzeAndDiscoverMasterLight,
    analyzeAndDiscoverAirQuality
} = require('./deviceParser');
const {loadState, saveState} = require('./stateManager');

// 설정값 로드
let config;
try {
    const optionsData = fs.readFileSync('/data/options.json', 'utf8');
    config = JSON.parse(optionsData);
} catch (err) {
    logError('Failed to load /data/options.json, using defaults:', err);
    config = {};
}

log("애드온을 시작합니다.");

const MQTT_TOPIC_PREFIX = config.mqtt_topic_prefix || 'devcommax';
const brokerUrl = config.mqtt_broker_url || '192.168.0.34';
const options = {
    port: parseInt(config.mqtt_port) || 1883,
    clientId: 'mqtt_client_' + Math.random().toString(16).substr(2, 8),
    username: config.mqtt_username || 'dev',
    password: config.mqtt_password || 'password',
};
const HOST = config.ew11_host || '192.168.0.37';
const PORT = parseInt(config.ew11_port) || 8899;

let state;

const commandHandler = new CommandHandler();

// 데이터 수신 간격 추적을 위한 변수
let lastReceiveTime = null;
let intervals = []; // 간격 저장 배열
const INTERVAL_WINDOW = 10 * 1000; // 10초
let windowStartTime = null;
const THRESHOLD_INTERVAL = 100; // 평균 간격 임계값 (ms)
let intervalTimer = null; // setInterval 타이머 참조
let hasChecked = false; // 최초 1회 검사 플래그

const mqttClient = new MqttClient(brokerUrl, options, (topic, message) => {
    commandHandler.handleMessage(topic, message, mqttClient, ew11Client);
});

const ew11Client = new Ew11Client(HOST, PORT, (bytes) => {
    // 현재 시간 기록
    const currentTime = Date.now();

    // 최초 검사 전이고 윈도우 시작 시간이 없으면 초기화
    if (!hasChecked && windowStartTime === null) {
        windowStartTime = currentTime;
        log("10초 동안 패킷 수신 간격을 수집합니다.");
    }

    // 간격 계산
    if (!hasChecked && lastReceiveTime !== null) {
        const interval = currentTime - lastReceiveTime;
        intervals.push(interval);
    }

    // 마지막 수신 시간 업데이트
    lastReceiveTime = currentTime;

    // 10초 경과 여부 확인 및 최초 검사
    if (!hasChecked && currentTime - windowStartTime >= INTERVAL_WINDOW) {
        if (intervals.length > 0) {
            const averageInterval = intervals.reduce((sum, val) => sum + val, 0) / intervals.length;
            log(`10초 패킷 수신 간격 평균: ${averageInterval.toFixed(2)}ms`);

            // 평균 간격이 임계값 이상인 경우 setInterval 실행
            if (averageInterval >= THRESHOLD_INTERVAL && !intervalTimer) {
                log(`10초 패킷 수신 간격 평균 <= ${THRESHOLD_INTERVAL}ms. 50ms 단위로 이벤트 루프 시작.`);
                intervalTimer = setInterval(() => {
                    commandHandler.dequeueAndWrite(ew11Client.socket);
                }, 50); // 50ms 단위 체크
            }
        } else {
            log('10초 동안 패킷이 수신되지 않았습니다. EW11 의 연결 상태를 확인하세요.');
        }

        // 최초 검사 완료
        hasChecked = true;
        intervals = []; // 메모리 절약을 위해 배열 초기화
        windowStartTime = null; // 더 이상 사용하지 않음
    }

    // 기존 데이터 처리 로직
    if (bytes[0] === 0xF9 || bytes[0] === 0xFA) {
        analyzeAndDiscoverOutlet(bytes, state.discoveredOutlets, mqttClient, () => saveState(state));
        commandHandler.handleAckOrState(bytes);
    }
    if (bytes[0] === 0xB0 || bytes[0] === 0xB1) {
        analyzeAndDiscoverLight(bytes, state.discoveredLights, mqttClient, () => saveState(state));
        commandHandler.handleAckOrState(bytes);
    }
    if (bytes[0] === 0x2A || bytes[0] === 0x80) {
        analyzeParkingAreaAndCarNumber(bytes, state.parkingState, mqttClient, () => saveState(state));
    }
    if (bytes[0] === 0x82 || bytes[0] === 0x84) {
        analyzeAndDiscoverTemperature(bytes, state.discoveredTemps, mqttClient, () => saveState(state));
        commandHandler.handleAckOrState(bytes);
    }
    if (bytes[0] === 0xF6 || bytes[0] === 0xF8) {
        analyzeAndDiscoverVentilation(bytes, state.discoveredFans, mqttClient, () => saveState(state));
        commandHandler.handleAckOrState(bytes);
    }

    // if (bytes[0] === 0xA2 || bytes[0] === 0x26) {
    //     analyzeAndDiscoverElevator(bytes, state.discoveredElevators , mqttClient, () => saveState(state));
    //     commandHandler.handleAckOrState(bytes);
    // }

    if (bytes[0] === 0xA0 || bytes[0] === 0xA2) {
        analyzeAndDiscoverMasterLight(bytes, state.discoveredMasterLights, mqttClient, () => saveState(state), state);
        commandHandler.handleAckOrState(bytes);
    }
    if (bytes[0] === 0xC8) {
        analyzeAndDiscoverAirQuality(bytes, state.discoveredSensors, mqttClient, () => saveState(state));
    }

    commandHandler.dequeueAndWrite(ew11Client.socket);
}, (command) => {
    commandHandler.safeWrite(command, ew11Client.socket);
});

(async () => {
    state = await loadState();

    process.on('SIGINT', async () => {
        if (intervalTimer) {
            clearInterval(intervalTimer); // 타이머 정리
        }
        await saveState(state);
        mqttClient.end();
        ew11Client.destroy();
        log('Connection closed');
        process.exit();
    });
})();