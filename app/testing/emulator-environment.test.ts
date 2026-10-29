import { describe, expect, it } from 'vitest';
import { assertEmulatorEnvironment, testProjectId } from './emulator-environment';

const localEnvironment = {
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:8085',
  PUBSUB_EMULATOR_HOST: 'localhost:8086',
};

describe('emulator safety guard', () => {
  it('accepts local endpoints and the dedicated demo project', () => {
    expect(() => assertEmulatorEnvironment(localEnvironment)).not.toThrow();
    expect(() => assertEmulatorEnvironment({
      ...localEnvironment,
      GCLOUD_PROJECT: testProjectId,
      GOOGLE_CLOUD_PROJECT: testProjectId,
    })).not.toThrow();
  });

  it.each(['FIRESTORE_EMULATOR_HOST', 'PUBSUB_EMULATOR_HOST'])('rejects an absent %s', (key) => {
    expect(() => assertEmulatorEnvironment({ ...localEnvironment, [key]: undefined })).toThrow(key);
  });

  it.each(['cloud.example:8080', 'https://localhost:8085', 'localhost', ''])('rejects non-local or malformed endpoints: %s', (endpoint) => {
    expect(() => assertEmulatorEnvironment({ ...localEnvironment, FIRESTORE_EMULATOR_HOST: endpoint })).toThrow();
  });

  it.each(['GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT'])('rejects a non-test %s', (key) => {
    expect(() => assertEmulatorEnvironment({ ...localEnvironment, [key]: 'cloud-pixelwar-prod' })).toThrow(key);
  });
});
