import { realpath } from "node:fs/promises";

export async function isSameRealPath(leftPath, rightPath) {
  try {
    return (await realpath(leftPath)) === (await realpath(rightPath));
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

/**
 * Absent argv is a safe non-entrypoint (imports, `node -e`). A present path that
 * cannot be resolved fails loudly instead of skipping `main()`.
 */
export async function isCliEntrypoint(argvPath, modulePath) {
  if (!argvPath) return false;
  const resolvedArgvPath = await realpath(argvPath);
  return isSameRealPath(resolvedArgvPath, modulePath);
}
