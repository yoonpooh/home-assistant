const mqtt = require('mqtt');
const { log, logError } = require('./utils');

class MqttClient {
    constructor(brokerUrl, options, onMessageCallback) {
        this.client = mqtt.connect('mqtt://'+brokerUrl, options);
        this.onMessageCallback = onMessageCallback;
        this.topicPrefix = process.env.MQTT_TOPIC_PREFIX || 'devcommax';
        this.setupListeners();
    }

    setupListeners() {
        this.client.on('connect', async () => {
            log('MQTT 연결되었습니다.');
            this.client.subscribe(`${this.topicPrefix}/#`, (err) => {
                if (!err) log(`MQTT 토픽 구독 : ${this.topicPrefix}/#`);
            });
        });

        this.client.on('message', (topic, message) => {
            this.onMessageCallback(topic, message);
        });

        this.client.on('error', (err) => {
            console.error('MQTT 오류:', err.message);
        });
    }

    publish(topic, message, options = {}, callback) {
        this.client.publish(topic, message, options, callback);
    }

    end() {
        this.client.end();
    }
}

module.exports = MqttClient;