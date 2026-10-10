import os from "node:os";
import path from "node:path";

// Serverless hosts (Vercel) only allow writes under the system temp dir (/tmp on Linux).
export const TMP_ROOT = path.join(os.tmpdir(), "app-trascrizione");
