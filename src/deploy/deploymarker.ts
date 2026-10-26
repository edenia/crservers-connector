import type { SiteFs } from './sitefs.js';

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
    return { repository, commit: commit.slice(0, 12), ...(ref ? { ref } : {}), ...(deployedAt ? { deployedAt } : {}) };
  } catch {
    return null;
  }
}

/** What the tools tell the AI (and through it, the user) about a GitHub-deployed site. */
export function deployNote(m: DeployMarker): string {
  return `This site is published from GitHub (${m.repository}) with CR Servers Deploy. The next deploy from that repository replaces files changed here, so a change made only here won't last. Let the user know, and suggest making the change in the repository too.`;
}

export function deployedFrom(m: DeployMarker): Record<string, unknown> {
  return { repository: m.repository, commit: m.commit, ...(m.ref ? { ref: m.ref } : {}), ...(m.deployedAt ? { deployed_at: m.deployedAt } : {}) };
}
