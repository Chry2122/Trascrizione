import os from "node:os";
import path from "node:path";

// APP_DATA_DIR points to a persistent disk (e.g. a Railway/Render/Fly volume) so jobs survive
// restarts. Without it, files go to the system temp dir: serverless hosts (Vercel) only allow
// writes there (/tmp on Linux).
export const TMP_ROOT = process.env.APP_DATA_DIR?.trim()
  ? path.resolve(process.env.APP_DATA_DIR.trim())
  : path.join(os.tmpdir(), "app-trascrizione");
