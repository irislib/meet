import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const appDir = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const options = { routes: [], domains: [], wranglerVersion: '4' };
  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--script') options.script = args.shift();
    else if (arg === '--assets') options.assets = args.shift();
    else if (arg === '--name') options.name = args.shift();
    else if (arg === '--compatibility-date') options.compatibilityDate = args.shift();
    else if (arg === '--wrangler-version') options.wranglerVersion = args.shift();
    else if (arg === '--route') options.routes.push(args.shift());
    else if (arg === '--domain') options.domains.push(args.shift());
    else throw new Error(`Unknown argument: ${arg}`);
  }
  for (const key of ['script', 'assets', 'name', 'compatibilityDate']) {
    if (!options[key]) throw new Error(`Missing required option: --${key.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`)}`);
  }
  return options;
}

function configFor(options) {
  return {
    name: options.name,
    compatibility_date: options.compatibilityDate,
    main: path.relative(appDir, path.resolve(appDir, options.script)),
    assets: {
      directory: path.relative(appDir, path.resolve(appDir, options.assets)),
      binding: 'ASSETS',
      run_worker_first: true,
    },
  };
}

function run(command, args, cwd) {
  console.log(`$ ${[command, ...args].join(' ')}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (signal) reject(new Error(`deploy interrupted by ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const configPath = path.join(appDir, `.wrangler-assets-${process.pid}-${Date.now()}.json`);
  try {
    await writeFile(configPath, `${JSON.stringify(configFor(options), null, 2)}\n`);
    const command = ['deploy', '--config', configPath, '--keep-vars'];
    for (const route of options.routes) command.push('--route', route);
    for (const domain of options.domains) command.push('--domain', domain);
    const status = await run('npx', [`wrangler@${options.wranglerVersion}`, ...command], appDir);
    if (status !== 0) process.exitCode = status;
  } finally {
    await rm(configPath, { force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
