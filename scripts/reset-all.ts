import { spawnSync } from 'child_process';
import * as path from 'path';

async function runScript(scriptName: string, args: string[] = []): Promise<void> {
  const tsNode = path.resolve(process.cwd(), 'node_modules/.bin/ts-node');
  const scriptPath = path.resolve(process.cwd(), 'scripts', scriptName);
  
  console.log(`\n========================================`);
  console.log(`>>> Running: scripts/${scriptName}`);
  console.log(`========================================`);

  const result = spawnSync('npx', ['ts-node', '-r', 'tsconfig-paths/register', scriptPath, ...args], {
    stdio: 'inherit',
    shell: true,
  });

  if (result.status !== 0) {
    throw new Error(`Script ${scriptName} exited with code ${result.status}`);
  }
}

async function main() {
  console.log('\n--- STARTING TOTAL SYSTEM CLEANUP ---');
  
  // 1. Clean Database
  await runScript('clean-database.ts');

  // 2. Clean MinIO storage
  await runScript('clean-storage.ts');

  // 3. Clear BullMQ queues and Redis cooldowns
  await runScript('clear-queues.ts');

  console.log('\n======================================================');
  console.log(' TOTAL CLEANUP COMPLETE:');
  console.log(' - Postgres: Scraped tables truncated');
  console.log(' - MinIO: All media files deleted');
  console.log(' - Redis: BullMQ queues drained & anti-bot locks cleared');
  console.log('======================================================\n');
}

main().catch((err) => {
  console.error('\nCleanup failed:', err);
  process.exit(1);
});
