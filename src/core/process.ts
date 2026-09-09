import type { ChildProcessWithoutNullStreams } from "node:child_process";

/** Return only after observing exit, never merely after sending a signal. */
export async function terminateChild(child: ChildProcessWithoutNullStreams, graceMs = 3000, killMs = 3000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    let grace: NodeJS.Timeout | undefined;
    let deadline: NodeJS.Timeout | undefined;
    const finish = (err?: Error) => {
      clearTimeout(grace);
      clearTimeout(deadline);
      child.off("exit", exited);
      child.off("error", failed);
      if (err) reject(err); else resolve();
    };
    const exited = () => finish();
    const failed = (err: Error) => finish(err);
    child.once("exit", exited);
    child.once("error", failed);
    grace = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch (err) { finish(err as Error); return; }
      deadline = setTimeout(() => finish(new Error("provider exit was not observed after SIGKILL; ownership is retained")), killMs);
      deadline.unref();
    }, graceMs);
    grace.unref();
    try { child.stdin.end(); child.kill("SIGTERM"); } catch (err) { finish(err as Error); }
  });
}
