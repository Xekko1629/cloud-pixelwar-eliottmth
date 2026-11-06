export const testProjectId = 'demo-pixelwar-test';

// Refuse missing or remote emulator endpoints before constructing any SDK client.
export function assertEmulatorEnvironment(
  environment: Record<string, string | undefined>,
): void {
  for (const key of ['FIRESTORE_EMULATOR_HOST', 'PUBSUB_EMULATOR_HOST']) {
    const endpoint = environment[key];
    if (!endpoint || !/^(127\.0\.0\.1|localhost):\d+$/.test(endpoint)) {
      throw new Error(`${key} must point to a local emulator (host:port)`);
    }
  }

  for (const key of ['GCLOUD_PROJECT', 'GOOGLE_CLOUD_PROJECT']) {
    if (environment[key] && environment[key] !== testProjectId) {
      throw new Error(`${key} must be ${testProjectId}`);
    }
  }
}
