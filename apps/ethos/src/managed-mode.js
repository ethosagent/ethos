import { readConfig } from './config';
import { setRotationConfig } from './error-log';
import { getSecretsResolver, getStorage } from './wiring';
export async function loadRequiredConfig() {
    const secrets = await getSecretsResolver();
    const config = await readConfig(getStorage(), secrets);
    if (config) {
        if (config.logs?.rotation) {
            setRotationConfig(config.logs.rotation);
        }
        return config;
    }
    if (process.env.ETHOS_MANAGED === '1') {
        console.error('ethos: managed mode (ETHOS_MANAGED=1); no ~/.ethos/config.yaml found.\n' +
            '       Bootstrap the config externally (e.g. Clawrium playbook) and retry.');
        process.exit(2);
    }
    console.error('Run ethos setup first.');
    process.exit(1);
}
