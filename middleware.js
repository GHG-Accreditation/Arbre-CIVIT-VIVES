// Vercel Routing Middleware: password-protects the whole site (app, data and
// manual) with HTTP Basic Auth. Set APP_USER and APP_PASSWORD in
// Vercel → Project → Settings → Environment Variables, then redeploy.
// Without them the site stays closed, so the data is never left public.

export const config = { matcher: "/:path*" };

export default function middleware(request) {
  const user = process.env.APP_USER;
  const pass = process.env.APP_PASSWORD;
  if (!user || !pass) {
    return new Response(
      "Accés tancat: falta configurar APP_USER i APP_PASSWORD a Vercel.",
      { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }
  const auth = request.headers.get("authorization") || "";
  if (auth.startsWith("Basic ")) {
    let decoded = "";
    try { decoded = new TextDecoder().decode(Uint8Array.from(atob(auth.slice(6)), c => c.charCodeAt(0))); } catch (_) {}
    const i = decoded.indexOf(":");
    if (i >= 0 && decoded.slice(0, i) === user && decoded.slice(i + 1) === pass) return;
  }
  return new Response("Cal usuari i contrasenya per accedir a l'arbre genealògic.", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Arbre Genealogic", charset="UTF-8"',
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
