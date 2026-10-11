/**
 * Minimal server-rendered pages (landing, sign-in errors) in the CR Servers look.
 * Colors, radii and shadows come from the CR Servers design tokens v1.0.0-gate1.
 */

const LOGO = 'https://crservers.com/images/CRServers-logo.png';
const HELP = 'https://crservers.com/es/contacto';

const CSS = `
:root{--strong:#101828;--muted:#707070;--page:#F7F9FC;--card:#FFFFFF;--interface:#006EBF;--c1:#009DD4;--c2:#005C9F;--c1h:#0080ad;--r-control:10px;--r-card:16px;--sh-card:6px 6px 14px 0px #35405226;--sh-btn:1px 4px 4px rgba(0,0,0,.15)}
*{box-sizing:border-box}
body{margin:0;background:var(--page);color:var(--strong);font:400 16px/1.6 Roboto,Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--interface)}
a:focus-visible,.btn:focus-visible{outline:2px solid var(--interface);outline-offset:2px}
.wrap{max-width:520px;margin:0 auto;padding:24px 16px 40px}
.brand{display:flex;justify-content:center;padding:8px 0 20px}.brand img{height:36px;width:auto}
.card{background:var(--card);border-radius:var(--r-card);box-shadow:var(--sh-card);padding:24px}
h1{font-size:1.375rem;line-height:1.3;font-weight:700;margin:0 0 8px}
.muted{color:var(--muted)}.small{font-size:.875rem}
.state{display:flex;align-items:center;justify-content:center;width:48px;height:48px;border-radius:50%;margin-bottom:12px;font-size:24px;font-weight:700;color:#fff;background:var(--muted)}
.state.ok{background:linear-gradient(90deg,var(--c1),var(--c2))}
.btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 20px;border-radius:var(--r-control);font-weight:700;text-decoration:none;color:#fff;border:1px solid var(--c2);background:linear-gradient(90deg,var(--c1),var(--c2));box-shadow:var(--sh-btn)}
.btn:hover{background:linear-gradient(90deg,var(--c1h),var(--c2))}
.foot{text-align:center;margin-top:20px}
`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export function page(opts: { title: string; body: string; state?: 'ok' | 'info' }): string {
  const badge = opts.state ? `<div class="state${opts.state === 'ok' ? ' ok' : ''}" aria-hidden="true">${opts.state === 'ok' ? '✓' : '!'}</div>` : '';
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title>${esc(opts.title)} | CR Servers</title><style>${CSS}</style></head>
<body><main class="wrap"><header class="brand"><img src="${LOGO}" alt="CR Servers" height="36"></header>
<section class="card">${badge}<h1>${esc(opts.title)}</h1>${opts.body}</section>
<footer class="foot muted small">CR Servers · <a href="${HELP}">¿Necesita ayuda?</a></footer></main></body></html>`;
}

export const landingPage = (mcpUrl: string) =>
  page({
    title: 'Conector de IA de CR Servers',
    body: `<p>Permite que su asistente de IA (Claude, ChatGPT) actualice su sitio web en CR Servers, con vista previa antes de publicar y la posibilidad de deshacer cada cambio.</p>
<p class="muted small">Dirección del conector: <code>${esc(mcpUrl)}</code></p>
<p><a class="btn" href="https://github.com/edenia/crservers-connector#readme">Cómo funciona</a></p>`,
  });

export const signInErrorPage = () =>
  page({
    title: 'La solicitud expiró',
    state: 'info',
    body: '<p>Vuelva a su asistente de IA e inicie la conexión de nuevo.</p>',
  });
