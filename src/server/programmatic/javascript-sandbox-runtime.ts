import vm from 'node:vm';
import type {
  SandboxRunInput,
  SandboxRunResult,
  SandboxRuntime,
} from '../../shared/programmatic-tool-runner.js';

export class JavaScriptSandboxRuntime implements SandboxRuntime {
  async run(input: SandboxRunInput): Promise<SandboxRunResult> {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const context = vm.createContext({
      tools: input.tools,
      console: {
        log: (...args: unknown[]) => stdout.push(args.map(String).join(' ')),
        error: (...args: unknown[]) => stderr.push(args.map(String).join(' ')),
      },
    });
    const script = new vm.Script(`(async () => {\n${input.code}\n})()`, {
      filename: 'mcp-run-code.js',
    });

    const execution = script.runInContext(context, {
      timeout: input.timeoutMs,
      displayErrors: true,
    }) as Promise<unknown>;

    const output = await this.withTimeout(execution, input.timeoutMs);

    return {
      output,
      stdout: stdout.length ? stdout.join('\n') : undefined,
      stderr: stderr.length ? stderr.join('\n') : undefined,
    };
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      return await Promise.race([
        promise,
        new Promise<T>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error(`JavaScript sandbox timed out after ${timeoutMs}ms.`)), timeoutMs);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }
}

