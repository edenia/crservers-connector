import { baseOf, type SiteFs } from './sitefs.js';

/**
 * CR Servers Deploy (repo edenia/crservers-deploy; formerly "Static Deploy" in crservers-static-deploy) uploads this file with every deploy from
 * GitHub. The ".ht" prefix keeps it from ever being served (Apache denies .ht* files), and the AI
 * can't write or delete dot-files, so only the deploy workflow controls it.
 * The marker's `tool` value keeps the old product name ("crservers-static-deploy") on purpose.
 */
export const DEPLOY_MARKER = '.htcrservers-deploy.json';

export interface DeployMarker {
  repository: string;
  commit: string;
  ref?: string;
  deployedAt?: string;
  /** Set when the web root looks like a Next.js static export (e.g. a v0 site): compiled output, not source. */
  build?: 'nextjs-export';
}

const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;

/** The site's CR Servers Deploy marker, or null when there is none (or it doesn't look like ours). */
export async function readDeployMarker(fs: SiteFs): Promise<DeployMarker | null> {
  try {
    const st = await fs.stat(DEPLOY_MARKER);
    if (!st || st.type !== 'file' || st.size > 4096) return null;
    const j = JSON.parse((await fs.read(DEPLOY_MARKER)).toString('utf8')) as Record<string, unknown>;
    const repository = String(j.repository ?? '');
    const commit = String(j.commit ?? '').toLowerCase();
    if (j.tool !== 'crservers-static-deploy' || !REPO_RE.test(repository) || !SHA_RE.test(commit)) return null;
    const ref = typeof j.ref === 'string' && j.ref.length <= 200 ? j.ref : undefined;
    const deployedAt = typeof j.deployed_at === 'string' && !Number.isNaN(Date.parse(j.deployed_at)) ? new Date(j.deployed_at).toISOString() : undefined;
    const build = await detectBuild(fs);
    return { repository, commit: commit.slice(0, 12), ...(ref ? { ref } : {}), ...(deployedAt ? { deployedAt } : {}), ...(build ? { build } : {}) };
  } catch {
    return null;
  }
}

/** Text files that sit next to pages on ordinary sites too, so a matching .html doesn't mean a Next.js export. */
const PLAIN_TXT = new Set(['robots', 'llms', 'llms-full', 'humans', 'security', 'ads', 'app-ads']);

/**
 * One listing of the web root: a `_next/` folder, or a page with its `.txt` page data next to it
 * (`about.html` + `about.txt`), means the files are a Next.js static export. Anything unclear: no guess.
 */
async function detectBuild(fs: SiteFs): Promise<DeployMarker['build']> {
  try {
    const root = await fs.list('');
    if (root.some((e) => e.type === 'dir' && baseOf(e.path) === '_next')) return 'nextjs-export';
    const names = new Set(root.filter((e) => e.type === 'file').map((e) => baseOf(e.path)));
    for (const n of names) {
      const page = /^(.+)\.html$/.exec(n)?.[1];
      if (page && !PLAIN_TXT.has(page.toLowerCase()) && names.has(`${page}.txt`)) return 'nextjs-export';
    }
  } catch {
    // A failed listing only loses the tailored wording.
  }
  return undefined;
}

/** "refs/heads/main" → "main"; other refs (tags, pull requests) aren't a branch to merge into. */
function branchOf(ref: string | undefined): string | undefined {
  return ref?.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) || undefined : undefined;
}

/** What the tools tell the AI (and through it, the user) about a GitHub-deployed site: where the source is and what to do. */
export function deployNote(m: DeployMarker): string {
  const url = `https://github.com/${m.repository}`;
  const branch = branchOf(m.ref);
  const where = [branch ? `branch ${branch}` : m.ref ? `ref ${m.ref}` : '', `commit ${m.commit}`, m.deployedAt ? `deployed ${m.deployedAt}` : ''].filter(Boolean).join(', ');
  const merge = branch ? `Merging the change to ${branch}` : 'Merging the change to the branch that deploys the site';
  const built =
    m.build === 'nextjs-export'
      ? ` It is built from that repository: the files here are a compiled Next.js static export (for example a v0 site), meaning generated pages, hashed _next/ chunks and .txt page data, not the source.`
      : ' The files here come from that repository.';
  const quick =
    m.build === 'nextjs-export'
      ? ' and that it may not show when visitors move between pages inside the site, because in-site navigation loads the .txt page data rather than the .html page'
      : '';
  return (
    `This site is published from GitHub with CR Servers Deploy. Its source is ${url} (${where}).${built} ` +
    `The next deploy from that repository replaces files changed here, so a change made only here won't last. ` +
    `Tell the user, and suggest making the change in the repository instead: with a coding tool (Codex, Claude Code, Cursor, v0, or the GitHub connector in ChatGPT or Claude), or by asking the site's developer. ${merge} publishes it. ` +
    `If the user still wants a quick change here, warn them clearly first that the next deploy will overwrite it${quick}.`
  );
}

export function deployedFrom(m: DeployMarker): Record<string, unknown> {
  return {
    repository: m.repository,
    repository_url: `https://github.com/${m.repository}`,
    commit: m.commit,
    commit_url: `https://github.com/${m.repository}/commit/${m.commit}`,
    ...(m.ref ? { ref: m.ref } : {}),
    ...(branchOf(m.ref) ? { deploy_branch: branchOf(m.ref) } : {}),
    ...(m.deployedAt ? { deployed_at: m.deployedAt } : {}),
    ...(m.build ? { build: m.build } : {}),
    guidance: deployNote(m),
  };
}
