import { handleApi } from "../../server/api";
import { buildContext } from "../../server/app-context";
import { NetlifyBlobStore } from "../../server/netlify-store";

export default async (req: Request) => {
  const { ctx, config } = buildContext(new NetlifyBlobStore(), process.env);
  return handleApi(req, ctx, config);
};

export const config = { path: "/api/*" };
