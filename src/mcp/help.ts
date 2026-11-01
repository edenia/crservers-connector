import { isComponentPath, isSecretPath } from '../deploy/paths.js';

/**
 * Links to the public CR Servers help articles (crservers.com knowledge base), returned in tool output so
 * the assistant can point the user to the right article instead of guessing. Output text only: tool
 * descriptions and INSTRUCTIONS stay as reviewed in the ChatGPT and Claude directories.
 * Keep the slugs in sync with crservers.com kb/{es,en}/ (test/help.test.ts lists them).
 */
export type HelpTopic =
  | 'ai_connect'
  | 'connect_assistant'
  | 'manage_connections'
  | 'email_accounts'
  | 'dns_records'
  | 'ssl_https'
  | 'backups'
  | 'deploy_from_github'
  | 'redirects_htaccess'
  | 'file_manager'
  | 'website_errors'
  | 'contact_support';

type Link = { es: string; en: string };

const KB_ES = 'https://crservers.com/es/soporte';
const KB_EN = 'https://crservers.com/support';

export const HELP: Record<HelpTopic, Link> = {
  ai_connect: { es: `${KB_ES}/hospedaje/ai-connect`, en: `${KB_EN}/hosting/ai-connect` },
  connect_assistant: { es: `${KB_ES}/hospedaje/ai-connect-chatgpt-claude`, en: `${KB_EN}/hosting/ai-connect-chatgpt-claude` },
  manage_connections: { es: `${KB_ES}/hospedaje/ai-connect-gestionar`, en: `${KB_EN}/hosting/ai-connect-manage` },
  email_accounts: { es: `${KB_ES}/correo/cuentas-correo`, en: `${KB_EN}/email/email-accounts` },
  dns_records: { es: `${KB_ES}/dominios/administrar-registros-dns`, en: `${KB_EN}/domains/manage-dns-records` },
  ssl_https: { es: `${KB_ES}/hospedaje/ssl-e-ip-dedicada`, en: `${KB_EN}/hosting/ssl-and-dedicated-ip` },
  backups: { es: `${KB_ES}/hospedaje/copia-seguridad-y-restauracion`, en: `${KB_EN}/hosting/backup-and-restore` },
  deploy_from_github: { es: `${KB_ES}/hospedaje/despliegue-desde-github`, en: `${KB_EN}/hosting/deploy-from-github` },
  redirects_htaccess: { es: `${KB_ES}/hospedaje/htaccess`, en: `${KB_EN}/hosting/htaccess` },
  file_manager: { es: `${KB_ES}/hospedaje/administrador-archivos`, en: `${KB_EN}/hosting/file-manager` },
  website_errors: { es: `${KB_ES}/hospedaje/solucionar-errores-sitio-web`, en: `${KB_EN}/hosting/troubleshoot-website-errors` },
  contact_support: { es: 'https://crservers.com/es/contacto', en: 'https://crservers.com/contact' },
};

/** The help block of get_site_info. */
export function helpInfo(): Record<string, unknown> {
  return {
    guidance:
      'CR Servers help articles (Spanish and English). When the user asks how something works, or needs something these tools can\'t do (email, DNS, certificates, backups, redirects, connecting or disconnecting the assistant), give them the matching link in their language instead of guessing. For anything else, contact_support.',
    articles: HELP,
  };
}

/** One topic as `{ es, en }`, for a single tool answer. */
export function help(topic: HelpTopic): Link {
  return HELP[topic];
}

/** Help sentence appended to a refused path, when an article explains the alternative. */
export function pathHelp(path: string): string {
  const base = (path.split('/').pop() ?? '').toLowerCase();
  if (base === '.htaccess') {
    return ` Redirecciones y reglas del servidor: el dueño las cambia en el administrador de archivos del hospedaje (${HELP.redirects_htaccess.es}) o las pide a CR Servers (${HELP.contact_support.es}). / Redirects and server rules: the owner changes them in the hosting file manager (${HELP.redirects_htaccess.en}) or asks CR Servers (${HELP.contact_support.en}).`;
  }
  // The managed contact form and secret files have their own refusal text.
  if (isComponentPath(path) || isSecretPath(path)) return '';
  if (/\.(php\d?|phtml|py|cgi|pl|rb|sh|asp|aspx|jsp)$/.test(base)) {
    return ` El código de servidor llega desde GitHub con CR Servers Deploy (${HELP.deploy_from_github.es}), no desde aquí. / Server code is deployed from GitHub with CR Servers Deploy (${HELP.deploy_from_github.en}), not from here.`;
  }
  return '';
}
