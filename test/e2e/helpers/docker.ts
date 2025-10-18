import { execSync } from 'child_process';
import path from 'path';

const COMPOSE_FILE = path.join(__dirname, '../docker-compose.e2e.yml');

export { waitForRedis } from './wait-for-services';

export async function startServices(): Promise<void> {
  console.log('🐳 Starting E2E test services...');

  try {
    execSync(`docker compose -f ${COMPOSE_FILE} up -d`, { stdio: 'inherit' });
    console.log('✅ Services started');
  } catch (error) {
    console.error('❌ Failed to start services:', error);
    throw error;
  }
}

export async function stopServices(): Promise<void> {
  console.log('🛑 Stopping E2E test services...');

  try {
    execSync(`docker compose -f ${COMPOSE_FILE} down -v`, { stdio: 'inherit' });
    console.log('✅ Services stopped');
  } catch (error) {
    console.error('❌ Failed to stop services:', error);
  }
}

export async function restartRedis(): Promise<void> {
  console.log('🔄 Restarting Redis...');

  try {
    execSync(`docker compose -f ${COMPOSE_FILE} restart redis-e2e`, { stdio: 'pipe' });
    console.log('✅ Redis restarted');
  } catch (error) {
    console.error('❌ Failed to restart Redis:', error);
    throw error;
  }
}

export async function stopRedis(): Promise<void> {
  console.log('⏸️  Stopping Redis...');

  try {
    execSync(`docker compose -f ${COMPOSE_FILE} stop redis-e2e`, { stdio: 'pipe' });
    console.log('✅ Redis stopped');
  } catch (error) {
    console.error('❌ Failed to stop Redis:', error);
    throw error;
  }
}

export async function startRedis(): Promise<void> {
  console.log('▶️  Starting Redis...');

  try {
    execSync(`docker compose -f ${COMPOSE_FILE} start redis-e2e`, { stdio: 'pipe' });
    console.log('✅ Redis started');
  } catch (error) {
    console.error('❌ Failed to start Redis:', error);
    throw error;
  }
}

export async function getContainerStatus(containerName: string): Promise<string> {
  try {
    const status = execSync(`docker inspect -f '{{.State.Status}}' ${containerName}`, {
      encoding: 'utf-8',
    }).trim();
    return status;
  } catch {
    return 'not-found';
  }
}
