import { readFileSync } from 'fs';
import { join } from 'path';

// Load .env.test file for integration tests
try {
  const envPath = join(__dirname, '../../.env.test');
  const envFile = readFileSync(envPath, 'utf8');

  envFile.split('\n').forEach((line) => {
    // Skip comments and empty lines
    if (line.trim() === '' || line.trim().startsWith('#')) {
      return;
    }

    const [key, ...valueParts] = line.split('=');
    const value = valueParts.join('=').trim();

    if (key && value) {
      process.env[key.trim()] = value;
    }
  });
} catch (error) {
  console.warn('Warning: .env.test file not found. Using default environment variables.');
}
