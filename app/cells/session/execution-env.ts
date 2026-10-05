import type { Context } from "@earendil-works/chord";
import {
  err,
  ok,
  FileError,
  ExecutionError,
  LineScanner,
  type ExecutionEnv,
  type FileInfo,
  type FileErrorCode,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type FileWatcher,
} from "@earendil-works/pi-durable/env";
import { Bash } from "just-bash/browser";
import { tryAsync, trySync } from "../../result.ts";

export class JustBashEnv implements ExecutionEnv {
  constructor(
    readonly id: string,
    public cwd = "/workspace",
    readonly bash = new Bash({
      cwd: "/workspace",
      files: { "/workspace/.keep": "" },
      defenseInDepth: false,
      executionLimitProfile: "hardened",
      executionLimits: {
        maxFileSystemBytes: 8 * 1024 * 1024,
        maxLiveBytes: 16 * 1024 * 1024,
        maxOutputSize: 1024 * 1024,
        maxStringLength: 1024 * 1024,
        maxExecutionTimeMs: 10_000,
      },
    }),
    private active = new Set<AbortController>(),
  ) {}

  withCwd(cwd: string) {
    return new JustBashEnv(this.id, cwd, this.bash, this.active);
  }

  private path(path: string) {
    return this.bash.fs.resolvePath(this.cwd, path);
  }

  private async file<T>(
    context: Context,
    work: () => Promise<T> | T,
  ): Promise<Result<T, FileError>> {
    const [value, failure] = await tryAsync(
      (async () => {
        if (context.abortSignal?.aborted) throw new FileError("aborted", "Operation aborted");
        return await work();
      })(),
      (error) => {
        if (error instanceof FileError) return error;
        const message = error instanceof Error ? error.message : String(error);
        const codes: Record<string, FileErrorCode> = {
          ENOENT: "not_found",
          ENOTDIR: "not_directory",
          EISDIR: "is_directory",
          EACCES: "permission_denied",
          EINVAL: "invalid",
        };
        return new FileError(
          Object.entries(codes).find(([code]) => message.includes(code))?.[1] ?? "unknown",
          message,
        );
      },
    );
    return failure !== undefined ? err(failure) : ok(value);
  }

  absolutePath(path: string, c: Context) {
    return this.file(c, () => this.path(path));
  }
  joinPath(parts: string[], c: Context) {
    return this.file(c, () => this.path(parts.join("/")));
  }
  readTextFile(path: string, c: Context) {
    return this.file(c, () => this.bash.fs.readFile(this.path(path)));
  }
  readBinaryFile(path: string, c: Context) {
    return this.file(c, () => this.bash.fs.readFileBuffer(this.path(path)));
  }
  writeFile(path: string, content: string | Uint8Array, c: Context) {
    return this.file(c, () => this.bash.fs.writeFile(this.path(path), content));
  }
  appendFile(path: string, content: string | Uint8Array, c: Context) {
    return this.file(c, () => this.bash.fs.appendFile(this.path(path), content));
  }
  truncateFile(path: string, size: number, c: Context) {
    return this.file(c, async () => {
      if (!Number.isSafeInteger(size) || size < 0 || size > 8 * 1024 * 1024)
        throw new FileError("invalid", "Invalid size (maximum 8 MiB)", path);
      const bytes = await this.bash.fs.readFileBuffer(this.path(path));
      const resized = new Uint8Array(size);
      resized.set(bytes.subarray(0, size));
      await this.bash.fs.writeFile(this.path(path), resized);
    });
  }
  flushFile(path: string, c: Context) {
    return this.file(c, async () => {
      await this.bash.fs.stat(this.path(path));
    });
  }
  renameFile(from: string, to: string, c: Context) {
    return this.file(c, () => this.bash.fs.mv(this.path(from), this.path(to)));
  }
  private async info(path: string): Promise<FileInfo> {
    const absolute = this.path(path);
    const stat = await this.bash.fs.lstat(absolute);
    return {
      path: absolute,
      name: absolute.split("/").at(-1) ?? "",
      size: stat.size,
      kind: stat.isSymbolicLink ? "symlink" : stat.isDirectory ? "directory" : "file",
      mtimeMs: stat.mtime.getTime(),
    };
  }
  fileInfo(path: string, c: Context) {
    return this.file(c, () => this.info(path));
  }
  listDir(path: string, c: Context) {
    return this.file(c, async () =>
      Promise.all(
        (await this.bash.fs.readdir(this.path(path))).map((name) =>
          this.info(this.path(path) + "/" + name),
        ),
      ),
    );
  }
  openDirReader(path: string, c: Context) {
    return this.file(c, async () => {
      const result = await this.listDir(path, c);
      if (!result.ok) throw result.error;
      let offset = 0;
      return {
        next: async (count: number, context: Context) =>
          this.file(context, () => {
            const entries = result.value.slice(offset, offset + count);
            offset += entries.length;
            return { entries, done: offset >= result.value.length };
          }),
        close: async () => {},
      };
    });
  }
  openBinaryReader(path: string, options: { noFollow?: boolean } | undefined, c: Context) {
    return this.file(c, async () => {
      const absolute = this.path(path);
      const link = await this.bash.fs.lstat(absolute);
      if (options?.noFollow && link.isSymbolicLink)
        throw new FileError("invalid", "Symbolic link", path);
      const stat = await this.bash.fs.stat(absolute);
      if (stat.isDirectory) throw new FileError("is_directory", "Cannot read directory", path);
      if (!stat.isFile) throw new FileError("invalid", "Not a regular file", path);
      // ponytail: readers snapshot files; use a handle-aware FS if concurrent writers matter.
      const bytes = await this.bash.fs.readFileBuffer(absolute);
      const info = { ...(await this.info(absolute)), kind: "file" as const, size: bytes.length };
      return {
        info: async (context: Context) => this.file(context, () => info),
        read: async (offset: number, length: number, context: Context) =>
          this.file(context, () => {
            if (
              !Number.isSafeInteger(offset) ||
              offset < 0 ||
              !Number.isSafeInteger(length) ||
              length < 0
            )
              throw new FileError("invalid", "Invalid read range", path);
            return bytes.slice(offset, offset + length);
          }),
        scanLines: async (range: { startLine: number; endLine?: number }, context: Context) =>
          this.file(context, () => {
            const scanner = new LineScanner(range.startLine, range.endLine);
            scanner.push(bytes);
            return scanner.finish();
          }),
        close: async () => {},
      };
    });
  }
  openTextLineReader(path: string, c: Context) {
    return this.file(c, async () => {
      const text = await this.bash.fs.readFile(this.path(path));
      let offset = 0;
      return {
        readLine: async (context: Context) =>
          this.file(context, () => {
            if (offset >= text.length) return undefined;
            const end = text.indexOf("\n", offset);
            const terminated = end !== -1;
            const line = text.slice(offset, terminated ? end : text.length);
            offset = terminated ? end + 1 : text.length;
            return { text: line, terminated };
          }),
        close: async () => {},
      };
    });
  }
  readTextLines(path: string, options: { maxLines?: number } | undefined, c: Context) {
    return this.file(c, async () => {
      const result = await this.openTextLineReader(path, c);
      if (!result.ok) throw result.error;
      const lines: string[] = [];
      while (lines.length < (options?.maxLines ?? Infinity)) {
        const line = await result.value.readLine(c);
        if (!line.ok) throw line.error;
        if (!line.value) break;
        lines.push(line.value.text);
      }
      return lines;
    });
  }
  async watch(): Promise<Result<FileWatcher, FileError>> {
    return err(new FileError("not_supported", "Virtual filesystem watching is not supported"));
  }
  canonicalPath(path: string, c: Context) {
    return this.file(c, () => this.bash.fs.realpath(this.path(path)));
  }
  exists(path: string, c: Context) {
    return this.file(c, () => this.bash.fs.exists(this.path(path)));
  }
  createDir(path: string, options: { recursive?: boolean } | undefined, c: Context) {
    return this.file(c, () => this.bash.fs.mkdir(this.path(path), options));
  }
  remove(path: string, options: { recursive?: boolean; force?: boolean } | undefined, c: Context) {
    return this.file(c, () => this.bash.fs.rm(this.path(path), options));
  }
  createTempDir(prefix: string | undefined, c: Context) {
    return this.file(c, async () => {
      const path = `/tmp/${prefix ?? "pi-"}${crypto.randomUUID()}`;
      await this.bash.fs.mkdir(path);
      return path;
    });
  }
  createTempFile(options: { prefix?: string; suffix?: string } | undefined, c: Context) {
    return this.file(c, async () => {
      const path = `/tmp/${options?.prefix ?? "pi-"}${crypto.randomUUID()}${options?.suffix ?? ""}`;
      await this.bash.fs.writeFile(path, "");
      return path;
    });
  }
  async cleanup() {
    for (const controller of this.active) controller.abort();
  }

  async exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    c: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    const controller = new AbortController();
    this.active.add(controller);
    const timeout =
      options?.timeout === undefined ? undefined : AbortSignal.timeout(options.timeout * 1000);
    const signal = AbortSignal.any([
      controller.signal,
      ...(c.abortSignal ? [c.abortSignal] : []),
      ...(timeout ? [timeout] : []),
    ]);
    const [value, failure] = await tryAsync(
      (async (): Promise<Result<ShellExecResult, ExecutionError>> => {
        if (signal.aborted)
          return err(
            new ExecutionError(timeout?.aborted ? "timeout" : "aborted", "Command stopped"),
          );
        const quote = (word: string) => "'" + word.replaceAll("'", "'\\''") + "'";
        const result = await this.bash.exec(
          typeof command === "string" ? command : command.map(quote).join(" "),
          {
            cwd: options?.cwd ?? this.cwd,
            env: options?.env,
            replaceEnv: options?.inheritEnv === false,
            signal,
            rawScript: true,
          },
        );
        // ponytail: just-bash buffers output; a streaming backend is needed for live output/interleaving.
        const [, outputError] = trySync(
          () => {
            if (result.stdout) options?.onOutput?.(result.stdout, c, { stream: "stdout" });
            if (result.stderr) options?.onOutput?.(result.stderr, c, { stream: "stderr" });
          },
          (error) => new ExecutionError("callback_error", String(error)),
        );
        if (outputError !== undefined) return err(outputError);
        let spillPath: string | undefined;
        const output = result.stdout + result.stderr;
        if (
          options?.spill &&
          (new TextEncoder().encode(output).length > options.spill.afterBytes ||
            (output.match(/\n/g)?.length ?? 0) + (output.endsWith("\n") ? 0 : 1) >
              options.spill.afterLines)
        ) {
          spillPath = `/tmp/pi-output-${crypto.randomUUID()}`;
          await this.bash.fs.writeFile(spillPath, output);
        }
        if (signal.aborted) {
          const error = new ExecutionError(
            timeout?.aborted ? "timeout" : "aborted",
            "Command stopped",
          );
          error.spillPath = spillPath;
          return err(error);
        }
        return ok({ exitCode: result.exitCode, spillPath });
      })(),
      (error) =>
        new ExecutionError(
          signal.aborted ? (timeout?.aborted ? "timeout" : "aborted") : "spawn_error",
          String(error),
        ),
    ).finally(() => this.active.delete(controller));
    return failure !== undefined ? err(failure) : value;
  }
}
