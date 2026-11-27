export const snapshotSubscription = 'projects/demo-pixelwar-test/subscriptions/snapshot-worker';
export const snapshotReadySubscription = 'projects/demo-pixelwar-test/subscriptions/snapshot-notifier';
export const snapshotsBucket = 'demo-pixelwar-test-snapshots';

/** Native OBJECT_FINALIZE notification of Cloud Storage (JSON_API_V1), as pushed by Pub/Sub. */
export function finalizePush(objectId: string, changes: Record<string, unknown> = {}) {
  return {
    subscription: snapshotReadySubscription,
    message: {
      messageId: '789', data: Buffer.from(JSON.stringify({ name: objectId, bucket: snapshotsBucket })).toString('base64'),
      attributes: {
        eventType: 'OBJECT_FINALIZE', payloadFormat: 'JSON_API_V1', bucketId: snapshotsBucket,
        objectId, objectGeneration: '1764158400000000', notificationConfig: 'projects/_/buckets/b/notificationConfigs/1', ...changes,
      },
    },
  };
}
