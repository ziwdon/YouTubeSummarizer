import type { Context } from "https://edge.netlify.com/";

function unauthorizedResponse(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="Restricted"',
      "Cache-Control": "no-store",
    },
  });
}

export default async (request: Request, context: Context) => {
  const username = Netlify.env.get("BASIC_AUTH_USER");
  const password = Netlify.env.get("BASIC_AUTH_PASS");

  // If env vars are not set, do not block access.
  if (!username || !password) {
    return context.next();
  }

  const authHeader = request.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Basic ")) {
    return unauthorizedResponse();
  }

  // Compute expected credentials
  const expected = `Basic ${btoa(`${username}:${password}`)}`;
  if (authHeader !== expected) {
    return unauthorizedResponse();
  }

  return context.next();
};


