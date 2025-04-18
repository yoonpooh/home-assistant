const fs = require('fs');
const MqttClient = require('./mqttClient');
const Ew11Client = require('./ew11Client');
const CommandHandler = require('./commandHandler');
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
    // console.log('Loaded config from /data/options.json:', config);
} catch (err) {
    console.error('Failed to load /data/options.json, using defaults:', err);
    config = {};
}

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

const mqttClient = new MqttClient(brokerUrl, options, (topic, message) => {
    commandHandler.handleMessage(topic, message, mqttClient, ew11Client);
});

const ew11Client = new Ew11Client(HOST, PORT, (bytes) => {
    if (bytes[0] === 0xF9 || bytes[0] === 0xFA) {
        analyzeAndDiscoverOutlet(bytes, state.discoveredOutlets, mqttClient, () => saveState(state));
        commandHandler.handleAckOrState(bytes);
    }
    if (bytes[0] === 0xB0 || bytes[0] === 0xB1) {
        analyzeAndDiscoverLight(bytes, state.discoveredLights, mqttClient, () => saveState(state));
        commandHandler.handleAckOrState(bytes);
    }
    if (bytes[0] === 0x2A || bytes[0] === 0x80) {
        analyzeParkingAreaAndCarNumber(bytes, state.parkingState, mqttClient,() => saveState(state));
    }

    if (bytes[0] === 0x82 || bytes[0] === 0x84) {
        analyzeAndDiscoverTemperature(bytes, state.discoveredTemps, mqttClient, () => saveState(state));
        commandHandler.handleAckOrState(bytes);
    }

    if (bytes[0] === 0xF6 || bytes[0] === 0xF8) {
        analyzeAndDiscoverVentilation(bytes, state.discoveredFans , mqttClient, () => saveState(state));
        commandHandler.handleAckOrState(bytes);
    }

    // if (bytes[0] === 0xA2 || bytes[0] === 0x26) {
    //     analyzeAndDiscoverElevator(bytes, state.discoveredElevators , mqttClient, () => saveState(state));
    //     commandHandler.handleAckOrState(bytes);
    // }

    if (bytes[0] === 0xA0 || bytes[0] === 0xA2) {
        analyzeAndDiscoverMasterLight(bytes, state.discoveredMasterLights, mqttClient, () => saveState(state), state);
        // analyzeAndDiscoverElevator(bytes, state.discoveredElevators , mqttClient, () => saveState(state));
        commandHandler.handleAckOrState(bytes);
    }

    if (bytes[0] === 0xC8) {
        analyzeAndDiscoverAirQuality(bytes, state.discoveredSensors, mqttClient, () => saveState(state)); // saveState 제거
    }

    commandHandler.dequeueAndWrite(ew11Client.socket);
}, (command) => {
    commandHandler.safeWrite(command, ew11Client.socket);
});

// 패킷이 적게 올라오는 상황에는 아래 코드를 사용
// setInterval(() => {
//     commandHandler.dequeueAndWrite(ew11Client.socket);
// }, 50); // 50ms 단위 체크

(async () => {
    state = await loadState();

    process.on('SIGINT', async () => {
        await saveState(state);
        mqttClient.end();
        ew11Client.destroy();
        console.log('Connection closed');
        process.exit();
    });
})();