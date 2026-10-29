// Production deploy: refuses anything but a clean main that matches origin/main,
// then tags the Worker deployment with the commit so `wrangler deployments list`
// shows what is live.
import { $ } from 'bun';

export function deployRefProblems({ branch, dirty, head, remoteHead }) {
  const problems = [];
  if (branch !== 'main') problems.push(`on branch ${branch}, production deploys only from main`);
  if (dirty) problems.push('working tree has uncommitted changes');
  if (head !== remoteHead) problems.push(`HEAD ${head} differs from origin/main ${remoteHead}; push or pull first`);
  return problems;
}

if (import.meta.main) {
  await $`git fetch --quiet origin main`;
  const ref = {
    branch: (await $`git rev-parse --abbrev-ref HEAD`.text()).trim(),
    dirty: (await $`git status --porcelain`.text()).trim() !== '',
    head: (await $`git rev-parse --short HEAD`.text()).trim(),
    remoteHead: (await $`git rev-parse --short origin/main`.text()).trim(),
  };
  const problems = deployRefProblems(ref);
  if (problems.length) {
    console.error(`deploy refused:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    process.exit(1);
  }
  await $`bun run build:unified`;
  await $`bunx wrangler deploy --message ${ref.head}`;
}
