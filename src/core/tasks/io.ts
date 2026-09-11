const waitCell = new Int32Array(new SharedArrayBuffer(4));

/** Windows can briefly reject opens while another process closes/deletes a file. */
export function retryTaskIo<T>(run: () => T, deadline = Date.now() + 500): T {
  for (;;) {
    try {
      return run();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        process.platform !== "win32" ||
        !["EPERM", "EACCES", "EBUSY"].includes(code ?? "") ||
        Date.now() >= deadline
      ) {
        throw error;
      }
      Atomics.wait(waitCell, 0, 0, 10);
    }
  }
}
