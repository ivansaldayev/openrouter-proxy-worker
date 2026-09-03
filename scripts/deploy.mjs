// Deploy with VERSION set to the current commit, on any shell: npm's $(...) does not
// exist in cmd.exe or PowerShell, so the sha is resolved here instead of in the script line.
import { execFileSync } from 'node:child_process';

const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
const args = ['wrangler', 'deploy', '--var', `VERSION:${sha}`, ...process.argv.slice(2)];

console.log(`Deploying ${sha}`);
execFileSync('npx', args, { stdio: 'inherit', shell: process.platform === 'win32' });
