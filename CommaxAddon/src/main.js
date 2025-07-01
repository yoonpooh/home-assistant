const fs = require('fs');
const MqttClient = require('./mqttClient');
const Ew11Client = require('./ew11Client');
const CommandHandler = require('./commandHandler');
const {log, logError} = require('./utils');
const {
    analyzeAndDiscoverTemperature,
    analyzeAndDiscoverOutlet,
    analyzeAndDiscoverLight,
    analyzeParkingAreaAndCarNumber,
    analyzeAndDiscoverVentilation,
    analyzeAndDiscoverElevator,
    analyzeAndDiscoverMasterLight,
    analyzeAndDiscoverAirQuality,
    analyzeAndDiscoverMetering
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

// 원격 검침용 두번째 EW11
const HOST_2 = config.ew11_metering_host || '';
const PORT_2 = parseInt(config.ew11_metering_port) || 8899;

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

        if (bytes[0] === 0xB0 || bytes[0] === 0xB1 || bytes[0] === 0x1E) {
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
    },
    state,
    mqttClient,
    setControlDevicesAvailable,
    setControlDevicesUnavailable
);

if (HOST_2 !== '') {
    // 실시간 검침용 별도의 RS-485 연결된 EW11 이 있으면
    const ew22Client = new Ew11Client(HOST_2, PORT_2, (bytes) => {
            if (bytes[0] === 0xF7) {
                analyzeAndDiscoverMetering(bytes, state.discoveredMeters, mqttClient, () => saveState(state))
            }
        }, (command) => {
            commandHandler.safeWrite(command, ew22Client.socket);
        },
        state,
        mqttClient,
        setControlDevicesAvailable,
        setControlDevicesUnavailable
    );
}


// MQTT 퍼블리싱을 Promise로 래핑
function publishAsync(mqttClient, topic, message, options) {
    return new Promise((resolve, reject) => {
        mqttClient.publish(topic, message, options, (err) => {
            if (err) {
                logError(`Failed to publish to ${topic}:`, err);
                reject(err);
            } else {
                // log(`Published ${message} to ${topic}`);
                resolve();
            }
        });
    });
}

// 제어 디바이스 및 센서를 사용 가능 상태로 설정하는 함수
async function setControlDevicesAvailable(state, mqttClient) {
    if (!state || !mqttClient) {
        logError('Cannot set devices available: state or mqttClient is missing');
        return;
    }

    const topicPrefix = config.mqtt_topic_prefix || 'devcommax';
    log('Setting control devices and sensors to available');

    const publishPromises = [];

    // 콘센트 (outlets)
    state.discoveredOutlets.forEach(uniqueId => {
        const deviceId = uniqueId.replace('commax_outlet_', '');
        publishPromises.push(
            publishAsync(mqttClient, `${topicPrefix}/outlet/${deviceId}/availability`, 'available', {
                retain: true,
                qos: 1
            }),
            publishAsync(mqttClient, `${topicPrefix}/outlet/${deviceId}/standby_mode/availability`, 'available', {
                retain: true,
                qos: 1
            }),
            publishAsync(mqttClient, `${topicPrefix}/outlet/${deviceId}/standby_power/availability`, 'available', {
                retain: true,
                qos: 1
            }),
            publishAsync(mqttClient, `${topicPrefix}/outlet/${deviceId}/current_power/availability`, 'available', {
                retain: true,
                qos: 1
            })
        );
    });

    // 조명 (lights)
    state.discoveredLights.forEach(uniqueId => {
        const deviceId = uniqueId.replace('commax_light_', '');
        publishPromises.push(
            publishAsync(mqttClient, `${topicPrefix}/light/${deviceId}/availability`, 'available', {
                retain: true,
                qos: 1
            })
        );
    });

    // 온도 조절기 (temperature)
    state.discoveredTemps.forEach(uniqueId => {
        const deviceId = uniqueId.replace('commax_temp_', '');
        publishPromises.push(
            publishAsync(mqttClient, `${topicPrefix}/temp/${deviceId}/availability`, 'available', {
                retain: true,
                qos: 1
            })
        );
    });

    // 환기 (fans)
    state.discoveredFans.forEach(uniqueId => {
        const deviceId = uniqueId.replace('commax_fan_', '');
        publishPromises.push(
            publishAsync(mqttClient, `${topicPrefix}/fan/${deviceId}/availability`, 'available', {retain: true, qos: 1})
        );
    });

    // 일괄소등 (master lights)
    state.discoveredMasterLights.forEach(uniqueId => {
        publishPromises.push(
            publishAsync(mqttClient, `${topicPrefix}/master_light/availability`, 'available', {retain: true, qos: 1})
        );
    });

    // 엘레베이터 (elevator)
    state.discoveredElevators.forEach(uniqueId => {
        const deviceId = uniqueId.replace('commax_elevator_', '');
        publishPromises.push(
            publishAsync(mqttClient, `${topicPrefix}/elevator/${deviceId}/availability`, 'available', {
                retain: true,
                qos: 1
            })
        );
    });

    // 주차 위치 센서
    if (state.parkingState.parkingDiscovered) {
        publishPromises.push(
            publishAsync(mqttClient, `${topicPrefix}/parking/area/availability`, 'available', {retain: true, qos: 1})
        );
    }

    // 차량 번호 센서
    if (state.parkingState.carNumberDiscovered) {
        publishPromises.push(
            publishAsync(mqttClient, `${topicPrefix}/parking/car_number/availability`, 'available', {
                retain: true,
                qos: 1
            })
        );
    }

    // 공기질 센서 (CO2, PM2.5, PM10)
    if (state.discoveredSensors.size > 0) {
        const airQualitySensors = [
            {topic: `${topicPrefix}/air_quality/co2/availability`, name: 'CO2'},
            {topic: `${topicPrefix}/air_quality/pm2_5/availability`, name: 'PM2.5'},
            {topic: `${topicPrefix}/air_quality/pm10/availability`, name: 'PM10'}
        ];
        airQualitySensors.forEach(sensor => {
            publishPromises.push(
                publishAsync(mqttClient, sensor.topic, 'available', {retain: true, qos: 1})
            );
        });
    }

    // 스마트 미터링 센서
    if (state.discoveredMeters.size > 0) {
        const sensors = [
            `${topicPrefix}/smart_metering/water_meter/availability`,
            `${topicPrefix}/smart_metering/water_acc_meter/availability`,
            `${topicPrefix}/smart_metering/electric_meter/availability`,
            `${topicPrefix}/smart_metering/electric_acc_meter/availability`,
            `${topicPrefix}/smart_metering/warm_meter/availability`,
            `${topicPrefix}/smart_metering/warm_acc_meter/availability`,
            `${topicPrefix}/smart_metering/heat_meter/availability`,
            `${topicPrefix}/smart_metering/heat_acc_meter/availability`,
        ];
        sensors.forEach(topic => {
            publishPromises.push(
                publishAsync(mqttClient, topic, 'available', {retain: true, qos: 1})
            );
        });
    }

    await Promise.all(publishPromises);
}

// 제어 디바이스 및 센서를 사용 불가 상태로 설정하는 함수
async function setControlDevicesUnavailable(state, mqttClient) {
    if (!state || !mqttClient) {
        logError('Cannot set devices unavailable: state or mqttClient is missing');
        return;
    }

    const topicPrefix = config.mqtt_topic_prefix || 'devcommax';
    log('Setting control devices and sensors to unavailable');

    const publishPromises = [];

    // 콘센트 (outlets)
    state.discoveredOutlets.forEach(uniqueId => {
        const deviceId = uniqueId.replace('commax_outlet_', '');
        publishPromises.push(
            publishAsync(mqttClient, `${topicPrefix}/outlet/${deviceId}/availability`, 'unavailable', {
                retain: true,
                qos: 1
            }),
            publishAsync(mqttClient, `${topicPrefix}/outlet/${deviceId}/standby_mode/availability`, 'unavailable', {
                retain: true,
                qos: 1
            }),
            publishAsync(mqttClient, `${topicPrefix}/outlet/${deviceId}/standby_power/availability`, 'unavailable', {
                retain: true,
                qos: 1
            }),
            publishAsync(mqttClient, `${topicPrefix}/outlet/${deviceId}/current_power/availability`, 'unavailable', {
                retain: true,
                qos: 1
            })
        );
    });

    // 조명 (lights)
    state.discoveredLights.forEach(uniqueId => {
        const deviceId = uniqueId.replace('commax_light_', '');
        publishPromises.push(
            publishAsync(mqttClient, `${topicPrefix}/light/${deviceId}/availability`, 'unavailable', {
                retain: true,
                qos: 1
            })
        );
    });

    // 온도 조절기 (temperature)
    state.discoveredTemps.forEach(uniqueId => {
        const deviceId = uniqueId.replace('commax_temp_', '');
        publishPromises.push(
            publishAsync(mqttClient, `${topicPrefix}/temp/${deviceId}/availability`, 'unavailable', {
                retain: true,
                qos: 1
            })
        );
    });

    // 환기 (fans)
    state.discoveredFans.forEach(uniqueId => {
        const deviceId = uniqueId.replace('commax_fan_', '');
        publishPromises.push(
            publishAsync(mqttClient, `${topicPrefix}/fan/${deviceId}/availability`, 'unavailable', {
                retain: true,
                qos: 1
            })
        );
    });

    // 일괄소등 (master lights)
    state.discoveredMasterLights.forEach(uniqueId => {
        publishPromises.push(
            publishAsync(mqttClient, `${topicPrefix}/master_light/availability`, 'unavailable', {retain: true, qos: 1})
        );
    });

    // 엘레베이터 (elevator)
    state.discoveredElevators.forEach(uniqueId => {
        const deviceId = uniqueId.replace('commax_elevator_', '');
        publishPromises.push(
            publishAsync(mqttClient, `${topicPrefix}/elevator/${deviceId}/availability`, 'unavailable', {
                retain: true,
                qos: 1
            })
        );
    });

    // 주차 위치 센서
    if (state.parkingState.parkingDiscovered) {
        publishPromises.push(
            publishAsync(mqttClient, `${topicPrefix}/parking/area/availability`, 'unavailable', {retain: true, qos: 1})
        );
    }

    // 차량 번호 센서
    if (state.parkingState.carNumberDiscovered) {
        publishPromises.push(
            publishAsync(mqttClient, `${topicPrefix}/parking/car_number/availability`, 'unavailable', {
                retain: true,
                qos: 1
            })
        );
    }

    // 공기질 센서 (CO2, PM2.5, PM10)
    if (state.discoveredSensors.size > 0) {
        const airQualitySensors = [
            {topic: `${topicPrefix}/air_quality/co2/availability`, name: 'CO2'},
            {topic: `${topicPrefix}/air_quality/pm2_5/availability`, name: 'PM2.5'},
            {topic: `${topicPrefix}/air_quality/pm10/availability`, name: 'PM10'}
        ];
        airQualitySensors.forEach(sensor => {
            publishPromises.push(
                publishAsync(mqttClient, sensor.topic, 'unavailable', {retain: true, qos: 1})
            );
        });
    }

    if (state.discoveredMeters.size > 0) {
        const sensors = [
            `${topicPrefix}/smart_metering/water_meter/availability`,
            `${topicPrefix}/smart_metering/water_acc_meter/availability`,
            `${topicPrefix}/smart_metering/electric_meter/availability`,
            `${topicPrefix}/smart_metering/electric_acc_meter/availability`,
            `${topicPrefix}/smart_metering/warm_meter/availability`,
            `${topicPrefix}/smart_metering/warm_acc_meter/availability`,
            `${topicPrefix}/smart_metering/heat_meter/availability`,
            `${topicPrefix}/smart_metering/heat_acc_meter/availability`,
        ];
        sensors.forEach(topic => {
            publishPromises.push(
                publishAsync(mqttClient, topic, 'unavailable', {retain: true, qos: 1})
            );
        });
    }

    await Promise.all(publishPromises);
}


(async () => {
    state = await loadState();

    // 애드온 시작 시 모든 제어 디바이스를 사용 가능으로 설정
    await setControlDevicesAvailable(state, mqttClient);

    process.on('SIGINT', async () => {
        try {
            // 모든 MQTT 메시지 발행 완료 대기
            await setControlDevicesUnavailable(state, mqttClient);

            if (intervalTimer) {
                clearInterval(intervalTimer); // 타이머 정리
            }
            await saveState(state);

            mqttClient.end();
            ew11Client.destroy();
            log('Connection closed');
            process.exit();
        } catch (err) {
            logError('Error during shutdown:', err);
            process.exit(1);
        }
    });
})();