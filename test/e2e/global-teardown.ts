import { stopServices } from './helpers/docker';

export default async function globalTeardown() {
  console.log('\n🧹 E2E Test Suite - Global Teardown\n');

  try {
    await stopServices();
    console.log('✅ Services stopped\n');
  } catch (error) {
    console.error('❌ Failed to stop services:', error);
    throw error;
  }
}
