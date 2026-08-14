const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const [expressVersion] = process.argv.slice(2);
if (!expressVersion) {
  console.error('usage: node scripts/test-packed-compatibility.cjs <express-version>');
  process.exit(2);
}

const repoRoot = path.resolve(__dirname, '..');
const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cdn-proxy-cache-compatibility-'));
const expectedPrefix = path.join(os.tmpdir(), 'cdn-proxy-cache-compatibility-');
if (!temporaryRoot.startsWith(expectedPrefix) || path.dirname(temporaryRoot) !== os.tmpdir()) {
  throw new Error(`unexpected temporary directory: ${temporaryRoot}`);
}
const consumerDirectory = path.join(temporaryRoot, 'consumer');
const npmCache = path.join(repoRoot, '.cache', 'npm');

try {
  fs.mkdirSync(consumerDirectory);
  const packOutput = runNpm(['pack', '--json', '--pack-destination', temporaryRoot, '--cache', npmCache], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const packResult = JSON.parse(packOutput);
  const packageArchive = packResult[0]?.filename;
  if (typeof packageArchive !== 'string' || path.basename(packageArchive) !== packageArchive) {
    throw new Error(`unexpected package archive name: ${String(packageArchive)}`);
  }
  const packagePath = path.join(temporaryRoot, packageArchive);
  if (!fs.statSync(packagePath).isFile()) throw new Error(`package archive was not created: ${packagePath}`);

  fs.writeFileSync(path.join(consumerDirectory, 'package.json'), '{"private":true}\n');
  runNpm(
    [
      'install',
      '--silent',
      '--cache',
      npmCache,
      packagePath,
      `express@${expressVersion}`,
      'typescript@5.9.3',
      '@types/node@18',
    ],
    { cwd: consumerDirectory }
  );
  fs.copyFileSync(
    path.join(repoRoot, 'scripts', 'compatibility-consumer.ts'),
    path.join(consumerDirectory, 'compatibility-consumer.ts')
  );
  runNode(
    [
      path.join(consumerDirectory, 'node_modules', 'typescript', 'lib', 'tsc.js'),
      '--strict',
      '--noEmit',
      '--module',
      'Node16',
      '--moduleResolution',
      'Node16',
      '--target',
      'ES2019',
      'compatibility-consumer.ts',
    ],
    { cwd: consumerDirectory }
  );
  runNode([path.join(repoRoot, 'scripts', 'compatibility-smoke.cjs')], { cwd: consumerDirectory });
} finally {
  fs.rmSync(temporaryRoot, { force: true, recursive: true });
}

function runNpm(arguments_, options) {
  return runNode([npmCliPath(), ...arguments_], options);
}

function runNode(arguments_, options = {}) {
  return execFileSync(process.execPath, arguments_, {
    stdio: options.encoding ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    ...options,
  });
}

function npmCliPath() {
  const executableDirectory = path.dirname(process.execPath);
  const candidates = [
    path.join(executableDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(executableDirectory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const npmCli = candidates.find((candidate) => fs.existsSync(candidate));
  if (!npmCli) throw new Error(`could not locate npm CLI for ${process.execPath}`);
  return npmCli;
}
