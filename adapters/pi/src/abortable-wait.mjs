// Pi passes the run's AbortSignal as the third argument of a tool's execute(). A long wait that ignores it
// keeps the agent run alive after the user pressed Stop: Pi's abort() awaits idle, idle awaits the tool.
// The underlying Core wait is a poll with its own deadline and no side effects, so it is left to expire;
// only the tool call is released.

export function waitUnlessAborted(waitPromise, signal, abortedResult) {
  if (!signal) return waitPromise;
  if (signal.aborted) {
    waitPromise.catch(() => {});
    return Promise.resolve(abortedResult());
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      waitPromise.catch(() => {});
      resolve(abortedResult());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    waitPromise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}
