import { assertEmulatorEnvironment, testProjectId } from './emulator-environment';

assertEmulatorEnvironment(process.env);
process.env.GCLOUD_PROJECT = testProjectId;
process.env.GOOGLE_CLOUD_PROJECT = testProjectId;
