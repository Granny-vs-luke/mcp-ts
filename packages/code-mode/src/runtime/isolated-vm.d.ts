declare module "isolated-vm" {
  export interface IsolateOptions {
    memoryLimit?: number;
  }

  export interface RunOptions {
    timeout?: number;
    promise?: boolean;
    copy?: boolean;
  }

  export class ExternalCopy<T = unknown> {
    constructor(value: T);
    copyInto(): T;
    copy(): T;
  }

  export class Reference<T extends (...args: any[]) => any = (...args: any[]) => any> {
    constructor(value: T);
  }

  export class Isolate {
    constructor(options?: IsolateOptions);
    createContext(): Promise<Context>;
    compileScript(code: string): Promise<Script>;
    dispose(): void;
  }

  export class Context {
    global: {
      set(name: string, value: unknown): Promise<void>;
      derefInto(): unknown;
    };
    eval(code: string, options?: RunOptions): Promise<unknown>;
  }

  export class Script {
    run(context: Context, options?: RunOptions): Promise<unknown>;
  }

  const ivm: {
    Isolate: typeof Isolate;
    ExternalCopy: typeof ExternalCopy;
    Reference: typeof Reference;
  };

  export default ivm;
}
