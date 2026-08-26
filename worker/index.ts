/** Cloudflare Worker entry point for the LoadWise vinext application. */
import handler from "vinext/server/app-router-entry";

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return handler.fetch(request, env, ctx);
  },
};

export default worker;
