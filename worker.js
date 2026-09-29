export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") {
      return Response.json({ status: "ok", app: "rag-client", stage: 0 });
    }
    return env.ASSETS.fetch(req);
  },
};
